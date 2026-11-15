"""Tests for the deterministic core: parsing, sizing, layout, matching, explanations.

Run from the repo root after the pipeline has been built:  python -m pytest -q
"""
from __future__ import annotations

import pytest

from api.explain import explain
from api.layout import assign_to_rooms, build_layout
from api.match import search, take_sqft
from api.matterport import _chain
from api.parse import Program, parse_rules
from api.sizing import compare_markets, max_capacity, size_program
from api.store import get_store


@pytest.fixture(scope="module")
def store():
    return get_store()


# ---------------------------------------------------------------- parsing
@pytest.mark.parametrize("text, expected", [
    ("Coffee shop, 40 seats, Houston, under $30/sq ft",
     {"business": "cafe", "capacity": 40, "market": "houston", "budget_psf_yr": 30.0}),
    ("Daycare for 40 kids in LA", {"business": "daycare", "capacity": 40, "market": "los_angeles"}),
    ("Dental clinic with 4 exam rooms in Los Angeles", {"business": "clinic", "capacity": 12, "market": "los_angeles"}),
    ("Yoga studio for 25 people in LA under $4/sq ft a month",
     {"business": "gym", "capacity": 25, "market": "los_angeles", "budget_psf_yr": 48.0}),
    ("gym 60 members houston $6,000 a month", {"business": "gym", "capacity": 60, "budget_monthly": 6000.0}),
    ("restaurant with 20 tables in Houston TX", {"business": "restaurant", "capacity": 80, "market": "houston"}),
    ("bakery 1,200 sq ft in LA", {"business": "cafe", "target_sqft": 1200, "market": "los_angeles"}),
])
def test_parse(text, expected):
    program = parse_rules(text).program
    for field, value in expected.items():
        assert getattr(program, field) == value, field


def test_budget_is_never_read_as_capacity():
    result = parse_rules("coffee shop in Houston under $30/sq ft")
    assert result.program.capacity == 30 and any("capacity" in a for a in result.assumed)  # the default, flagged
    assert result.program.budget_psf_yr == 30.0


def test_unknown_request_is_flagged_not_guessed_silently():
    result = parse_rules("I want to open something")
    assert len(result.assumed) == 3 and not result.understood


# ---------------------------------------------------------------- sizing
def test_cafe_sizing_matches_the_brief(store):
    s = size_program(store, Program(business="cafe", capacity=40, market="houston"))
    assert s["legal"]["net_sqft"] == 600                      # 40 × 15 (IBC Table 1004.5)
    assert s["legal"]["gross_sqft"] == 923                    # 600 ÷ 0.65
    assert s["legal"]["rule"]["source_url"].startswith("https://")
    assert s["recommended"]["low"] >= s["legal"]["gross_sqft"]
    assert s["recommended"]["high"] > s["recommended"]["low"]


def test_daycare_differs_by_state(store):
    program = Program(business="daycare", capacity=40, market="houston")
    houston, la = compare_markets(store, program)
    assert (houston["sqft_per_person"], la["sqft_per_person"]) == (30, 35)
    assert (houston["capacity_in_1500_net"], la["capacity_in_1500_net"]) == (50, 42)   # the demo hook
    assert (houston["outdoor_sqft"], la["outdoor_sqft"]) == (3200, 3000)


def test_daycare_uses_the_law_when_the_kit_has_too_few(store):
    s = size_program(store, Program(business="daycare", capacity=40, market="houston"))
    assert not s["market"]["enough"]
    assert s["recommended"]["low"] == s["legal"]["gross_sqft"] == 2000


def test_every_rule_has_a_source(store):
    assert all(r["source_url"].startswith("https://") for r in store.rules)


@pytest.mark.parametrize("business", ["cafe", "restaurant", "gym", "clinic", "daycare"])
def test_legal_minimum_supports_exactly_the_requested_capacity(store, business):
    for market, state in (("houston", "TX"), ("los_angeles", "CA")):
        program = Program(business=business, capacity=37, market=market)
        gross = size_program(store, program)["legal"]["gross_sqft"]
        assert max_capacity(store, business, state, gross + 1) >= 37
        assert max_capacity(store, business, state, gross * 0.9) < 37


# ---------------------------------------------------------------- layout
@pytest.mark.parametrize("business, capacity", [("cafe", 40), ("restaurant", 80), ("gym", 30), ("clinic", 12), ("daycare", 40)])
def test_layout_fills_the_space_exactly(store, business, capacity):
    program = Program(business=business, capacity=capacity, market="houston")
    total = size_program(store, program)["legal"]["gross_sqft"] * 1.4
    layout = build_layout(store, program, {"open_lot_sqft": None}, total)
    assert abs(sum(z["sqft"] for z in layout["zones"]) - total) <= len(layout["zones"])       # rounding only
    width, depth = layout["shape"]["width_ft"], layout["shape"]["depth_ft"]
    for z in layout["zones"]:
        assert z["x"] >= -0.01 and z["y"] >= -0.01
        assert z["x"] + z["w"] <= width + 0.2 and z["y"] + z["h"] <= depth + 0.2
    assert layout["capacity"]["fits"] and layout["capacity"]["supported"] >= capacity
    assert layout["shape"]["approximate"]


def test_layout_seats_equal_the_legal_calculation(store):
    program = Program(business="cafe", capacity=40, market="houston")
    layout = build_layout(store, program, {}, 1500)
    assert layout["capacity"]["supported"] == max_capacity(store, "cafe", "TX", 1500) == 65
    seating = sum(z["sqft"] for z in layout["zones"] if z["id"] in ("seating", "extra"))
    assert abs(seating - 1500 * 0.65) <= 2


def test_zones_are_assigned_to_distinct_rooms(store):
    layout = build_layout(store, Program(business="cafe", capacity=40, market="houston"), {}, 1400)
    rooms = [{"id": f"r{i}", "label": label, "tags": [], "area_sqft": area}
             for i, (label, area) in enumerate([("", 820), ("Kitchen", 210), ("Bathroom", 55), ("", 160), ("Hallway", 90)])]
    out = assign_to_rooms(layout["zones"], rooms)["assignments"]
    assert len({a["room_id"] for a in out}) == len(out)
    by_zone = {a["zone_id"]: a["room_id"] for a in out}
    assert by_zone["seating"] == "r0" and by_zone["kitchen"] == "r1" and by_zone["restrooms"] == "r2"


def test_chain_closes_a_loop_and_ignores_stub_walls():
    square = [((0, 0), (10, 0)), ((10, 0), (10, 8)), ((10, 8), (0, 8)), ((0, 8), (0, 0))]
    assert len(_chain(square)) == 4
    assert len(_chain(square + [((10, 0), (12, 0))])) == 4          # dead-end stub trimmed
    assert _chain(square[:2]) is None


# ---------------------------------------------------------------- matching + explanations
def test_search_respects_market_size_and_budget(store):
    program = Program(business="cafe", capacity=40, market="houston", budget_psf_yr=30)
    sizing = size_program(store, program)
    found = search(store, program, sizing)
    assert found["results"], "the demo query must return spaces"
    counts = [f["n"] for f in found["funnel"]]
    assert counts == sorted(counts, reverse=True)
    for r in found["results"]:
        space = store.space_by_id[r["space_id"]]
        assert space["market"] == "houston"
        assert space["sqft_max"] >= sizing["legal"]["gross_sqft"]
        assert r["rent"]["low"] is None or r["rent"]["low"] <= 30
        assert r["max_capacity"] >= 40
        assert 0 <= r["score"] <= 100
    scores = [r["score"] for r in found["results"]]
    assert scores == sorted(scores, reverse=True)
    per_building = {}
    for r in found["results"]:
        per_building[r["property_id"]] = per_building.get(r["property_id"], 0) + 1
    assert max(per_building.values()) <= 2


def test_rent_is_never_shown_as_zero(store):
    assert all(s["rate_low_yr"] is None or s["rate_low_yr"] > 0 for s in store.spaces)


def test_every_reason_carries_a_path_and_a_source(store):
    program = Program(business="restaurant", capacity=80, market="los_angeles")
    sizing = size_program(store, program)
    top = store.space_by_id[search(store, program, sizing)["results"][0]["space_id"]]
    why = explain(store, program, top, take_sqft(top, sizing["recommended"]["low"], sizing["recommended"]["high"]))
    assert why["reasons"][0]["id"] == "legal"
    for reason in why["reasons"]:
        assert reason["path"] and reason["source"]["label"]
    node_ids = {n["id"] for n in why["graph"]["nodes"]}
    assert all(e["source"] in node_ids and e["target"] in node_ids for e in why["graph"]["edges"])
