"""Layout checker, knowledge-graph requirements, agent tools and agent fallback.

No network: scans are synthetic (injected), and the agent loop is driven by a scripted chat model.
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from api import agent as agent_mod
from api import matterport
from api.agent_tools import requirements_impl, screen_impl, verify_impl
from api.ledger import Ledger
from api.parse import Program
from api.requirements import business_requirements
from api.store import get_store
from api.verify import verify_layout

CAFE = Program(business="cafe", capacity=40, market="houston")


@pytest.fixture(scope="module")
def store():
    return get_store()


def room(rid: str, w: float | None, d: float | None, label: str | None = None, area: float | None = None) -> dict[str, Any]:
    return {"id": rid, "label": label, "tags": [], "floor_id": "f1", "area_sqft": area if area is not None else w * d,
            "width_ft": w, "depth_ft": d, "height_ft": 10.0, "walls": [[0, 0, 1, 0]], "outline": None, "center": [0, 0],
            "locations": [], "measured_by": "scan dimensions"}


def scan(*rooms: dict[str, Any], area: float | None = None) -> dict[str, Any]:
    total = area if area is not None else sum(r["area_sqft"] for r in rooms)
    return {"model_id": "TESTMODEL01", "name": "test", "area_sqft": total, "floors": [], "rooms": list(rooms),
            "rooms_measured": len(rooms), "rooms_unmeasured": 0}


def suite(sqft: float = 1300, **kw: Any) -> dict[str, Any]:
    return {"space_id": 1, "tour_model_id": "TESTMODEL01", "tour_level": "suite", "tour_caption": "Suite 1", "sqft_max": sqft, **kw}


def check(store, s: dict[str, Any], sc: dict[str, Any] | None, program: Program = CAFE, **kw: Any) -> dict[str, Any]:
    return verify_layout(store, program, s, fetch_scan=lambda _id: sc, **kw)


# ---------------------------------------------------------------- knowledge graph requirements
def test_requirements_come_from_the_graph_and_follow_state_law(store):
    tx = business_requirements(store, "daycare", 40, "houston")
    ca = business_requirements(store, "daycare", 40, "los_angeles")
    tx_rooms = next(z for z in tx["zones"] if z["id"] == "classrooms")
    ca_rooms = next(z for z in ca["zones"] if z["id"] == "classrooms")
    assert (tx_rooms["min_sqft_each"], ca_rooms["min_sqft_each"]) == (1200, 1400)        # 30 vs 35 sq ft per child
    assert tx_rooms["severity"] == "legal" and "SIZED_BY" in tx_rooms["graph_path"]
    assert tx_rooms["graph_path"][-1] == "state:TX" and ca_rooms["graph_path"][-1] == "state:CA"
    outdoor = next(z for z in tx["zones"] if z["id"] == "outdoor")
    assert outdoor["exterior"] and outdoor["min_sqft_each"] == 3200


def test_restaurant_kitchen_scales_with_the_dining_room(store):
    zones = {z["id"]: z for z in business_requirements(store, "restaurant", 60, "los_angeles")["zones"]}
    assert zones["seating"]["min_sqft_each"] == 900
    assert zones["kitchen"]["min_sqft_each"] == 315 and zones["kitchen"]["severity"] == "functional"
    assert zones["restroom"]["count"] == 2 and zones["restroom"]["width_severity"] == "legal"


# ---------------------------------------------------------------- layout checker: success
def test_layout_that_fits_is_feasible(store):
    sc = scan(room("dining", 26, 30), room("kitchen", 10, 15), room("wc", 7, 8), room("counter", 7, 10))
    r = check(store, suite(1300), sc)
    assert r["status"] == "feasible", r["conflicts"]
    assert r["max_capacity_verified"] == 52                      # 780 sq ft ÷ 15
    zones = {a["zone_id"]: a["room_id"] for a in r["assignment"]}
    assert zones["seating"] == "dining" and zones["kitchen"] == "kitchen" and zones["restroom"] == "wc"
    assert r["alternatives_evaluated"] > 1


def test_open_plan_suite_needs_build_out_not_a_conflict(store):
    r = check(store, suite(1300), scan(room("open", 30, 40)))     # one 1,200 sq ft room
    assert r["status"] == "feasible_with_caveats"
    built = [c for c in r["checks"] if c["status"] == "buildout"]
    assert {c["zone"] for c in built} >= {"Prep & dish area", "Accessible restroom"}
    assert any("Build-out needed" in c for c in r["caveats"])


# ---------------------------------------------------------------- layout checker: failures
def test_too_little_floor_for_seats_and_kitchen_is_a_conflict_with_an_option(store):
    sc = scan(room("dining", 18, 25), room("kitchen", 10, 15), room("wc", 7, 8))   # 600 sq ft of large rooms in all
    r = check(store, suite(700), sc)
    assert r["status"] == "conflict"
    # the legal zone (40 seats = 600 sq ft) gets the floor first, so the planning-rule kitchen is what can't fit
    assert any(c["zone"] == "Prep & dish area" and c["severity"] == "functional" for c in r["conflicts"])
    assert r["max_capacity_verified"] == 34                     # (600 − 90 sq ft kitchen) ÷ 15
    option = r["configuration_option"]
    assert option["capacity"] == 34 and "approve" in option["note"] and "prep & dish area" in option["note"]


def test_dining_room_too_small_on_its_own_is_a_legal_conflict(store):
    sc = scan(room("dining", 15, 20), room("kitchen", 10, 12), room("wc", 7, 8))   # 300 + 120 sq ft → 28 seats at most
    r = check(store, suite(500), sc)
    cap = next(c for c in r["conflicts"] if c["check"] == "capacity")
    assert cap["severity"] == "legal"
    assert r["max_capacity_verified"] < 40 and r["configuration_option"]["capacity"] == r["max_capacity_verified"]


def test_narrow_restroom_is_rejected_and_rebuilt_from_spare_floor(store):
    sc = scan(room("dining", 26, 30), room("kitchen", 10, 15), room("wc", 4, 14))   # 780 sq ft dining, 180 spare
    r = check(store, suite(1300), sc)
    assert r["status"] == "feasible_with_caveats"
    assert any(c["zone"] == "Accessible restroom" and c["status"] == "buildout" for c in r["checks"])
    assert any("Accessible restroom" in n and "4.0 ft" in n for n in r["notes"])      # the narrow room is explained


def test_narrow_restroom_with_no_spare_floor_is_a_conflict(store):
    sc = scan(room("dining", 25, 24), room("kitchen", 8, 12), room("wc", 4, 14))    # 600 sq ft dining, 96 sq ft prep: no spare
    r = check(store, suite(900), sc)
    assert r["status"] == "conflict"
    wc = next(c for c in r["conflicts"] if c["zone"] == "Accessible restroom")
    # the only restroom-sized room is too narrow, and there is no spare floor to build one: the conflict says why
    assert wc["severity"] == "functional" and "4.0 ft" in wc["measured"] and "≥ 5 ft room width" in wc["measured"]


def test_irregular_room_width_is_unverified_not_passed(store):
    # an L-shaped prep room: 20 × 12 ft overall but only 150 sq ft of floor
    sc = scan(room("dining", 26, 30), room("kitchen", 12, 20, area=150), room("wc", 7, 8))
    r = check(store, suite(1300), sc)
    width = next(c for c in r["checks"] if c["zone"] == "Prep & dish area" and c["check"] == "width")
    assert width["status"] == "unverified" and "irregular" in width["measured"]
    assert r["status"] == "feasible_with_caveats"


def test_pinning_a_room_is_honoured_even_when_it_makes_things_worse(store):
    sc = scan(room("dining", 26, 30), room("kitchen", 10, 15), room("wc", 7, 8))
    r = check(store, suite(1300), sc, pin_rooms={"kitchen": "dining"})
    assert next(a for a in r["assignment"] if a["zone_id"] == "kitchen")["room_id"] == "dining"
    assert r["status"] == "conflict"                              # the dining room was given away


def test_requirements_are_never_relaxed(store):
    sc = scan(room("dining", 18, 25), room("kitchen", 10, 15), room("wc", 7, 8))
    r = check(store, suite(700), sc)
    assert r["requirements"]["capacity"] == 40                    # still the user's 40 seats
    assert r["status"] == "conflict"


# ---------------------------------------------------------------- layout checker: missing data
def test_no_tour_is_unverified(store):
    r = check(store, {"space_id": 2, "tour_model_id": None, "tour_level": None, "sqft_max": 1000}, None)
    assert r["status"] == "unverified" and r["unverified"]


def test_building_tour_is_not_used_for_a_suite(store):
    r = check(store, suite(tour_level="building"), scan(room("x", 30, 40)))
    assert r["status"] == "unverified" and "another part of the building" in r["unverified"][0]


def test_matterport_error_is_unverified(store):
    def boom(_id):
        raise matterport.MatterportError("HTTP 503")
    r = verify_layout(store, CAFE, suite(), fetch_scan=boom)
    assert r["status"] == "unverified" and "HTTP 503" in r["unverified"][0]


def test_unmeasured_width_is_unverified_not_passed(store):
    sc = scan(room("dining", 26, 30), room("kitchen", None, None, area=150), room("wc", 7, 8))
    r = check(store, suite(1300), sc)
    kitchen_width = next(c for c in r["checks"] if c["zone"] == "Prep & dish area" and c["check"] == "width")
    assert kitchen_width["status"] == "unverified"
    assert r["status"] == "feasible_with_caveats"


def test_daycare_outdoor_space_is_flagged_as_unverifiable_indoors(store):
    sc = scan(room("a", 30, 25), room("b", 30, 25), room("k", 10, 10), *[room(f"w{i}", 6, 8) for i in range(3)], room("o", 9, 10))
    r = check(store, suite(2200), sc, program=Program(business="daycare", capacity=40, market="houston"))
    assert any("Outdoor play area" in u and "interior scan cannot verify" in u for u in r["unverified"])


def test_outline_area_is_computed_for_rooms_without_dimensions():
    pts = [[0, 0], [10, 0], [10, 8], [0, 8]]
    assert matterport._polygon_area(pts) == 80
    w, d = matterport._min_rect([[0, 0], [7.07, 7.07], [2.83, 11.31], [-4.24, 4.24]])    # a 10 × 6 rectangle at 45°
    assert sorted((round(w), round(d))) == [6, 10]


# ---------------------------------------------------------------- tools
def test_screening_is_labelled_as_screening(store):
    led = Ledger(store, Program(business="cafe", capacity=40, market="houston", budget_psf_yr=30))
    out = screen_impl(led, limit=3)
    assert "not measured" in out["source"] and len(out["candidates"]) == 3
    assert all("suite_scan" in c and "screening_match_pct" in c for c in out["candidates"])


def test_review_tool_covers_many_candidates_and_marks_them_reviewed(store):
    from api.agent_tools import review_candidates
    from api.ledger import close_ledger, open_ledger
    lid, led = open_ledger(store, CAFE)
    try:
        ids = led.order[:12]
        out = json.loads(review_candidates.invoke({"space_ids": ids}, config={"configurable": {"ledger_id": lid}}))
        assert len(out["spaces"]) == 12 and all(s["signals"] and "rent_check" in s for s in out["spaces"])
        assert led.reviewed == set(ids) and all(led.status_of(i)["status"] == "reviewed" for i in ids)
        assert sum(1 for e in led.drain() if e["type"] == "card" and e["status"] == "reviewed") == 12
    finally:
        close_ledger(lid)


def test_verify_tool_on_unscanned_space_reports_unverified(store):
    space = next(s for s in store.spaces if s["market"] == "houston" and not s["tour_model_id"])
    out = verify_impl(space["space_id"], CAFE)
    assert out["status"] == "unverified" and out["unverified"]


def test_requirements_tool_reports_both_cities(store):
    out = requirements_impl(Program(business="daycare", capacity=40, market="houston"))
    assert out["whole_space"]["legal_minimum_sqft"] == 2000 and out["other_city"]["legal_minimum_sqft"] == 2333


# ---------------------------------------------------------------- agent: fallback, bounds, real loop
def events(**kw: Any) -> list[dict[str, Any]]:
    return list(agent_mod.run("Coffee shop, 40 seats, Houston", CAFE, **kw))


def test_fallback_runs_when_no_model_is_configured(monkeypatch):
    monkeypatch.setattr(agent_mod.llm, "model_spec", lambda: None)
    ev = events()
    assert ev[0]["type"] == "fallback" and ev[1]["type"] == "collection"
    calls = [e for e in ev if e["type"] == "tool_call"]
    results = {e["id"]: e for e in ev if e["type"] == "tool_result"}
    assert calls and all(c["id"] in results for c in calls)       # every call has its result
    assert {c["tool"] for c in calls} >= {"get_business_requirements", "screen_spaces", "review_candidates"}
    ranking = next(e for e in ev if e["type"] == "ranking")
    assert ranking["mode"] == "fallback" and 1 <= len(ranking["entries"]) <= 10
    assert all(e["status"] != "screened_only" for e in ranking["entries"])      # every ranked space was reviewed
    assert len(ranking["entries"]) + len(ranking["rejected"]) == ranking["reviewed"]
    assert ranking["summary"]["recommendation"] and len(ranking["summary"]["key_reasons"]) <= 3
    assert ev[-1]["type"] == "done"


class ScriptedModel(BaseChatModel):
    """Replays a fixed list of AI messages; with `forever`, keeps calling a tool."""
    script: list = []
    calls: int = 0
    forever: bool = False
    fail: bool = False

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        if self.fail:
            raise RuntimeError("model down")
        i = self.calls
        self.calls += 1
        if self.forever:
            msg = AIMessage(content="", tool_calls=[{"name": "get_business_requirements", "id": f"c{i}", "args": {}}])
        else:
            msg = self.script[min(i, len(self.script) - 1)]
        return ChatResult(generations=[ChatGeneration(message=msg)])


def test_agent_loop_streams_real_tool_calls_and_card_updates(store):
    unscanned = next(s for s in store.spaces if s["market"] == "houston" and not s["tour_model_id"])
    model = ScriptedModel(script=[
        AIMessage(content="Reading requirements first.", tool_calls=[{"name": "get_business_requirements", "id": "a1", "args": {}}]),
        AIMessage(content="", tool_calls=[{"name": "verify_layout", "id": "a2", "args": {"space_id": unscanned["space_id"]}}]),
        AIMessage(content="Done."),
    ])
    ev = events(model=model)
    assert ev[0]["type"] == "start" and ev[1]["type"] == "collection" and len(ev[1]["cards"]) == 12
    results = [e for e in ev if e["type"] == "tool_result"]
    assert [r["tool"] for r in results] == ["get_business_requirements", "verify_layout"]
    assert results[1]["result"]["status"] == "unverified" and results[1]["source"] == "Matterport scan"
    card = next(e for e in ev if e["type"] == "card")
    assert card["space_id"] == unscanned["space_id"] and card["status"] == "not_verifiable"
    ranking = next(e for e in ev if e["type"] == "ranking")
    assert ranking["source"].startswith("server rules")
    assert [e["space_id"] for e in ranking["entries"]] == [unscanned["space_id"]]   # only what was judged; nothing padded


def test_agent_is_bounded_and_falls_back(monkeypatch):
    monkeypatch.setattr(agent_mod, "MAX_MODEL_CALLS", 4)
    monkeypatch.setattr(agent_mod, "MAX_TOOL_CALLS", 3)
    ev = events(model=ScriptedModel(forever=True))
    assert len([e for e in ev if e["type"] == "tool_call" and e["mode"] == "agent"]) <= 4
    assert any(e["type"] == "fallback" for e in ev)
    assert next(e for e in ev if e["type"] == "ranking")["mode"] == "fallback"


def test_agent_error_falls_back():
    ev = events(model=ScriptedModel(fail=True))
    assert "error" in next(e for e in ev if e["type"] == "fallback")["reason"]
    assert next(e for e in ev if e["type"] == "ranking")["mode"] == "fallback"


def test_agent_deadline_falls_back(store):
    ev = list(agent_mod.run("cafe", CAFE, model=ScriptedModel(forever=True), deadline_s=0))
    assert any(e["type"] == "fallback" and "time budget" in e["reason"] for e in ev)


def test_sse_endpoint_streams_events(monkeypatch):
    from fastapi.testclient import TestClient
    from api.main import app
    monkeypatch.setattr(agent_mod.llm, "model_spec", lambda: None)
    with TestClient(app) as client:
        res = client.post("/api/agent", json={"text": "Coffee shop, 40 seats, Houston"})
        assert res.status_code == 200 and res.headers["content-type"].startswith("text/event-stream")
        evs = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]
    assert evs[0]["type"] == "fallback" and evs[-1]["type"] == "done"
