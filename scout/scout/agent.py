"""Scout's agents, orchestrated with LangChain DeepAgents.

    orchestrator  reads the request, finds the places, writes the brief, (commercial) scans areas, searches,
                  widens explicitly when too little matches, and picks the top 10
    deep-dive     a subagent launched three times in parallel, one per top-3 pick: gathers the listing's
                  context and reports highlights and watch-outs

`run_search()` yields events for the page: start, step, brief, zones, search, top, deep, fallback, done, error.
Bounded by model/tool call limits and a deadline. When no model is configured, or the agent stops early, the same
steps run with fixed rules for whatever is missing, and the page says which parts came from fixed rules.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Iterator

from api import llm
from . import insights, search
from .brief import Brief, classify_mode, parse_request
from .geo import CITIES, city_key
from .run import DEEP_N, TOP_N, Run, close_run, open_run
from .tools import DEEP_TOOLS, LABELS, ORCHESTRATOR_TOOLS

log = logging.getLogger("scout.agent")

MAX_MODEL_CALLS = 16
MAX_TOOL_CALLS = 28
DEEP_MODEL_CALLS = 5
DEADLINE_S = 180

ORCHESTRATOR_PROMPT = """You are Scout, an autonomous property-search agent for Houston and Los Angeles. You do the search yourself and deliver results; you don't chat. The user sees only your brief, your 10 picks and the deep dives, never your reasoning.

Plan:
0. Decide what the user wants from their words: a home to live in (mode "home": apartments for rent) or a space for a business (mode "commercial": spaces for lease). If the message gives a mode, use it. Your first set_brief must carry that mode.
1. If the request names places to be near (a school, the airport, downtown, a university, a neighbourhood...), check each with find_places.
2. market_snapshot (with the mode), then set_brief. Fill every field you can. Decide sensible values for what the user didn't say: a budget from typical rents, a size from what similar businesses occupy, a radius of 2-5 miles for each place. Keep the user's own words for the business. Use only what the user asked for as musts.
3. Commercial: scan_areas to see where customers are and competitors are fewest.
4. search_listings. You may search again with another sort, or with the best zone_ids. If fewer than 10 match, widen ONE thing with set_brief (a radius, the budget, the size or the ZIPs) and search again; at most two widenings. Never drop a must the user stated.
5. submit_top10: exactly 10 ids from your searches (fewer only if fewer exist), best first by your judgment of the whole brief (places, price, space, demand and competition for a business). Give real choice: at most two listings from the same building unless there is nothing else.
6. In one message, launch three deep-dive tasks, one per pick #1-#3: description "Listing <id>, pick #<n>. Brief: <the brief in one line>".
7. Reply with the single word: Done."""

DEEP_PROMPT = """You investigate one listing for the user's brief and report facts. Call listing_context once, and nearby only if the brief names something specific to check. Then call submit_deep_dive with up to 3 highlights and up to 2 watch-outs, each at most 12 words, every number taken from the tool results. Facts only: no advice, no recommendation, and don't restate the brief or its limits (say "0.2 mi to downtown", not "within the 3-mile limit"). Highlights are what makes this listing good for the brief. Watch-outs are real drawbacks for this user (price near the budget, distance, parking, pets, competition, rent not listed, a missing must); if there are none, leave watch_outs empty. Then reply: Done."""

_profiles_registered = False


def _register_profiles() -> None:
    """Hide DeepAgents' built-in file tools and general-purpose subagent: this agent only needs its own tools."""
    global _profiles_registered
    if _profiles_registered:
        return
    from deepagents import GeneralPurposeSubagentProfile, HarnessProfile, register_harness_profile
    prof = HarnessProfile(excluded_tools=frozenset({"ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute"}),
                          general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False))
    for provider in ("openai", "anthropic", "scripted"):
        register_harness_profile(provider, prof)
    _profiles_registered = True


def build_agent(model: Any = None) -> Any:
    from deepagents import create_deep_agent
    from langchain.agents.middleware import ModelCallLimitMiddleware, ToolCallLimitMiddleware
    _register_profiles()
    model = model if model is not None else llm.build_chat_model()
    deep_dive = {"name": "deep-dive",
                 "description": "Investigates ONE top-3 listing and reports up to 3 highlights and 2 watch-outs. "
                                "Give it the listing id, its pick number and the brief in one line.",
                 "system_prompt": DEEP_PROMPT, "tools": DEEP_TOOLS, "model": model,
                 "middleware": [ModelCallLimitMiddleware(run_limit=DEEP_MODEL_CALLS, exit_behavior="end")]}
    return create_deep_agent(model=model, tools=ORCHESTRATOR_TOOLS, system_prompt=ORCHESTRATOR_PROMPT, subagents=[deep_dive],
                             middleware=[ModelCallLimitMiddleware(run_limit=MAX_MODEL_CALLS, exit_behavior="end"),
                                         ToolCallLimitMiddleware(run_limit=MAX_TOOL_CALLS, exit_behavior="continue")],
                             name="scout")


# ------------------------------------------------------------------ steps for the progress line
STEP_OF = {"find_places": "brief", "market_snapshot": "brief", "set_brief": "brief", "scan_areas": "areas",
           "search_listings": "search", "submit_top10": "top", "task": "deep", "listing_context": "deep",
           "nearby": "deep", "submit_deep_dive": "deep"}


def _step(key: str, state: str, label: str | None = None, detail: str | None = None) -> dict[str, Any]:
    return {"type": "step", "key": key, "state": state, "label": label, "detail": detail}


def run_search(mode: str | None, query: str, brief: Brief | None = None, model: Any = None, deadline_s: float = DEADLINE_S,
               city_hint: str | None = None) -> Iterator[dict[str, Any]]:
    started = time.time()
    city = (brief.city if brief else None) or city_key(query) or city_hint or "houston"
    run = open_run(mode, query, brief, city)
    spec = llm.model_spec() if model is None else {"provider": "test", "model": type(model).__name__}
    try:
        if run.mode:
            run.emit({"type": "mode", "mode": run.mode})
        if brief is not None:
            run.emit({"type": "brief", "brief": brief.model_dump(), "chips": brief.chips(), "adjustments": brief.adjustments})
        if spec is None:
            yield {"type": "start", "mode": run.mode, "agent": None}
            yield from run.drain()
            yield from _fill(run, "No AI model is configured, so fixed rules ran the search.", started)
            return
        yield {"type": "start", "mode": run.mode, "agent": "deepagents", "model": spec, "subagents": ["deep-dive"],
               "limits": {"model_calls": MAX_MODEL_CALLS, "tool_calls": MAX_TOOL_CALLS, "seconds": deadline_s}}
        yield from run.drain()
        stats = {"model_calls": 0, "tool_calls": 0, "subagent_runs": 0}
        reason = None
        try:
            from langchain_core.messages import AIMessage, ToolMessage
            agent = build_agent(model)
            given = f"Mode: {run.mode} (the user chose it)." if run.mode else "Mode: decide it from the request."
            prompt = f"{given} City hint: {CITIES[city]['name']}.\nRequest: {query.strip() or '(none)'}"
            if brief is not None:
                prompt += (f"\nThe user edited the brief; keep their fields ({', '.join(brief.locked) or 'none'}) and start from it: "
                           f"{run.brief_text()}. You may skip step 2 unless something must change.")
            stream = agent.stream({"messages": [{"role": "user", "content": prompt}]}, stream_mode="updates", subgraphs=True,
                                  config={"recursion_limit": 250, "configurable": {"run_id": run.id}})
            open_steps: dict[str, int] = {}
            for chunk in stream:
                ns, update = chunk if isinstance(chunk, tuple) and len(chunk) == 2 else ((), chunk)
                for data in (update or {}).values():
                    msgs = data.get("messages", []) if isinstance(data, dict) else []
                    for m in msgs:
                        if isinstance(m, AIMessage):
                            stats["model_calls"] += 1
                            for tc in m.tool_calls or []:
                                stats["tool_calls"] += 1
                                key = STEP_OF.get(tc["name"])
                                if tc["name"] == "task":
                                    stats["subagent_runs"] += 1
                                if key and not ns:
                                    open_steps[key] = open_steps.get(key, 0) + 1
                                    yield _step(key, "live", LABELS.get(tc["name"]))
                        elif isinstance(m, ToolMessage) and not ns:
                            key = STEP_OF.get(m.name or "")
                            if key:
                                open_steps[key] = max(0, open_steps.get(key, 1) - 1)
                                if open_steps[key] == 0 and key != "deep":
                                    yield _step(key, "done")
                    yield from run.drain()
                if time.time() - started > deadline_s:
                    reason = f"The agent hit its {deadline_s:.0f}-second budget."
                    break
        except Exception as e:     # model, network or library failure: finish with fixed rules, never a blank page
            log.warning("agent failed: %s: %s", type(e).__name__, str(e)[:300])
            reason = explain_failure(e)
        yield from run.drain()
        missing = _missing(run)
        if missing:
            yield from _fill(run, reason or f"The agent finished without {missing}.", started, stats)
            return
        yield _step("deep", "done")
        yield {"type": "done", "mode": run.mode, "by": "agent", "stats": {**stats, "seconds": round(time.time() - started, 1)}}
    finally:
        close_run(run.id)


def explain_failure(e: Exception) -> str:
    """A plain sentence for the page about why the AI stopped."""
    text = f"{type(e).__name__} {e}".lower()
    if "no credits" in text or "insufficient_quota" in text or "billing" in text:
        return "The AI model's account has run out of credits, so fixed rules ran the search."
    if "401" in text or "invalid_api_key" in text or "authentication" in text:
        return "The AI model key was rejected, so fixed rules ran the search."
    if "429" in text or "rate limit" in text or "ratelimit" in text:
        return "The AI model is rate-limited right now, so fixed rules finished the search."
    if "timeout" in text or "timed out" in text or "connection" in text:
        return "The AI model didn't answer in time, so fixed rules finished the search."
    return f"The agent stopped with an error ({type(e).__name__}), so fixed rules finished the search."


def _missing(run: Run) -> str | None:
    if not run.brief:
        return "a brief"
    if not run.top:
        return "a top 10"
    done = [i for i in run.top[:DEEP_N] if run.deep.get(i, {}).get("highlights") is not None]
    if len(done) < min(DEEP_N, len(run.top)):
        return "all three deep dives"
    return None


# ------------------------------------------------------------------ fixed rules for whatever the agent didn't finish
def _fill(run: Run, reason: str, started: float, stats: dict | None = None) -> Iterator[dict[str, Any]]:
    yield {"type": "fallback", "reason": reason, "parts": [p for p, ok in (("brief", not run.brief), ("top", not run.top),
                                                                             ("deep", True)) if ok]}
    if run.mode is None:                   # nobody decided: read it from the request
        run.mode = classify_mode(run.query)
        run.emit({"type": "mode", "mode": run.mode})
        yield from run.drain()
    if not run.brief:
        yield _step("brief", "live", "Writing your brief")
        parsed = parse_request(run.query, run.mode, run.query_city)
        pl = parsed.pop("anchors", [])
        res = run.set_brief({k: v for k, v in parsed.items() if k != "mode"}, pl, by="fallback")
        if not res.get("accepted"):
            run.set_brief({"city": run.query_city}, [], by="fallback")
        yield from run.drain()
        yield _step("brief", "done")
    if not run.top:
        if run.mode == "commercial" and not run.zones:
            yield _step("areas", "live", "Finding the best areas")
            run.set_zones(search.scan_areas(run.brief))
            yield from run.drain()
            yield _step("areas", "done")
        yield _step("search", "live", "Searching listings")
        res = _search(run)
        widen = 0
        while res["total"] < TOP_N and widen < 2 and (run.brief.anchors or run.brief.budget_max):
            widen += 1
            b = run.brief
            fields: dict[str, Any] = {}
            if b.budget_max and "budget_max" not in run.locked:
                fields["budget_max"] = int(round(b.budget_max * 1.2, -1))
            pl = [{"place": a.query, "radius_mi": round(a.radius_mi * 1.6, 1)} for a in b.anchors] if b.anchors and "anchors" not in run.locked else None
            if not fields and pl is None:
                break
            run.set_brief(fields, pl, by="fallback")      # recorded as an adjustment, shown to the user
            res = _search(run)
        yield from run.drain()
        yield _step("search", "done")
        yield _step("top", "live", "Picking your top 10")
        run.submit_top(spread([c for c in run.candidates.values()], res["cards"]), by="fallback")
        yield from run.drain()
        yield _step("top", "done")
    yield _step("deep", "live", "Deep dive")
    for lid in run.top[:DEEP_N]:
        if run.deep.get(lid, {}).get("highlights") is not None:
            continue
        ctx = insights.home_context(lid, run.brief) if run.mode == "home" else insights.space_context(lid, run.brief)
        hi, wo = fixed_highlights(ctx, run)
        run.add_deep(lid, ctx, hi, wo, by="fallback")
        yield from run.drain()
    yield _step("deep", "done")
    yield {"type": "done", "mode": run.mode, "by": "fallback", "stats": {**(stats or {}), "seconds": round(time.time() - started, 1)}}


def spread(pool: list[dict], ordered: list[dict], per_building: int = 2) -> list[int]:
    """Fixed-rule picks in search order, at most two per building so the options differ."""
    seen: dict[int, int] = {}
    out: list[int] = []
    for c in ordered + [c for c in pool if c not in ordered]:
        b = c.get("property_id")
        if seen.get(b, 0) >= per_building or c["id"] in out:
            continue
        seen[b] = seen.get(b, 0) + 1
        out.append(c["id"])
        if len(out) == TOP_N:
            return out
    for c in ordered:                       # not enough distinct buildings: fill with what exists
        if c["id"] not in out and len(out) < TOP_N:
            out.append(c["id"])
    return out[:min(TOP_N, len(pool))]


def _search(run: Run) -> dict[str, Any]:
    if run.mode == "home":
        res = search.search_homes(run.brief, "closest", 30)
    else:
        res = search.search_spaces(run.brief, "closest", 30)
    run.add_candidates(res["cards"], res["total"])
    return res


def fixed_highlights(ctx: dict, run: Run) -> tuple[list[str], list[str]]:
    hi, wo = [], []
    if ctx.get("mode") == "commercial":
        w = ctx["who_visits"]
        hi.append(f"{w['residents']['units']:,} apartment units within ½ mile")
        if w["office_workers"]["count"]:
            hi.append(f"{w['office_workers']['count']:,} office workers within ½ mile")
        fr = ctx["fair_rent"]
        if fr.get("vs_pct") is not None and fr["vs_pct"] <= 0:
            hi.append(f"Asking rent {abs(fr['vs_pct'])}% below signed-deal median")
        elif fr.get("vs_pct") is not None:
            wo.append(f"Asking rent {fr['vs_pct']}% above signed-deal median")
        c = ctx["competitors"]["counts"]
        if c["quarter_mi"] is None:
            wo.append("Competitor count unknown: map data missing")
        elif c["quarter_mi"]:
            wo.append(f"{c['quarter_mi']} competing {ctx['competitors']['kind']}s within ¼ mile")
        if ctx["fair_rent"].get("rate_yr") is None:
            wo.append("Rent not listed")
    else:
        for label, a in (ctx.get("anchors") or {}).items():
            if a.get("miles") is not None:
                hi.append(f"{a['miles']} mi to {a['nearest']}")
        fits = [p for p in ctx.get("plans") or [] if p.get("fits")]
        if fits:
            p = min(fits, key=lambda p: p["rentMin"])
            hi.append(f"From ${p['rentMin']:,}/mo · {p['beds']} bd / {p['baths']} ba · {p['available']} available")
        c = ctx.get("counts") or {}
        if c.get("schools_1mi"):
            hi.append(f"{c['schools_1mi']} schools within 1 mile")
        if c.get("parks_1mi"):
            hi.append(f"{c['parks_1mi']} parks within 1 mile")
        if not ctx.get("parking"):
            wo.append("No parking listed")
    return hi[:3], wo[:2]
