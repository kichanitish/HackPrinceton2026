"""One shared collection, a locked program, retained attempts and an evidence-aware top 10.

Covers: requirement drift, inconsistent agent rankings, candidates outside the initial results, missing evidence,
unsuccessful verification, verbose output, and that the run starts from the same cards the page shows.
"""
from __future__ import annotations

import pytest

from api import agent_tools
from api.agent_tools import screen_spaces, verify_impl, verify_layout
from api.ledger import POOL, TOP_N, Ledger, close_ledger, open_ledger
from api.match import search
from api.parse import Program
from api.sizing import size_program
from api.store import get_store

PROGRAM = Program(business="cafe", capacity=40, market="houston", budget_psf_yr=30)


@pytest.fixture(scope="module")
def store():
    return get_store()


def fake_verify(sid: int, status: str, conflict: bool = False, max_cap: int | None = None) -> dict:
    return {"space_id": sid, "status": status, "summary": f"{status}.", "checks_passed": 9, "checks_total": 10,
            "conflicts": [{"zone": "Prep & dish area", "check": "width", "severity": "functional", "required": "≥ 6 ft room width",
                           "measured": "4.0 ft"}] if conflict else [],
            "caveats": [], "unverified": [], "max_capacity_verified": max_cap}


def led_with(store, statuses: dict[int, str]) -> Ledger:
    """A ledger whose agent reviewed the filter's top 6 and checked the given positions (1-based) on scans."""
    led = Ledger(store, PROGRAM)
    led.saw(led.order[:12])
    for sid in led.order[:6]:
        led.add_evidence(sid, {"space_id": sid})
    for pos, st in statuses.items():
        sid = led.order[pos - 1]
        led.add_attempt(sid, PROGRAM.capacity, None, None, fake_verify(sid, st, conflict=st == "conflict"))
    return led


def rest(led: Ledger, ranked: list[int]) -> list[dict]:
    """Reject every other reviewed space, as the agent must."""
    return [{"space_id": i, "reason": "Weaker evidence."} for i in sorted(led.judged() - set(ranked))]


SUMMARY = dict(recommendation="Take the verified suite.", key_reasons=["Passes every space check.", "Kitchen already built."],
               warnings=["Rent not listed."])


# ---------------------------------------------------------------- one shared collection
def test_run_starts_from_the_same_cards_the_page_shows(store):
    page = search(store, PROGRAM, size_program(store, PROGRAM), limit=40)["results"]
    led = Ledger(store, PROGRAM)
    assert led.order == [c["space_id"] for c in page]
    first = led.initial()
    assert [c["space_id"] for c in first["cards"]] == [c["space_id"] for c in page[:POOL]]
    assert all(c["match_pct"] == int(c["score"] + 0.5) for c in first["cards"])


def test_candidate_outside_the_initial_results_arrives_with_full_data(store):
    led = Ledger(store, PROGRAM)
    outsider = next(s for s in store.spaces if s["market"] == "houston" and s["space_id"] not in led.collection)
    led.add_attempt(outsider["space_id"], PROGRAM.capacity, None, None, fake_verify(outsider["space_id"], "unverified"))
    ev = led.drain()
    cand = next(e for e in ev if e["type"] == "candidate")["card"]
    assert cand["space_id"] == outsider["space_id"] and cand["discovered"]
    assert {"address", "match_pct", "rent", "chips", "lat", "outside_filters"} <= set(cand)
    assert any(e["type"] == "card" and e["status"] == "not_verifiable" for e in ev)


# ---------------------------------------------------------------- requirement drift
def test_tools_cannot_change_the_program():
    for t in (screen_spaces, verify_layout):
        props = set(t.tool_call_schema.model_json_schema()["properties"])
        assert not props & {"business", "capacity", "city", "budget_psf_yr", "budget_monthly"}, t.name


def test_alternative_capacity_is_labelled_and_never_becomes_the_status(store):
    lid, led = open_ledger(store, PROGRAM)
    try:
        sid = led.order[0]
        cfg = {"configurable": {"ledger_id": lid}}
        original = agent_tools.verify_impl
        agent_tools.verify_impl = lambda space_id, program, *a, **k: fake_verify(
            space_id, "conflict" if program.capacity == 40 else "feasible", conflict=program.capacity == 40)
        agent_tools._memo.clear()
        verify_layout.invoke({"space_id": sid}, config=cfg)
        out = verify_layout.invoke({"space_id": sid, "alternative_capacity": 30}, config=cfg)
        assert "ALTERNATIVE: 30" in out
        st = led.status_of(sid)
        assert st["status"] == "conflict" and "Alternative, not your request" in st["option"]
        assert led.program.capacity == 40 and len(led.attempts) == 2 and led.attempts[1]["alternative"]
    finally:
        agent_tools.verify_impl = original
        agent_tools._memo.clear()
        close_ledger(lid)


def test_city_cannot_change_through_a_space_in_the_other_market(store):
    la_space = next(s for s in store.spaces if s["market"] == "los_angeles")
    assert "can't change" in verify_impl(la_space["space_id"], PROGRAM)["error"]


def test_budget_survives_the_whole_run(store):
    led = Ledger(store, PROGRAM)
    assert all(not c["rent"]["over_budget"] for c in led.collection.values())
    assert led.program.budget_psf_yr == 30


# ---------------------------------------------------------------- attempts are kept, best evidence wins
def test_every_attempt_is_kept_and_the_best_one_counts(store):
    led = Ledger(store, PROGRAM)
    sid = led.order[0]
    led.add_attempt(sid, 40, None, None, fake_verify(sid, "conflict", conflict=True))
    led.add_attempt(sid, 40, {"kitchen": "r2"}, None, fake_verify(sid, "feasible_with_caveats"))
    assert len(led.attempts) == 2 and led.attempts[0]["program"]["budget_psf_yr"] == 30
    assert led.status_of(sid)["status"] == "verified_with_caveats" and led.status_of(sid)["attempts"] == 2


def test_failed_verification_is_not_a_pass_and_not_a_conflict(store):
    led = Ledger(store, PROGRAM)
    sid = led.order[0]
    led.add_attempt(sid, 40, None, None, fake_verify(sid, "unverified"))
    assert led.status_of(sid)["status"] == "not_verifiable"


# ---------------------------------------------------------------- inconsistent rankings are sent back
def test_conflict_cannot_outrank_a_space_that_passed(store):
    led = led_with(store, {1: "conflict", 2: "feasible"})
    picks = led.order[:2]
    out = led.submit([{"space_id": picks[0], "reason": "Cheapest rent."}, {"space_id": picks[1], "reason": "Passes."}],
                     picks[0], rejected=rest(led, picks), **SUMMARY)
    assert not out["accepted"] and any("fails a space check" in p for p in out["problems"])


def test_recommendation_must_be_first(store):
    led = led_with(store, {1: "feasible", 2: "feasible"})
    picks = led.order[:2]
    out = led.submit([{"space_id": picks[0], "reason": "a"}, {"space_id": picks[1], "reason": "b"}], picks[1],
                     rejected=rest(led, picks), **SUMMARY)
    assert not out["accepted"]


def test_unreviewed_space_cannot_be_ranked(store):
    led = led_with(store, {})
    outsider = led.order[20]                                                     # never handed over or reviewed
    out = led.submit([{"space_id": outsider, "reason": "Looks great."}], outsider, rejected=rest(led, []), **SUMMARY)
    assert not out["accepted"] and any("haven't reviewed" in p for p in out["problems"])


def test_filter_pass_alone_is_not_enough_to_rank(store):
    led = led_with(store, {})
    proposed_only = led.order[8]                                                 # the filter proposed it; the agent never reviewed it
    assert proposed_only in led.seen_by_agent and proposed_only not in led.judged()
    out = led.submit([{"space_id": proposed_only, "reason": "High match."}], proposed_only, rejected=rest(led, []), **SUMMARY)
    assert not out["accepted"] and any("haven't reviewed" in p for p in out["problems"])


def test_every_reviewed_space_must_be_ranked_or_rejected(store):
    led = led_with(store, {1: "feasible"})
    out = led.submit([{"space_id": led.order[0], "reason": "Passes."}], led.order[0], **SUMMARY)
    assert not out["accepted"] and any("Rank or reject every space" in p for p in out["problems"])


def test_wordy_output_is_sent_back(store):
    led = led_with(store, {1: "feasible"})
    pick, rej = led.order[0], rest(led, [led.order[0]])
    long = " ".join(["word"] * 20)
    assert not led.submit([{"space_id": pick, "reason": long}], pick, rejected=rej, **SUMMARY)["accepted"]
    out = led.submit([{"space_id": pick, "reason": "Passes."}], pick, recommendation="Take it.",
                     key_reasons=[" ".join(["w"] * 12)] * 3, warnings=[" ".join(["w"] * 14)] * 2, rejected=rej)
    assert not out["accepted"] and any("summary is" in p for p in out["problems"])
    wordy_rej = [{"space_id": r["space_id"], "reason": long} for r in rej]
    out = led.submit([{"space_id": pick, "reason": "Passes."}], pick, rejected=wordy_rej, **SUMMARY)
    assert not out["accepted"] and any("rejection reason" in p for p in out["problems"])


# ---------------------------------------------------------------- only the agent's picks, nothing padded
def test_nothing_is_added_beyond_the_agents_picks(store):
    led = led_with(store, {1: "conflict", 4: "feasible", 6: "unverified"})
    pick = led.order[3]
    out = led.submit([{"space_id": pick, "reason": "Passes every check."}], pick, rejected=rest(led, [pick]), **SUMMARY)
    assert out["accepted"] and [e["space_id"] for e in out["entries"]] == [pick]
    assert all(e["ranked_by"] == "agent" for e in out["entries"] + out["rejected"])
    assert {e["space_id"] for e in out["rejected"]} == led.judged() - {pick}
    assert out["entries"][0]["status"] == "verified" and "match_pct" in out["entries"][0]
    assert out["reviewed"] == 6 and out["summary"]["recommendation"] == SUMMARY["recommendation"]


def test_agent_may_reject_everything(store):
    led = led_with(store, {})
    out = led.submit([], None, recommendation="None of these suit a café.", key_reasons=[], warnings=[], rejected=rest(led, []))
    assert out["accepted"] and out["entries"] == [] and len(out["rejected"]) == 6


def test_fallback_rejects_a_failed_scan_instead_of_ranking_it(store):
    led = led_with(store, {1: "conflict"})                                       # the filter's #1 fails its scan check
    out = led.assemble("deterministic investigation")
    assert led.order[0] not in [e["space_id"] for e in out["entries"]]
    rej = next(e for e in out["rejected"] if e["space_id"] == led.order[0])
    assert rej["status"] == "conflict" and "Prep" in rej["reason"]
    assert all(e["status"] != "screened_only" for e in out["entries"])         # only judged spaces are ranked

def test_assembled_summary_stays_short(store):
    from api.ledger import LIMITS, words
    out = led_with(store, {2: "feasible_with_caveats"}).assemble("deterministic investigation")
    s = out["summary"]
    assert words(s["recommendation"]) + sum(map(words, s["key_reasons"])) + sum(map(words, s["warnings"])) <= LIMITS["summary"]


# ---------------------------------------------------------------- missing evidence
def test_missing_tenant_data_is_unknown_competition_not_no_competitors(store):
    from api.explain import explain
    space = next(s for s in store.spaces if s["market"] == "houston" and not s["in_kit"])
    why = explain(store, PROGRAM, space, space["sqft_max"])
    comp = next(r for r in why["reasons"] if r["id"] == "competition")
    assert comp["title"] == "Competition unknown"
    led = Ledger(store, PROGRAM)
    card = led.card(space["space_id"])
    assert not any(c["kind"] == "competition" for c in card["chips"])


def test_unlisted_rent_with_a_budget_is_flagged_not_assumed(store):
    led = Ledger(store, PROGRAM)
    unpriced = [c for c in led.collection.values() if not c["rent"]["known"]]
    assert unpriced and all(c["rent"]["budget_checked"] is False for c in unpriced)
    assert all(any("not listed" in ch["text"] for ch in c["chips"]) or len(c["chips"]) == 5 for c in unpriced)
