"""The investigation agent: one tool-calling agent (LangChain `create_agent`) over the deterministic tools.

`run()` yields events for the page as they happen:
    start        model and budget
    collection   the screening results the run starts from (the same cards the page shows)
    tool_call / tool_result   every real tool call (the page keeps these in a collapsed log)
    candidate    a space entering the visible set, with its full card
    card         a space's evidence status changed (after a scan check)
    exterior     an aerial observation finished
    ranking      the final top 10 with statuses, short reasons and a ≤ 60-word summary
    fallback / done / error
It is bounded (model and tool call limits, a deadline, model timeouts) and falls back to a deterministic
investigation with the same tools and ledger whenever no model is configured or the agent fails.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Iterator

from . import llm
from .agent_tools import (TOOL_SOURCE, TOOLS, exterior_impl, requirements_impl, review_impl, screen_impl,
                          verify_impl)
from .ledger import POOL, Ledger, close_ledger, open_ledger
from .parse import Program
from .store import get_store

log = logging.getLogger("fit.agent")

MAX_MODEL_CALLS = 14
MAX_TOOL_CALLS = 18
DEADLINE_S = 170
INSPECT_FIRST = 3

SYSTEM_PROMPT = """You are Floorproof's site analyst. The user wants commercial space for lease. Their program (business, city, capacity, budget, preferences) is fixed for this run; the tools read it themselves, so you never pass or change it.

A fixed filter proposes candidates; you decide. The user sees only the spaces you rank, with your reasons, and the ones you reject, with yours. Nothing is added for you.

Evidence tiers:
- Knowledge graph (get_business_requirements): zones the business needs, each legal, functional or advisory.
- CoStar filter (screen_spaces): candidates that pass city, use, size and budget. Proposals only; listed sizes are not measured.
- CoStar evidence (review_candidates): fit-out, past tenants, demand, competition and rent for each candidate.
- Matterport scan (verify_layout): the program tested against measured rooms. Only suites with suite_scan = true can be checked.
- Vexcel aerial (observe_exterior): site record plus a vision reading of the aerial photo. An observation, not a measurement.

Plan:
1. get_business_requirements.
2. screen_spaces (default 12 candidates).
3. review_candidates with all of their space_ids in one call.
4. verify_layout on the three strongest candidates that have suite_scan = true, in parallel. If fewer than three of them have one, screen_spaces with require_suite_scan=true and limit 3, review_candidates on the new ones, then verify. Inspect more only if those leave real doubt.
5. On a conflict: if another measured room could plausibly fix it, retry with pin_rooms or avoid_rooms; otherwise move on. You may test alternative_capacity to show an option; it never replaces the request.
6. For a daycare, observe_exterior on your top pick.
7. submit_shortlist: rank only the spaces you would genuinely put in front of this user, best first, at most 10 (fewer is fine), each reason at most 14 words. Reject every other space you reviewed, each reason at most 10 words (over budget, weak demand, failed scan check, wrong fit-out...). Scan results outrank evidence; a failed scan check never outranks a pass. Recommendation at most 25 words, 1–3 key_reasons of at most 12 words, at most 2 warnings of at most 14 words; 60 words in all. If it is sent back, fix it and resubmit.
8. Then reply with the single word: Done.

Rules: every number comes from a tool result; never invent scores or percentages; call the business what the user called it; be terse."""


def _text(message: Any) -> str:
    t = getattr(message, "text", "")
    if not isinstance(t, str) and callable(t):
        t = t()
    if isinstance(t, str) and t:
        return str(t)
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in ("text", "output_text"))


def _parse(content: Any) -> Any:
    if isinstance(content, list):
        content = "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
    try:
        return json.loads(content)
    except (TypeError, ValueError):
        return {"text": str(content)[:1000]}


def _tool_event(call_id: str, name: str, args: dict[str, Any], mode: str) -> dict[str, Any]:
    return {"type": "tool_call", "id": call_id, "tool": name, "source": TOOL_SOURCE.get(name, "Tool"), "args": args, "mode": mode}


def _result_event(call_id: str, name: str, result: Any, mode: str, ms: int | None = None) -> dict[str, Any]:
    return {"type": "tool_result", "id": call_id, "tool": name, "source": TOOL_SOURCE.get(name, "Tool"), "result": result,
            "mode": mode, "ms": ms}


def build_agent(model: Any = None) -> Any:
    from langchain.agents import create_agent
    from langchain.agents.middleware import ModelCallLimitMiddleware, ToolCallLimitMiddleware

    return create_agent(
        model=model if model is not None else llm.build_chat_model(),
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        middleware=[ModelCallLimitMiddleware(run_limit=MAX_MODEL_CALLS, exit_behavior="end"),
                    ToolCallLimitMiddleware(run_limit=MAX_TOOL_CALLS, exit_behavior="continue")],
    )


def run(query: str, program: Program, model: Any = None, deadline_s: float = DEADLINE_S) -> Iterator[dict[str, Any]]:
    started = time.time()
    spec = llm.model_spec() if model is None else {"provider": "test", "model": type(model).__name__}
    if spec is None:
        yield from fallback(program, "No LLM key is configured, so the deterministic investigation ran instead.", started)
        return
    ledger_id, ledger = open_ledger(get_store(), program)
    yield {"type": "start", "mode": "agent", "model": spec,
           "limits": {"model_calls": MAX_MODEL_CALLS, "tool_calls": MAX_TOOL_CALLS, "seconds": deadline_s}}
    yield ledger.initial()
    prompt = f"Request: {query.strip() or ledger.program_text()}\nFixed program: {ledger.program_text()}"
    done_text, tool_calls, model_calls, reason, notes = None, 0, 0, None, []
    call_started: dict[str, float] = {}
    try:
        from langchain_core.messages import AIMessage, ToolMessage

        agent = build_agent(model)
        stream = agent.stream({"messages": [{"role": "user", "content": prompt}]}, stream_mode="updates",
                              config={"recursion_limit": 12 * MAX_MODEL_CALLS, "configurable": {"ledger_id": ledger_id}})
        for update in stream:
            for data in update.values():
                for m in (data or {}).get("messages", []) if isinstance(data, dict) else []:
                    if isinstance(m, AIMessage):
                        model_calls += 1
                        text = _text(m).strip()
                        if m.tool_calls:
                            if text:
                                notes.append(text)
                                yield {"type": "note", "text": text}
                            for tc in m.tool_calls:
                                tool_calls += 1
                                call_started[tc["id"]] = time.time()
                                yield _tool_event(tc["id"], tc["name"], tc.get("args") or {}, "agent")
                        elif text.startswith(("Model call limits exceeded", "Tool call limits exceeded")):
                            reason = "The agent reached its call budget before finishing."
                        elif text:
                            done_text = text
                    elif isinstance(m, ToolMessage):
                        t0 = call_started.get(m.tool_call_id)
                        yield _result_event(m.tool_call_id, m.name or "", _parse(m.content), "agent",
                                            int((time.time() - t0) * 1000) if t0 else None)
                        yield from ledger.drain()
            if time.time() - started > deadline_s:
                reason = f"The agent hit its {deadline_s:.0f}-second time budget."
                break
    except Exception as e:   # model/network/library failure: never leave the user without an answer
        log.warning("agent failed: %s: %s", type(e).__name__, str(e)[:300])
        reason = f"The agent stopped with an error ({type(e).__name__})."
    finally:
        close_ledger(ledger_id)

    if not reason and (ledger.result or done_text):
        result = ledger.result or ledger.assemble("server rules (the agent did not submit a ranking)")
        yield from ledger.drain()
        yield {"type": "ranking", "mode": "agent", **result}
        yield {"type": "done", "mode": "agent", "stats": {"model_calls": model_calls, "tool_calls": tool_calls,
                                                          "checked": len(result.get("checked", [])),
                                                          "seconds": round(time.time() - started, 1)}}
        return
    yield from fallback(program, reason or "The agent finished without a ranking.", started, ledger=ledger)


def fallback(program: Program, reason: str, started: float | None = None, ledger: Ledger | None = None) -> Iterator[dict[str, Any]]:
    """The same plan with fixed rules: requirements → filter → review every candidate → check the 3 strongest scanned
    suites → rank by evidence tier. Reuses the agent's ledger when the agent got partway, so no check is lost."""
    started = started or time.time()
    fresh = ledger is None
    ledger = ledger or Ledger(get_store(), program)
    yield {"type": "fallback", "reason": reason}
    if fresh:
        yield ledger.initial()
    n = 0

    def call(name: str, fn, args: dict[str, Any]) -> Iterator[dict[str, Any]]:
        nonlocal n
        n += 1
        cid = f"fb{n}"
        yield _tool_event(cid, name, args, "fallback")
        t0 = time.time()
        out = fn()
        yield _result_event(cid, name, out, "fallback", int((time.time() - t0) * 1000))
        yield from ledger.drain()
        holder["out"] = out

    holder: dict[str, Any] = {}
    p = ledger.program
    yield from call("get_business_requirements", lambda: requirements_impl(p), {})
    def review(ids: list[int]) -> Iterator[dict[str, Any]]:
        yield from call("review_candidates", lambda: review_impl(ids, p, ledger), {"space_ids": ids})
        for row in holder["out"]["spaces"]:
            if not row.get("error"):
                ledger.add_evidence(row["space_id"], row)
        yield from ledger.drain()

    yield from call("screen_spaces", lambda: screen_impl(ledger, limit=POOL), {"limit": POOL})
    screened = holder["out"]
    ledger.saw([c["space_id"] for c in screened["candidates"]])
    yield from review([c["space_id"] for c in screened["candidates"] if c["space_id"] not in ledger.reviewed])
    scanned = [c["space_id"] for c in screened["candidates"] if c["suite_scan"]]
    if len(scanned) < INSPECT_FIRST:
        yield from call("screen_spaces", lambda: screen_impl(ledger, require_suite_scan=True, exclude_space_ids=scanned, limit=INSPECT_FIRST),
                        {"require_suite_scan": True, "limit": INSPECT_FIRST})
        more = holder["out"]
        ledger.saw([c["space_id"] for c in more["candidates"]])
        for c in more["candidates"]:
            ledger.ensure_sent(c["space_id"])
        new = [c["space_id"] for c in more["candidates"] if c["space_id"] not in scanned]
        if new:
            yield from review([i for i in new if i not in ledger.reviewed])
        scanned += new
        yield from ledger.drain()
    already = {a["space_id"] for a in ledger.attempts if not a["alternative"]}
    for sid in [s for s in scanned if s not in already][:max(0, INSPECT_FIRST - len(already))]:
        yield from call("verify_layout", lambda sid=sid: verify_impl(sid, p), {"space_id": sid})
        if not holder["out"].get("error"):
            ledger.add_attempt(sid, p.capacity, None, None, holder["out"])
            yield from ledger.drain()
    result = ledger.assemble("deterministic investigation")
    top = result["entries"][0]["space_id"] if result["entries"] else None
    if top is not None and p.business == "daycare":
        yield from call("observe_exterior", lambda: exterior_impl(top, p), {"space_id": top})
        ledger.add_exterior(top, holder["out"])
    yield from ledger.drain()
    yield {"type": "ranking", "mode": "fallback", **result}
    yield {"type": "done", "mode": "fallback", "stats": {"model_calls": 0, "tool_calls": n, "checked": len(result.get("checked", [])),
                                                         "seconds": round(time.time() - started, 1)}}
