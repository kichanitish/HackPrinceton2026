"""Candidate search for a brief. Deterministic: the agent decides what to search for and which results to keep.

Homes: HomeFit's floor-plan filters (city, bedrooms, bathrooms, budget, pets, parking), plus size, ZIP and
distance to the places in the brief. Commercial: spaces for lease by use, size, monthly budget, floor, fit-out,
parking, ZIP and distance; plus the area scan that finds where a business's customers are and its competitors aren't.
"""
from __future__ import annotations

import re
from typing import Any

import numpy as np

from . import places
from .brief import Brief
from .data import get_data
from .geo import CITIES, miles
from .profiles import PROFILES, competitor_pred

HALF = 0.5


def _round(x: float, n: int = 1) -> float:
    return round(float(x), n)


def _parking(t: str | None) -> str:
    return {"CoveredLot": "Covered lot", "SurfaceLot": "Surface lot", "Other": "Other parking"}.get(t or "", re.sub(r"(?<=[a-z])(?=[A-Z])", " ", t or "Parking"))


# ------------------------------------------------------------------ homes
def plan_matches(home: dict, plan: dict, b: Brief) -> bool:
    if not (plan.get("rentMin") or 0) > 0 or not (plan.get("available") or 0) > 0:
        return False
    if b.beds is not None and (plan["beds"] < 3 if b.beds >= 3 else plan["beds"] != b.beds):
        return False
    if b.baths_min and not (isinstance(plan.get("baths"), (int, float)) and plan["baths"] >= b.baths_min):
        return False
    if b.budget_max and plan["rentMin"] > b.budget_max:
        return False
    if b.sqft_min and (plan.get("sqftMax") or plan.get("sqftMin") or 0) < b.sqft_min:
        return False
    return True


def home_ok(home: dict, b: Brief) -> bool:
    if home["city_key"] != b.city or (b.zips and home.get("zip") not in b.zips):
        return False
    if b.pets == "dog" and (home.get("noPets") is True or not any(p.get("type") == "Dog" for p in home.get("pets") or [])):
        return False
    if b.pets == "cat" and (home.get("noPets") is True or not any(p.get("type") == "Cat" for p in home.get("pets") or [])):
        return False
    if b.parking and (home.get("noParking") is True or not home.get("parking")):
        return False
    return True


def home_card(h: dict, plan: dict, n_plans: int, dist: dict[str, dict]) -> dict[str, Any]:
    return {"id": int(h["id"]), "mode": "home", "name": h["name"], "address": h["address"], "zip": h.get("zip"),
            "city": h["city"], "lat": h["lat"], "lon": h["lng"], "photo": h.get("photo"), "property_id": int(h["id"]),
            "plan": {k: plan.get(k) for k in ("id", "name", "beds", "baths", "sqftMin", "sqftMax", "rentMin", "rentMax", "available")},
            "tours": [t["id"] for t in plan.get("tours") or []], "matching_plans": n_plans,
            "pets": sorted({p["type"] for p in h.get("pets") or [] if p.get("type")}) if h.get("noPets") is not True else [],
            "parking": sorted({_parking(p.get("type")) for p in h.get("parking") or []}) if h.get("noParking") is not True else [],
            "units": h.get("units"), "stories": h.get("stories"), "style": h.get("style"), "manager": h.get("manager"),
            "distances": dist, "neighbourhood": places.neighbourhood(h["city_key"], h["lat"], h["lng"])}


def search_homes(b: Brief, sort: str = "closest", limit: int = 30) -> dict[str, Any]:
    d = get_data()
    rows = []
    for h in d.homes:
        if not home_ok(h, b):
            continue
        plans = [p for p in h.get("plans") or [] if plan_matches(h, p, b)]
        if plans:
            rows.append((h, sorted(plans, key=lambda p: p["rentMin"])))
    total_filters = len(rows)
    lats = np.array([h["lat"] for h, _ in rows], float)
    lons = np.array([h["lng"] for h, _ in rows], float)
    keep = np.ones(len(rows), bool)
    dists: list[dict[str, dict]] = [{} for _ in rows]
    for a in b.anchors:
        dd, idx = places.distance_to(b.city, a.model_dump(), lats, lons) if len(rows) else (np.zeros(0), np.zeros(0))
        _, _, pts = places.anchor_arrays(b.city, a.model_dump())
        for i in range(len(rows)):
            dists[i][a.label] = {"miles": _round(dd[i]), "nearest": pts[int(idx[i])]["name"] if idx[i] >= 0 else None, "limit": a.radius_mi}
        keep &= dd <= a.radius_mi
    cards = [home_card(h, plans[0], len(plans), dists[i]) for i, (h, plans) in enumerate(rows) if keep[i]]
    total = len(cards)
    if sort == "cheapest":
        cards.sort(key=lambda c: c["plan"]["rentMin"])
    elif sort == "largest":
        cards.sort(key=lambda c: -(c["plan"]["sqftMax"] or 0))
    else:      # closest to the brief's places, then cheapest
        cards.sort(key=lambda c: (sum(v["miles"] / max(v["limit"], .1) for v in c["distances"].values()), c["plan"]["rentMin"]))
    return {"total": total, "before_places": total_filters, "cards": cards[:max(1, min(limit, 60))]}


# ------------------------------------------------------------------ commercial
def _mid_rate(s: dict) -> float | None:
    lo, hi = s.get("rate_low_yr"), s.get("rate_high_yr")
    if lo is None:
        return None
    return (lo + (hi or lo)) / 2


def take_sqft(s: dict, lo: int | None, hi: int | None) -> float:
    """The area to lease: the smallest piece of a divisible space that meets the minimum, else the whole space."""
    smin, smax = s.get("sqft_min") or s.get("sqft_max") or 0, s.get("sqft_max") or 0
    if not lo:
        return smax
    return min(smax, max(smin, lo))


def space_ok(s: dict, b: Brief, fit_rx: re.Pattern | None) -> tuple[bool, float]:
    if s["market"] != b.city or (b.zips and s.get("zip") not in b.zips):
        return False, 0
    if b.space_uses and s["space_use"] not in b.space_uses:
        return False, 0
    smin, smax = s.get("sqft_min") or s.get("sqft_max") or 0, s.get("sqft_max") or 0
    if b.sqft_max and (smin > b.sqft_max * 1.0 or smax < (b.sqft_min or 0)):
        return False, 0
    take = take_sqft(s, b.sqft_min, b.sqft_max)
    rate = _mid_rate(s)
    if b.budget_max and rate is not None and rate * take / 12 > b.budget_max:
        return False, 0
    if b.ground_floor and not s.get("is_ground"):
        return False, 0
    if "kitchen" in b.must_have and not (fit_rx and fit_rx.search(" ".join([s.get("notes") or ""] + list(s.get("features") or [])))):
        return False, 0
    if "parking" in b.must_have and not ((s.get("parking_spaces") or 0) > 0 or (s.get("parking_ratio") or 0) > 0):
        return False, 0
    if s.get("lease_pending"):
        return False, 0
    return True, take


def radius_sum(lat: np.ndarray, lon: np.ndarray, plat: np.ndarray, plon: np.ndarray, w: np.ndarray, r: float) -> np.ndarray:
    if not len(lat) or not len(plat):
        return np.zeros(len(lat))
    d = miles(lat[:, None], lon[:, None], plat[None, :], plon[None, :])
    return ((d <= r) * w[None, :]).sum(axis=1)


def competitor_arrays(city: str, business: str) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    cp = places.city_places(city)
    m = cp.mask(f"comp:{business}", competitor_pred(business))
    idx = np.flatnonzero(m)
    return cp.lat[idx], cp.lon[idx], [cp.rows[i] for i in idx]


def space_card(s: dict, take: float, dist: dict, quick: dict, fit_hit: str | None) -> dict[str, Any]:
    rate = _mid_rate(s)
    return {"id": int(s["space_id"]), "mode": "commercial", "name": s.get("building_name") or s["address"], "address": s["address"],
            "suite": s.get("suite"), "zip": s.get("zip"), "city": CITIES[s["market"]]["name"], "lat": s["lat"], "lon": s["lon"],
            "photo": s.get("photo_url"), "property_id": int(s["property_id"]), "space_use": s["space_use"],
            "sqft": int(take) if take else None, "sqft_range": [s.get("sqft_min"), s.get("sqft_max")],
            "rate_yr": None if rate is None else round(rate, 2), "rate_range": [s.get("rate_low_yr"), s.get("rate_high_yr")],
            "monthly": None if rate is None or not take else int(round(rate * take / 12, -1)), "service_type": s.get("service_type"),
            "floor": s.get("floor_label"), "ground": bool(s.get("is_ground")), "available_now": bool(s.get("available_now")),
            "parking_spaces": s.get("parking_spaces"), "tour": s.get("tour_model_id"), "fitout": fit_hit,
            "distances": dist, "quick": quick, "neighbourhood": places.neighbourhood(s["market"], s["lat"], s["lon"])}


def search_spaces(b: Brief, sort: str = "closest", limit: int = 30, zone_centers: list[tuple[float, float]] | None = None) -> dict[str, Any]:
    d = get_data()
    p = PROFILES[b.business or "retail"]
    fit_rx = re.compile(p["fitout"], re.I)
    rows = []
    for s in d.spaces:
        ok, take = space_ok(s, b, fit_rx)
        if ok:
            rows.append((s, take))
    before = len(rows)
    lats = np.array([s["lat"] for s, _ in rows], float)
    lons = np.array([s["lon"] for s, _ in rows], float)
    keep = np.ones(len(rows), bool)
    dists: list[dict] = [{} for _ in rows]
    for a in b.anchors:
        dd, idx = places.distance_to(b.city, a.model_dump(), lats, lons) if len(rows) else (np.zeros(0), np.zeros(0))
        _, _, pts = places.anchor_arrays(b.city, a.model_dump())
        for i in range(len(rows)):
            dists[i][a.label] = {"miles": _round(dd[i]), "nearest": pts[int(idx[i])]["name"] if idx[i] >= 0 else None, "limit": a.radius_mi}
        keep &= dd <= a.radius_mi
    if zone_centers:
        zl = np.array([z[0] for z in zone_centers]); zo = np.array([z[1] for z in zone_centers])
        near_zone = (miles(lats[:, None], lons[:, None], zl[None, :], zo[None, :]) <= 0.8).any(axis=1) if len(rows) else np.zeros(0, bool)
        keep &= near_zone
    idx = np.flatnonzero(keep)
    dm = d.demand[b.city]
    sl, so = lats[idx], lons[idx]
    res = radius_sum(sl, so, dm["units_lat"], dm["units_lon"], dm["units"], HALF)
    wrk = radius_sum(sl, so, dm["work_lat"], dm["work_lon"], dm["workers"], HALF)
    cl, co, _ = competitor_arrays(b.city, b.business or "retail")
    comp = radius_sum(sl, so, cl, co, np.ones(len(cl)), HALF)
    comp_known = len(cl) > 0          # no competitors of this kind in the map data at all: unknown, not zero
    cards = []
    for j, i in enumerate(idx):
        s, take = rows[i]
        text = " ".join([s.get("notes") or ""] + list(s.get("features") or []))
        m = fit_rx.search(text)
        quick = {"residents_units": int(res[j]), "office_workers": int(wrk[j]), "competitors": int(comp[j]) if comp_known else None}
        cards.append(space_card(s, take, dists[i], quick, m.group(0).lower() if m else None))
    total = len(cards)
    if sort == "cheapest":
        cards.sort(key=lambda c: (c["monthly"] is None, c["monthly"] or 0))
    elif sort == "demand":
        cards.sort(key=lambda c: -(c["quick"]["residents_units"] * p["customers"].get("residents", 0) * 1.5
                                   + c["quick"]["office_workers"] * p["customers"].get("workers", 0)))
    elif sort == "least_competition":
        cards.sort(key=lambda c: c["quick"]["competitors"] if c["quick"]["competitors"] is not None else 0)
    else:
        cards.sort(key=lambda c: (sum(v["miles"] / max(v["limit"], .1) for v in c["distances"].values()), c["monthly"] is None, c["monthly"] or 0))
    return {"total": total, "before_places": before, "cards": cards[:max(1, min(limit, 60))]}


def scan_areas(b: Brief, top: int = 5) -> list[dict[str, Any]]:
    """Where to start: ~0.6-mile cells that hold at least one matching space, scored by the business's customers
    nearby against competitors nearby. Inside the brief's places when it has any."""
    d = get_data()
    prof = PROFILES[b.business or "retail"]
    base = b.model_copy(update={"budget_max": None, "anchors": b.anchors})
    found = search_spaces(base, limit=10_000)["cards"]
    if not found:
        return []
    step = 0.009            # ≈ 0.6 mi of latitude
    cells: dict[tuple[int, int], list[dict]] = {}
    for c in found:
        cells.setdefault((int(c["lat"] / step), int(c["lon"] / step)), []).append(c)
    keys = list(cells)
    lat = np.array([np.mean([c["lat"] for c in cells[k]]) for k in keys])
    lon = np.array([np.mean([c["lon"] for c in cells[k]]) for k in keys])
    dm = d.demand[b.city]
    res = radius_sum(lat, lon, dm["units_lat"], dm["units_lon"], dm["units"], HALF)
    wrk = radius_sum(lat, lon, dm["work_lat"], dm["work_lon"], dm["workers"], HALF)
    cp = places.city_places(b.city)
    def count(key: str, pred, r: float) -> np.ndarray:
        idx = np.flatnonzero(cp.mask(key, pred))
        return radius_sum(lat, lon, cp.lat[idx], cp.lon[idx], np.ones(len(idx)), r)
    students = count("a:school", places.ANCHOR_CATEGORIES["school"]["pred"], 1.0) + 5 * count("a:university", places.ANCHOR_CATEGORIES["university"]["pred"], 1.0)
    visitors = count("a:hotel", places.ANCHOR_CATEGORIES["hotel"]["pred"], HALF) + 2 * count("a:transit", places.ANCHOR_CATEGORIES["transit"]["pred"], HALF)
    cl, co, _ = competitor_arrays(b.city, b.business or "retail")
    comp = radius_sum(lat, lon, cl, co, np.ones(len(cl)), HALF)
    norm = lambda x: x / (np.percentile(x, 90) or 1)
    w = prof["customers"]
    demand = (w.get("residents", 0) * norm(res) + w.get("workers", 0) * norm(wrk) + w.get("students", 0) * norm(students)
              + w.get("visitors", 0) * norm(visitors))
    score = demand / (1 + 0.15 * comp)
    out, names = [], set()
    for i in np.argsort(-score):
        if len(out) == top:
            break
        k = keys[i]
        name = places.neighbourhood(b.city, lat[i], lon[i]) or cells[k][0].get("zip") or f"Area {len(out) + 1}"
        if name in names:                 # neighbouring cells of one area: keep the strongest
            continue
        names.add(name)
        rank = len(out) + 1
        out.append({"id": f"z{rank}", "name": name,
                    "lat": round(float(lat[i]), 5), "lon": round(float(lon[i]), 5), "listings": len(cells[k]),
                    "zip": cells[k][0].get("zip"), "residents_units": int(res[i]), "office_workers": int(wrk[i]),
                    "competitors": int(comp[i]), "students": int(students[i]), "visitors": int(visitors[i])})
    return out
