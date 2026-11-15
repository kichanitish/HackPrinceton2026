"""The agents' tools. Thin LangChain wrappers over the deterministic search, bound to one run through the config.

Orchestrator: find_places, market_snapshot, set_brief, scan_areas, search_listings, submit_top10.
Deep-dive subagent: listing_context, nearby, submit_deep_dive.
"""
from __future__ import annotations

import json
import statistics
from typing import Any, Literal, Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from . import insights, places, search
from .data import get_data
from .geo import CITIES, miles
from .profiles import PROFILES, match_profile
from .run import Run, get_run


def _run(config: RunnableConfig | None) -> Run:
    r = get_run(config)
    if r is None:
        raise ValueError("No search is running.")
    return r


def _dump(x: Any) -> str:
    return json.dumps(x, default=str)


# ------------------------------------------------------------------ plain functions (tested directly)
def market_snapshot_impl(mode: str, city: str, business: str | None = None) -> dict[str, Any]:
    d = get_data()
    name = CITIES[city]["name"]
    if mode == "home":
        by_beds: dict[int, list[float]] = {}
        for h in d.homes:
            if h["city_key"] != city:
                continue
            for p in h.get("plans") or []:
                if (p.get("rentMin") or 0) > 0 and (p.get("available") or 0) > 0:
                    by_beds.setdefault(min(int(p["beds"]), 3), []).append(p["rentMin"])
        return {"city": name, "source": "CoStar apartment data (floor plans with a 3D tour)",
                "rent_from_by_bedrooms": {("3+" if k == 3 else str(k)): {"median": int(statistics.median(v)), "n": len(v),
                                                                       "p25": int(statistics.quantiles(v, n=4)[0]) if len(v) > 3 else None}
                                          for k, v in sorted(by_beds.items())}}
    key = match_profile(business) if business else "retail"
    prof = PROFILES[key]
    t = d.tenants
    sizes = t[(t.business == prof["tenant"]) & t.sqft.notna() & (t.sqft != 500)]["sqft"].tolist() if prof["tenant"] else []
    rents = {u: (d.benchmarks.get("rent_signed", {}).get(city) or {}).get(u) for u in prof["uses"]}
    listings = {u: sum(1 for s in d.spaces if s["market"] == city and s["space_use"] == u) for u in prof["uses"]}
    out = {"city": name, "business_profile": key, "label": prof["label"], "space_uses": prof["uses"], "listings_by_use": listings,
           "signed_rent_per_sqft_yr": {u: {"median": r["median"], "n": r["n"]} for u, r in rents.items() if r},
           "source": "CoStar kit (tenancies, listings, signed deals)"}
    if len(sizes) >= 8:
        q = statistics.quantiles(sizes, n=4)
        out["similar_businesses_occupy_sqft"] = {"median": int(statistics.median(sizes)), "p25": int(q[0]), "p75": int(q[2]), "n": len(sizes)}
    else:
        out["typical_sqft_guide"] = {"low": prof["size"][0], "high": prof["size"][1], "note": "few kit tenancies of this type; a market guide"}
    return out


def compact_card(c: dict) -> dict[str, Any]:
    """What the agent needs to judge a candidate, without the bulk."""
    base = {"id": c["id"], "name": c["name"], "zip": c.get("zip"), "area": c.get("neighbourhood"),
            "distances": {k: v["miles"] for k, v in (c.get("distances") or {}).items()}}
    if c["mode"] == "home":
        p = c["plan"]
        base.update(plan=f"{p.get('name')}: {p.get('beds')} bd / {p.get('baths')} ba, {p.get('sqftMin') or '?'} sf",
                    rent_from=p.get("rentMin"), available=p.get("available"), matching_plans=c.get("matching_plans"),
                    pets=c.get("pets"), parking=bool(c.get("parking")), tours=len(c.get("tours") or []))
    else:
        base.update(suite=c.get("suite"), use=c.get("space_use"), sqft=c.get("sqft"), monthly=c.get("monthly") or "not listed",
                    rate_yr=c.get("rate_yr"), ground=c.get("ground"), fitout=c.get("fitout"), parking_spaces=c.get("parking_spaces"),
                    apartment_units_half_mi=c["quick"]["residents_units"], office_workers_half_mi=c["quick"]["office_workers"],
                    competitors_half_mi=c["quick"]["competitors"], tour=bool(c.get("tour")))
    return base


# ------------------------------------------------------------------ orchestrator tools
@tool
def find_places(query: str, config: RunnableConfig) -> str:
    """Look up a place the user mentioned, in the run's city: a kind of place ('elementary school', 'park', 'airport',
    'metro station', 'grocery store') or a named one ('IAH', 'Rice University', 'Galleria', 'downtown', 'Montrose').
    Returns whether it's a category (distance to the nearest one counts) or specific points, and how many exist."""
    r = _run(config)
    city = (r.brief.city if r.brief else None) or r.query_city
    out = places.resolve(query, city)
    return _dump({"query": query, "kind": out["kind"], "label": out.get("label"), "count": out.get("count", len(out.get("points", []))),
                  "examples": [p["name"] for p in out.get("points", [])[:5]], "note": out.get("note")})


@tool
def market_snapshot(mode: Literal["home", "commercial"], config: RunnableConfig, business: Optional[str] = None,
                    city: Optional[Literal["houston", "los_angeles"]] = None) -> str:
    """Typical numbers for a city, to set sensible defaults: mode 'home' gives asking rent by bedrooms; mode
    'commercial' gives how much space similar businesses occupy, signed rents per sq ft and listing counts."""
    r = _run(config)
    city = city or (r.brief.city if r.brief else None) or r.query_city
    return _dump(market_snapshot_impl(mode, city, business))


class PlaceIn(BaseModel):
    place: str = Field(description="What to be near, in the user's words: 'elementary school', 'IAH', 'downtown', 'Rice University'.")
    radius_mi: float = Field(description="Maximum straight-line miles from the listing.")


@tool
def set_brief(config: RunnableConfig, mode: Optional[Literal["home", "commercial"]] = None,
              city: Optional[Literal["houston", "los_angeles"]] = None,
              places_near: Optional[list[PlaceIn]] = None, zips: Optional[list[str]] = None,
              beds: Optional[int] = None, baths_min: Optional[float] = None, budget_max: Optional[int] = None,
              sqft_min: Optional[int] = None, sqft_max: Optional[int] = None, pets: Optional[Literal["dog", "cat"]] = None,
              parking: Optional[bool] = None, business: Optional[str] = None, space_uses: Optional[list[str]] = None,
              ground_floor: Optional[bool] = None, must_have: Optional[list[Literal["kitchen", "parking"]]] = None) -> str:
    """Write or change the brief: what the place must be. The first call must set mode: 'home' (a place to live) or
    'commercial' (space for a business), as you judge from the request. Home mode: beds (exact; 3 = 3+), baths_min, budget_max ($/month),
    sqft_min, pets, parking. Commercial mode: business (the user's own words, e.g. 'bakery'), sqft_min/sqft_max,
    budget_max ($/month), space_uses (Retail, OfficeRetail, Office, OfficeMedical, Medical, Flex, Industrial),
    ground_floor, must_have. Both: city, places_near (replaces the list), zips. Omitted fields keep their value.
    Changes after the first brief are shown to the user as adjustments. Fields the user set by hand can't change."""
    r = _run(config)
    fields = {"mode": mode, "city": city, "zips": zips, "beds": beds, "baths_min": baths_min, "budget_max": budget_max, "sqft_min": sqft_min,
              "sqft_max": sqft_max, "pets": pets, "parking": parking, "business": business, "space_uses": space_uses,
              "ground_floor": ground_floor, "must_have": must_have}
    pl = None if places_near is None else [p.model_dump() if isinstance(p, BaseModel) else dict(p) for p in places_near]
    return _dump(r.set_brief(fields, pl))


@tool
def scan_areas(config: RunnableConfig) -> str:
    """Commercial only: the areas of the city where this business's customers are (apartment units, office workers,
    students, visitors) and competitors are fewest, among areas that have matching spaces. Returns zone ids to pass
    to search_listings."""
    r = _run(config)
    if r.mode != "commercial" or not r.brief:
        return _dump({"error": "scan_areas needs a commercial brief; call set_brief first."})
    zones = search.scan_areas(r.brief)
    r.set_zones(zones)
    return _dump({"zones": zones})


@tool
def search_listings(config: RunnableConfig, sort: Literal["closest", "cheapest", "largest", "demand", "least_competition"] = "closest",
                    limit: int = 30, zone_ids: Optional[list[str]] = None) -> str:
    """Listings that match the current brief exactly (every must and every place radius). sort picks which matches you
    see first: closest (to the brief's places), cheapest, largest (homes), demand or least_competition (commercial).
    zone_ids (commercial) restricts to areas from scan_areas. Returns total matches and the candidates."""
    r = _run(config)
    if not r.brief:
        return _dump({"error": "Call set_brief first."})
    if r.mode == "home":
        res = search.search_homes(r.brief, sort if sort in ("closest", "cheapest", "largest") else "closest", limit)
    else:
        centers = [(z["lat"], z["lon"]) for z in r.zones if z["id"] in (zone_ids or [])] or None
        res = search.search_spaces(r.brief, sort, limit, centers)
    r.add_candidates(res["cards"], res["total"])
    return _dump({"total_matches": res["total"], "matches_before_place_radius": res["before_places"],
                  "candidates": [compact_card(c) for c in res["cards"]]})


@tool
def submit_top10(listing_ids: list[int], config: RunnableConfig) -> str:
    """Your top 10, best first, chosen from your search results (exactly 10, or every candidate if fewer exist).
    The user gets these as options with a side-by-side comparison; the first three get deep dives."""
    return _dump(_run(config).submit_top(listing_ids))


# ------------------------------------------------------------------ deep-dive subagent tools
def context_impl(r: Run, listing_id: int) -> dict[str, Any]:
    return insights.home_context(listing_id, r.brief) if r.mode == "home" else insights.space_context(listing_id, r.brief)


def compact_context(ctx: dict) -> dict:
    """The context without coordinates, for the model."""
    def strip(x):
        if isinstance(x, dict):
            return {k: strip(v) for k, v in x.items() if k not in ("lat", "lon")}
        if isinstance(x, list):
            return [strip(v) for v in x]
        return x
    return strip(ctx)


@tool
def listing_context(listing_id: int, config: RunnableConfig) -> str:
    """Everything known around one listing. Commercial: who will visit (apartment units, office workers, students,
    visitors), competitors (counts and nearest), what the space offers (fit-out, past tenants of the same type, parking,
    frontage, transit, nearby draws) and rent against signed deals. Home: distance to the brief's places, what's
    around (schools, parks, grocery, transit, hospital, airport), floor plans, pets, parking."""
    r = _run(config)
    ctx = context_impl(r, listing_id)
    if not ctx.get("error"):
        r.deep.setdefault(int(listing_id), {})["_context"] = ctx
    return _dump(compact_context(ctx))


@tool
def nearby(listing_id: int, what: str, config: RunnableConfig, radius_mi: float = 1.0) -> str:
    """Places of a kind or name near one listing ('Starbucks', 'elementary school', 'gym', 'park'), nearest first."""
    r = _run(config)
    c = r.candidates.get(int(listing_id))
    if not c:
        return _dump({"error": f"Listing {listing_id} isn't in this search."})
    city = r.brief.city
    res = places.resolve(what, city, limit=200)
    if res["kind"] == "category":
        pts = places.category_points(city, res["category"], res.get("level_rx"))
    else:
        pts = res.get("points", [])
    found = sorted(((float(miles(c["lat"], c["lon"], p["lat"], p["lon"])), p["name"]) for p in pts), key=lambda x: x[0])
    return _dump({"what": res.get("label", what), "within": [{"name": n, "miles": round(d, 2)} for d, n in found if d <= radius_mi][:8],
                  "nearest": {"name": found[0][1], "miles": round(found[0][0], 2)} if found else None})


@tool
def submit_deep_dive(listing_id: int, highlights: list[str], watch_outs: list[str], config: RunnableConfig) -> str:
    """Report on one top-3 listing: up to 3 highlights and up to 2 watch-outs, each at most 12 words, facts with
    numbers from your tool results. No advice."""
    r = _run(config)
    lid = int(listing_id)
    ctx = (r.deep.get(lid) or {}).get("_context") or context_impl(r, lid)
    return _dump(r.add_deep(lid, ctx, highlights, watch_outs))


ORCHESTRATOR_TOOLS = [find_places, market_snapshot, set_brief, scan_areas, search_listings, submit_top10]
DEEP_TOOLS = [listing_context, nearby, submit_deep_dive]
LABELS = {"find_places": "Finding your places", "market_snapshot": "Reading the market", "set_brief": "Writing your brief",
          "scan_areas": "Finding the best areas", "search_listings": "Searching listings", "submit_top10": "Picking your top 10",
          "task": "Deep dive", "listing_context": "Deep dive", "nearby": "Deep dive", "submit_deep_dive": "Deep dive"}
