"""The agent's tools: thin wrappers over the deterministic functions, bound to one locked program.

The model never passes a business, city, capacity or budget: every tool reads the program from the run's ledger,
so the request can't drift during an investigation. The only way to test a different size is the explicit
`alternative_capacity` of verify_layout, which is recorded as an alternative and never becomes a space's status.
Results are memoised per full program (scans and aerials are also cached on disk).
"""
from __future__ import annotations

import json
import threading
from typing import Any, Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .exterior import observe
from .explain import explain
from .ledger import Ledger, get_ledger
from .match import USE_LABEL, take_sqft
from .parse import Program
from .requirements import business_requirements
from .sizing import compare_markets, size_program
from .store import BUSINESSES, MARKETS, get_store
from .verify import verify_layout as _verify

_memo: dict[str, Any] = {}
_memo_lock = threading.Lock()


def _cached(name: str, program: Program, args: dict[str, Any], fn) -> Any:
    key = name + program.model_dump_json() + json.dumps(args, sort_keys=True, default=str)
    with _memo_lock:
        if key in _memo:
            return _memo[key]
    out = fn()
    with _memo_lock:
        _memo[key] = out
    return out


def _err(msg: str) -> dict[str, Any]:
    return {"error": msg}


# ------------------------------------------------------------------ implementations (plain functions, testable)
def requirements_impl(program: Program) -> dict[str, Any]:
    store = get_store()
    reqs = business_requirements(store, program.business, program.capacity, program.market)
    sizing = size_program(store, program)
    other = next(c for c in compare_markets(store, program) if c["market"] != program.market)
    return {
        "source": reqs["source"],
        "program": {"business": program.display_name(), "capacity": program.capacity, "unit": BUSINESSES[program.business]["unit"],
                    "city": MARKETS[program.market]["name"]},
        "zones": [{k: z[k] for k in ("id", "label", "severity", "count", "min_sqft_each", "min_width_ft", "exterior", "basis")}
                  | {"source": z["source"]["label"]} for z in reqs["zones"]],
        "whole_space": {"legal_minimum_sqft": sizing["legal"]["gross_sqft"], "rule": sizing["legal"]["rule"]["code"],
                        "outdoor_sqft": sizing["outdoor"]["sqft"] if sizing["outdoor"] else None},
        "other_city": {"city": other["market_name"], "legal_minimum_sqft": other["legal_gross_sqft"], "rule": other["rule_code"]},
        "severity_meaning": reqs["note"],
    }


def screen_impl(ledger: Ledger, require_suite_scan: bool = False, exclude_space_ids: list[int] | None = None,
                limit: int = 10) -> dict[str, Any]:
    exclude = {int(x) for x in exclude_space_ids or []}
    rows = [ledger.collection[i] for i in ledger.order if i not in exclude]
    with_scan = [r for r in rows if r["scan_of_suite"]]
    if require_suite_scan:
        rows = with_scan
    rows = rows[:max(1, min(int(limit), 15))]
    return {
        "source": "CoStar listings, screened for the user's program by a fixed filter — proposals, not results; sizes and rents as listed, not measured",
        "program": ledger.program_text(),
        "funnel": [f"{f['n']:,} {f['label']}" for f in ledger.funnel],
        "matches": ledger.total_matches, "with_suite_scan_in_top_40": len(with_scan),
        "candidates": [{
            "space_id": r["space_id"], "screening_rank": r["rank"], "screening_match_pct": r["match_pct"],
            "address": r["address"], "suite": r["suite"], "sqft_to_lease": r["take_sqft"], "use": r["space_use"],
            "rent_psf_yr": ([r["rent"]["low"], r["rent"]["high"]] if r["rent"]["is_range"] else r["rent"]["low"]) if r["rent"]["known"] else "not listed",
            "legal_capacity_on_listed_size": r["max_capacity"], "suite_scan": r["scan_of_suite"],
            "highlights": [c["text"] for c in r["chips"][:4]],
        } for r in rows],
    }


def evidence_impl(space_id: int, program: Program) -> dict[str, Any]:
    store = get_store()
    space = store.space_by_id.get(int(space_id))
    if not space:
        return _err(f"No space with id {space_id}.")
    sizing = size_program(store, program)
    take = take_sqft(space, sizing["recommended"]["low"], sizing["recommended"]["high"])
    why = explain(store, program, space, take)
    return {
        "source": "CoStar data via the knowledge graph (tenancies, companies, apartments, rents)",
        "space": {"space_id": int(space_id), "address": space["address"], "suite": space["suite"], "use": USE_LABEL.get(space["space_use"]),
                  "listed_sqft": space["sqft_max"]},
        "reasons": [{"title": r["title"], "tone": r["tone"], "source": r["source"]["label"], "caveat": r["caveat"]} for r in why["reasons"]],
        "rent_check": why["rent_check"]["verdict"],
    }


TONE = {"good": "+", "bad": "-", "warn": "-", "neutral": "~", "unknown": "?"}


def review_impl(space_ids: list[int], program: Program, ledger: Ledger | None = None) -> dict[str, Any]:
    """Compact evidence for many candidates at once, so the agent can judge every one the filter proposed."""
    out = []
    for sid in [int(x) for x in space_ids][:15]:
        ev = evidence_impl(sid, program)
        if ev.get("error"):
            out.append({"space_id": sid, "error": ev["error"]})
            continue
        card = ledger.card(sid) if ledger else None
        row = {"space_id": sid, "address": ev["space"]["address"], "suite": ev["space"]["suite"], "use": ev["space"]["use"],
               "rent_check": ev["rent_check"],
               "signals": [f"{TONE.get(r['tone'], '~')} {r['title']}" for r in ev["reasons"]]}
        if card:
            row |= {"sqft_to_lease": card["take_sqft"], "suite_scan": card["scan_of_suite"],
                    "rent_psf_yr": ([card["rent"]["low"], card["rent"]["high"]] if card["rent"]["is_range"] else card["rent"]["low"])
                    if card["rent"]["known"] else "not listed",
                    "outside_filters": card.get("outside_filters") or []}
        out.append(row)
    return {
        "source": "CoStar data via the knowledge graph. + supports, - counts against, ~ neutral, ? unknown",
        "caveats": ["Tenant history is building-level, not suite-level.", "Demand counts cover kit buildings only, so real totals are higher.",
                    "Sizes are as listed, not measured; only verify_layout measures."],
        "spaces": out,
    }


def verify_impl(space_id: int, program: Program, pin_rooms: dict[str, str] | None = None,
                avoid_rooms: list[str] | None = None) -> dict[str, Any]:
    store = get_store()
    space = store.space_by_id.get(int(space_id))
    if not space:
        return _err(f"No space with id {space_id}.")
    if space["market"] != program.market:
        return _err(f"Space {space_id} is not in {MARKETS[program.market]['name']}; the user's city can't change.")
    r = _verify(store, program, space, pin_rooms=pin_rooms or None, avoid_rooms=avoid_rooms or None)
    out = {k: r.get(k) for k in ("space_id", "status", "summary", "source", "scan_area_sqft", "rooms_measured", "alternatives_evaluated",
                                 "max_capacity_verified", "configuration_option", "unverified", "caveats", "notes")}
    out["listed_sqft"] = space["sqft_max"]
    out["conflicts"] = [{k: c[k] for k in ("zone", "check", "severity", "required", "measured", "room_id")} for c in r["conflicts"]]
    out["advisories"] = [f"{c['zone']}: needs {c['required']}, measured {c['measured']}" for c in r["advisories"]]
    out["checks_passed"] = sum(1 for c in r["checks"] if c["status"] == "pass")
    out["checks_total"] = len(r["checks"])
    out["build_out"] = [c["zone"] for c in r["checks"] if c["status"] == "buildout"]
    out["assignment"] = [{"zone": a["zone"], "zone_id": a["zone_id"], "room_id": a["room_id"], "sqft": a["room_sqft"], "ok": a["ok"]}
                         for a in r["assignment"]]
    if r.get("model_id") and r["status"] != "unverified":
        from .matterport import get_scan
        from .verify import MIN_ROOM_SQFT, NOT_ROOMS, _name
        scan = get_scan(r["model_id"])
        rooms = sorted([x for x in scan["rooms"] if x.get("area_sqft")], key=lambda x: -x["area_sqft"])[:16]
        used = {a["room_id"]: a["zone"] for a in r["assignment"]}
        out["measured_rooms"] = [{
            "room_id": x["id"], "label": x.get("label"), "sqft": round(x["area_sqft"]), "width_ft": x.get("width_ft"),
            "depth_ft": x.get("depth_ft"), "assigned_to": used.get(x["id"]),
            "usable_for_zones": x["area_sqft"] >= MIN_ROOM_SQFT and not NOT_ROOMS.search(_name(x)),
        } for x in rooms]
        out["model_id"] = r["model_id"]
    return out


def exterior_impl(space_id: int, program: Program) -> dict[str, Any]:
    store = get_store()
    space = store.space_by_id.get(int(space_id))
    if not space:
        return _err(f"No space with id {space_id}.")
    sizing = size_program(store, program)
    return observe(space, program.business, sizing["outdoor"]["sqft"] if sizing["outdoor"] else None)


# ------------------------------------------------------------------ LangChain tools (program from the run, never from the model)
def _ledger(config: RunnableConfig | None) -> Ledger:
    ledger = get_ledger(config)
    if ledger is None:
        raise ValueError("No investigation is running.")
    return ledger


def _dump(obj: Any) -> str:
    return json.dumps(obj, default=str)


@tool
def get_business_requirements(config: RunnableConfig) -> str:
    """What the user's business needs, from the knowledge graph: each zone (dining room, kitchen, restrooms, exam rooms,
    classrooms, outdoor play...) with minimum size and width, severity (legal / functional / advisory) and source, plus
    the whole-space legal minimum and the other city's rule. The program is the user's, fixed for this run. Call first."""
    led = _ledger(config)
    return _dump(_cached("requirements", led.program, {}, lambda: requirements_impl(led.program)))


@tool
def screen_spaces(config: RunnableConfig, require_suite_scan: bool = False, exclude_space_ids: Optional[list[int]] = None,
                  limit: int = 12) -> str:
    """The fixed filter's candidates for the user's program: right city, use, size and budget, in the filter's order.
    These are proposals for you to judge, not results; the user sees only what you rank. Sizes and rents are as listed,
    not measured. require_suite_scan=true returns only candidates whose own suite has a Matterport scan (the only ones
    verify_layout can check); exclude_space_ids skips spaces you've already seen."""
    led = _ledger(config)
    out = screen_impl(led, require_suite_scan, exclude_space_ids, limit)
    led.saw([c["space_id"] for c in out["candidates"]])
    for c in out["candidates"]:
        led.ensure_sent(c["space_id"])
    return _dump(out)


@tool
def review_candidates(space_ids: list[int], config: RunnableConfig) -> str:
    """Review the evidence for up to 15 candidates in one call, from CoStar data and the knowledge graph: capacity under the
    code's space rule, fit-out and past tenants of the same type in the building, demand within half a mile, competitors
    (or unknown), and rent against signed deals. Each signal is marked + supports, - counts against, ~ neutral, ? unknown.
    You must review a space before you rank or reject it."""
    led = _ledger(config)
    out = review_impl(space_ids, led.program, led)
    for row in out["spaces"]:
        if not row.get("error"):
            led.add_evidence(row["space_id"], row)
    return _dump(out)


@tool
def verify_layout(space_id: int, config: RunnableConfig, pin_rooms: Optional[dict[str, str]] = None,
                  avoid_rooms: Optional[list[str]] = None, alternative_capacity: Optional[int] = None) -> str:
    """Check the user's program against the rooms a Matterport scan of this suite measured. Searches room assignments and
    returns status (feasible / feasible_with_caveats / conflict / unverified), each failed check with its measurement,
    build-outs, open items and the capacity the rooms hold. Retry with pin_rooms={zone_id: room_id} or avoid_rooms=[room_id]
    (ids from measured_rooms) to test another assignment; every attempt is kept. alternative_capacity tests a different
    size as an ALTERNATIVE: it is labelled as such and never replaces the user's request."""
    led = _ledger(config)
    alt = int(alternative_capacity) if alternative_capacity and int(alternative_capacity) != led.program.capacity else None
    program = led.program.model_copy(update={"capacity": alt}) if alt else led.program
    args = {"space_id": space_id, "pin_rooms": pin_rooms or {}, "avoid_rooms": sorted(avoid_rooms or [])}
    out = dict(_cached("verify", program, args, lambda: verify_impl(space_id, program, pin_rooms, avoid_rooms)))
    unit = BUSINESSES[led.program.business]["unit"]
    out["configuration"] = (f"ALTERNATIVE: {alt:,} {unit} — not the user's request of {led.program.capacity:,}" if alt
                            else f"the user's request: {led.program.capacity:,} {unit}")
    if not out.get("error"):
        led.add_attempt(space_id, program.capacity, pin_rooms, avoid_rooms, out)
    return _dump(out)


@tool
def observe_exterior(space_id: int, config: RunnableConfig) -> str:
    """Exterior check: the CoStar site record (lot, open lot, parking, frontage, zoning) and a vision-model observation of
    the Vexcel aerial image (open ground beside the building, parking, frontage). An observation, not a measurement.
    Essential for daycares (outdoor play space); optional otherwise."""
    led = _ledger(config)
    out = _cached("exterior", led.program, {"space_id": space_id}, lambda: exterior_impl(space_id, led.program))
    if not out.get("error"):
        led.add_exterior(space_id, out)
    return _dump(out)


class RankedSpace(BaseModel):
    space_id: int = Field(description="A space you reviewed or checked in this run.")
    reason: str = Field(description="Why it sits at this rank, at most 14 words, from your tool results.")


class RejectedSpace(BaseModel):
    space_id: int = Field(description="A space you reviewed or checked and would not put in front of the user.")
    reason: str = Field(description="Why not, at most 10 words, from your tool results.")


@tool
def submit_shortlist(entries: list[RankedSpace], rejected: list[RejectedSpace], recommended_space_id: Optional[int],
                     recommendation: str, key_reasons: list[str], warnings: list[str], config: RunnableConfig) -> str:
    """Submit your decision. entries: the spaces you'd put in front of the user, best first, at most 10 (fewer is fine;
    the server adds nothing). rejected: every other space you reviewed, each with a reason. The server attaches each
    space's status from your own checks. Keep it short: recommendation ≤ 25 words, 1–3 key_reasons ≤ 12 words each,
    ≤ 2 warnings ≤ 14 words each, 60 words in all; entry reasons ≤ 14 words, rejection reasons ≤ 10. Sent back if it
    includes a space you never reviewed, leaves a reviewed space out, puts a failed space above one that passed,
    recommends anything but your first entry, or runs long — then fix and resubmit."""
    led = _ledger(config)
    dump = lambda xs: [x.model_dump() if isinstance(x, BaseModel) else dict(x) for x in xs or []]
    return _dump(led.submit(dump(entries), recommended_space_id, recommendation, key_reasons, warnings, dump(rejected), source="agent"))


TOOLS = [get_business_requirements, screen_spaces, review_candidates, verify_layout, observe_exterior, submit_shortlist]

# How the trace labels each tool: which evidence tier it is.
TOOL_SOURCE = {"get_business_requirements": "Knowledge graph", "screen_spaces": "CoStar filter",
               "review_candidates": "CoStar evidence", "verify_layout": "Matterport scan",
               "observe_exterior": "Vexcel aerial", "submit_shortlist": "Decision"}
