"""Scout: brief, places, search, the run's rules (agent picks all ten, no padding, top-3 deep dives, locked user
fields, visible adjustments), the comparison, the fixed-rules path, and the real DeepAgents graph with a scripted model."""
from __future__ import annotations

import json
import re
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from scout import compare, places, search
from scout.agent import run_search
from scout.brief import Brief, classify_mode, parse_request, resolve_anchor
from scout.data import get_data
from scout.run import Run

HAS_PLACES = bool(places.city_places("houston").rows)
needs_places = pytest.mark.skipif(not HAS_PLACES, reason="OpenStreetMap snapshot not downloaded")


@pytest.fixture(scope="module")
def data():
    return get_data()


def home_brief(**kw) -> Brief:
    return Brief(**{"mode": "home", "city": "houston", "beds": 2, "budget_max": 2500, "parking": True, **kw})


def shop_brief(**kw) -> Brief:
    return Brief(**{"mode": "commercial", "city": "houston", "business": "cafe", "business_label": "coffee shop",
                    "sqft_min": 800, "sqft_max": 2500, "space_uses": ["Retail", "OfficeRetail"], **kw})


# ---------------------------------------------------------------- reading the request
def test_parse_home_request():
    p = parse_request("2-bed with parking that allows dogs, under $2,500, within 3 miles of an elementary school in Houston", "home")
    assert p["city"] == "houston" and p["beds"] == 2 and p["budget_max"] == 2500 and p["pets"] == "dog" and p["parking"]
    assert {"place": "an elementary school", "radius_mi": 3.0} in p["anchors"] or any("elementary" in a["place"] for a in p["anchors"])


@pytest.mark.parametrize("text,beds", [("Studio close to Rice University under $1,600", 0), ("two-bedroom in LA", 2),
                                       ("3 br house with a yard", 3), ("5 bedrooms for a big family", 3)])
def test_parse_bedroom_words(text, beds):
    assert parse_request(text, "home")["beds"] == beds


def test_parse_commercial_request_keeps_the_users_words():
    p = parse_request("bakery in Los Angeles around 1,500 sq ft, under 5k a month", "commercial")
    assert p["city"] == "los_angeles" and p["business"] == "bakery" and p["business_label"] == "bakery"
    assert p["budget_max"] == 5000 and p["sqft_min"] < 1500 < p["sqft_max"]


# ---------------------------------------------------------------- places
@needs_places
def test_places_resolve_kinds_codes_and_downtown():
    assert places.resolve("downtown", "houston")["kind"] == "points"
    iah = places.resolve("IAH", "houston")
    assert iah["kind"] == "points" and iah["points"][0]["iata"] == "IAH"
    school = places.resolve("an elementary school", "houston")
    assert school["kind"] == "category" and school["count"] > 50


@needs_places
def test_unknown_place_is_never_invented():
    assert places.resolve("Zzyzxqua Plaza", "houston")["kind"] == "none"
    assert "error" in resolve_anchor("houston", "Zzyzxqua Plaza", 3)


# ---------------------------------------------------------------- search
def test_home_search_respects_every_filter(data):
    b = home_brief(pets="dog")
    res = search.search_homes(b, limit=60)
    assert res["total"] > 10
    for c in res["cards"]:
        h = data.home_by_id[c["id"]]
        assert c["plan"]["beds"] == 2 and c["plan"]["rentMin"] <= 2500 and c["parking"] and "Dog" in c["pets"]
        assert h["city_key"] == "houston"


@needs_places
def test_home_search_enforces_the_place_radius():
    b = home_brief(anchors=[resolve_anchor("houston", "downtown", 2).model_dump()])
    res = search.search_homes(b, limit=60)
    assert res["total"] < res["before_places"]
    assert all(c["distances"]["Downtown Houston"]["miles"] <= 2 for c in res["cards"])


def test_commercial_search_respects_use_budget_and_floor():
    b = shop_brief(budget_max=4000, ground_floor=True)
    res = search.search_spaces(b, limit=60)
    assert res["total"] > 0
    for c in res["cards"]:
        assert c["space_use"] in ("Retail", "OfficeRetail") and c["ground"]
        assert c["monthly"] is None or c["monthly"] <= 4000 + 10


# ---------------------------------------------------------------- the run's rules
def run_with_candidates(n: int = 30) -> Run:
    r = Run("home", "test")
    r.set_brief({"city": "houston", "beds": 2, "budget_max": 2500, "parking": True}, [])
    res = search.search_homes(r.brief, limit=n)
    r.add_candidates(res["cards"], res["total"])
    return r


def test_agent_must_pick_exactly_ten_from_its_own_searches():
    r = run_with_candidates()
    ids = list(r.candidates)
    assert not r.submit_top(ids[:7])["accepted"]                                   # too few, and nothing is padded
    assert not r.submit_top(ids[:9] + [999999999])["accepted"]                    # an id it never searched
    out = r.submit_top(ids[:10])
    assert out["accepted"] and r.top == ids[:10]
    top = next(e for e in r.drain() if e["type"] == "top")
    assert [c["id"] for c in top["cards"]] == ids[:10] and top["by"] == "agent"


def test_fewer_than_ten_only_when_fewer_exist():
    r = Run("home", "test")
    r.set_brief({"city": "houston", "beds": 3, "budget_max": 900}, [])
    res = search.search_homes(r.brief, limit=60)
    r.add_candidates(res["cards"], res["total"])
    if len(r.candidates) < 10:
        assert r.submit_top(list(r.candidates))["accepted"]


def test_deep_dives_only_for_the_top_three_and_stay_short():
    r = run_with_candidates()
    ids = list(r.candidates)[:10]
    r.submit_top(ids)
    assert not r.add_deep(ids[5], {}, ["fine"], [])["accepted"]
    assert not r.add_deep(ids[0], {}, [" ".join(["word"] * 20)], [])["accepted"]
    assert r.add_deep(ids[0], {}, ["0.3 mi to the school"], ["No parking listed"])["accepted"]


def test_widening_is_recorded_and_user_fields_are_locked():
    b = home_brief(locked=["budget_max"])
    r = Run("home", "test", b)
    out = r.set_brief({"budget_max": 4000, "beds": 3}, None)
    assert out["refused_locked"] == ["budget_max"] and r.brief.budget_max == 2500
    assert any(a["field"] == "beds" and a["from"] == 2 and a["to"] == 3 for a in r.brief.adjustments)


# ---------------------------------------------------------------- the comparison compares, it doesn't rank
def test_comparison_marks_best_values_without_reordering():
    r = run_with_candidates()
    cards = list(r.candidates.values())[:10]
    cmp = compare.build(cards, r.brief)
    assert [row["id"] for row in cmp["rows"]] == [c["id"] for c in cards]
    rents = [row["values"]["rent"] for row in cmp["rows"]]
    best = [row for row in cmp["rows"] if "rent" in row["best"]]
    assert best and all(row["values"]["rent"] == min(rents) for row in best)


# ---------------------------------------------------------------- whole runs
@pytest.mark.parametrize("mode,query", [("home", "2-bed with parking under 2500 in Houston"),
                                        ("commercial", "coffee shop in Houston under 4000 a month")])
def test_fixed_rules_run_end_to_end(monkeypatch, mode, query):
    monkeypatch.setenv("AGENT_DISABLED", "1")
    ev = list(run_search(mode, query))
    types = [e["type"] for e in ev]
    assert types[0] == "start" and "fallback" in types and types[-1] == "done"
    top = next(e for e in ev if e["type"] == "top")
    assert len(top["cards"]) == 10 and top["by"] == "fallback"
    buildings = [c["property_id"] for c in top["cards"]]
    assert max(buildings.count(b) for b in buildings) <= 2                      # options differ
    assert sum(1 for e in ev if e["type"] == "deep") == 3


class ScriptedAgent(BaseChatModel):
    """Stateless script: the orchestrator writes a brief, searches, picks ten and launches three deep dives;
    each deep-dive subagent reads its listing and reports. Decided from the messages alone (safe in parallel)."""

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        system = " ".join(str(m.content) for m in messages if isinstance(m, SystemMessage))
        tools = [m for m in messages if isinstance(m, ToolMessage)]
        call = lambda name, args, i=0: {"name": name, "args": args, "id": f"{name}-{len(tools)}-{i}"}
        if "investigate one listing" in system:                                  # deep-dive subagent
            human = " ".join(str(m.content) for m in messages if isinstance(m, HumanMessage))
            lid = int(re.search(r"Listing (\d+)", human).group(1))
            if not tools:
                msg = AIMessage(content="", tool_calls=[call("listing_context", {"listing_id": lid})])
            elif tools[-1].name == "listing_context":
                msg = AIMessage(content="", tool_calls=[call("submit_deep_dive", {"listing_id": lid, "highlights": ["Two schools within a mile"], "watch_outs": []})])
            else:
                msg = AIMessage(content="Done")
        else:                                                                     # orchestrator
            names = [t.name for t in tools]
            if not names:
                msg = AIMessage(content="", tool_calls=[call("set_brief", {"mode": "home", "city": "houston", "beds": 2, "budget_max": 2500, "parking": True})])
            elif names[-1] == "set_brief":
                msg = AIMessage(content="", tool_calls=[call("search_listings", {"limit": 20})])
            elif names[-1] == "search_listings":
                ids = [c["id"] for c in json.loads(tools[-1].content)["candidates"]][:10]
                msg = AIMessage(content="", tool_calls=[call("submit_top10", {"listing_ids": ids})])
            elif names[-1] == "submit_top10":
                ids = json.loads(tools[-1].content)["deep_dive_next"]
                msg = AIMessage(content="", tool_calls=[call("task", {"subagent_type": "deep-dive", "description": f"Listing {i}, pick #{n}."}, n)
                                                        for n, i in enumerate(ids, 1)])
            else:
                msg = AIMessage(content="Done")
        return ChatResult(generations=[ChatGeneration(message=msg)])


def test_deepagents_orchestrator_runs_three_parallel_deep_dives():
    ev = list(run_search(None, "2-bed with parking under 2500 in Houston", model=ScriptedAgent()))     # the agent decides the mode
    assert any(e["type"] == "mode" and e["mode"] == "home" for e in ev)
    types = [e["type"] for e in ev]
    assert ev[0]["agent"] == "deepagents" and "fallback" not in types, types
    top = next(e for e in ev if e["type"] == "top")
    assert top["by"] == "agent" and len(top["cards"]) == 10
    deeps = [e for e in ev if e["type"] == "deep"]
    assert sorted(d["rank"] for d in deeps) == [1, 2, 3] and all(d["by"] == "agent" for d in deeps)
    done = ev[-1]
    assert done["type"] == "done" and done["by"] == "agent" and done["stats"]["subagent_runs"] == 3


# ---------------------------------------------------------------- one search box: home or business is worked out
@pytest.mark.parametrize("query,mode", [
    ("2-bed with parking within 3 miles of an elementary school in Houston, under 2200", "home"),
    ("Coffee shop downtown Houston, near offices, under 4000 a month", "commercial"),
    ("Studio close to Rice University under 1600", "home"),
    ("yoga studio near Montrose", "commercial"),
    ("Boutique gym in Los Angeles near apartments", "commercial"),
    ("apartment near a good coffee shop", "home"),
    ("I want to open a taqueria in LA", "commercial"),
    ("place for me and my wife near Rice", "home"),
])
def test_mode_is_read_from_the_request(query, mode):
    assert classify_mode(query) == mode


def test_run_without_a_mode_decides_it(monkeypatch):
    monkeypatch.setenv("AGENT_DISABLED", "1")
    ev = list(run_search(None, "bakery in Houston under 5000 a month"))
    assert next(e for e in ev if e["type"] == "mode")["mode"] == "commercial"
    assert next(e for e in ev if e["type"] == "brief")["brief"]["mode"] == "commercial"


def test_agent_must_set_a_mode_before_the_brief():
    r = Run(None, "somewhere to live")
    assert not r.set_brief({"city": "houston"}, [])["accepted"]
    assert r.set_brief({"mode": "home", "city": "houston"}, [])["accepted"] and r.mode == "home"
    assert next(e for e in r.drain() if e["type"] == "mode")["mode"] == "home"


def test_a_mode_the_user_chose_is_kept():
    r = Run("commercial", "bakery")
    out = r.set_brief({"mode": "home", "city": "houston", "business": "bakery"}, [])
    assert out["refused_locked"] == ["mode"] and r.mode == "commercial"