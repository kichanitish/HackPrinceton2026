"""Deep-dive facts for one listing. Every number is counted from the kit or the map snapshot, with its radius."""
from __future__ import annotations

import re
from typing import Any

import numpy as np

from . import places
from .brief import Brief
from .data import get_data
from .geo import CITIES, miles
from .profiles import PROFILES, competitor_pred
from .search import HALF, competitor_arrays, radius_sum, take_sqft, _mid_rate

AROUND_HOME = ["school", "park", "grocery", "transit", "hospital", "university", "airport"]
PARKING_WORDS = {"CoveredLot": "Covered lot", "SurfaceLot": "Surface lot", "Garage": "Garage", "Street": "Street",
                 "Parking": "Parking", "Other": "Other parking", "Assigned": "Assigned"}


def parking_words(t: str | None) -> str:
    return PARKING_WORDS.get(t or "", re.sub(r"(?<=[a-z])(?=[A-Z])", " ", t or "Parking").capitalize())


def _near_list(city: str, lat: float, lon: float, key: str, pred, r: float, n: int = 6) -> list[dict]:
    return [{"name": row["name"], "miles": round(d, 2), "lat": row["lat"], "lon": row["lon"]}
            for d, row in places.near(city, lat, lon, key, pred, r)[:n]]


def _sentences(text: str, rx: re.Pattern, limit: int = 2) -> list[str]:
    out = []
    for s in re.split(r"(?<=[.!?])\s+|\n+|•", text or ""):
        s = s.strip(" -•\t")
        if 8 < len(s) < 220 and rx.search(s):
            out.append(s)
        if len(out) >= limit:
            break
    return out


def fair_rent(s: dict, take: float) -> dict[str, Any]:
    d = get_data()
    use, city = s["space_use"], s["market"]
    signed = (d.benchmarks.get("rent_signed", {}).get(city) or {}).get(use)
    asking = (d.benchmarks.get("rent_asking", {}).get(city) or {}).get(use)
    rate = _mid_rate(s)
    out: dict[str, Any] = {"rate_yr": None if rate is None else round(rate, 2), "monthly": None if rate is None else int(round(rate * take / 12, -1)),
                           "service_type": s.get("service_type"), "use": use, "signed": signed, "asking": asking}
    ref = signed or asking
    if rate is None:
        out["verdict"] = "Rent not listed: ask the broker."
    elif ref:
        pct = round((rate / ref["median"] - 1) * 100)
        out.update(vs_pct=pct, ref_kind="signed deals" if signed else "asking rents", ref_median=ref["median"], ref_n=ref["n"],
                   target_yr=round(min(rate, ref["median"]), 2))
        out["verdict"] = (f"{abs(pct)}% {'below' if pct < 0 else 'above'} the median of {ref['n']} {use.lower()} "
                          f"{out['ref_kind']} in {CITIES[city]['name']} (${ref['median']:,.2f}/sf/yr)") if pct else \
                         f"In line with {ref['n']} {use.lower()} {out['ref_kind']} in {CITIES[city]['name']}"
    return out


def space_context(space_id: int, b: Brief) -> dict[str, Any]:
    d = get_data()
    s = d.space_by_id.get(int(space_id))
    if not s:
        return {"error": f"No commercial space {space_id}."}
    city, lat, lon = s["market"], s["lat"], s["lon"]
    key = b.business or "retail"
    prof = PROFILES[key]
    take = take_sqft(s, b.sqft_min, b.sqft_max)
    pt_lat, pt_lon = np.array([lat]), np.array([lon])
    dm = d.demand[city]
    units = int(radius_sum(pt_lat, pt_lon, dm["units_lat"], dm["units_lon"], dm["units"], HALF)[0])
    communities = int(radius_sum(pt_lat, pt_lon, dm["units_lat"], dm["units_lon"], np.ones(len(dm["units"])), HALF)[0])
    workers = int(radius_sum(pt_lat, pt_lon, dm["work_lat"], dm["work_lon"], dm["workers"], HALF)[0])
    A = places.ANCHOR_CATEGORIES
    schools = _near_list(city, lat, lon, "a:school", A["school"]["pred"], 1.0, 50)
    unis = _near_list(city, lat, lon, "a:university", A["university"]["pred"], 1.5, 5)
    hotels = _near_list(city, lat, lon, "a:hotel", A["hotel"]["pred"], HALF, 50)
    transit = _near_list(city, lat, lon, "a:transit", A["transit"]["pred"], HALF, 5)
    offices = places.near(city, lat, lon, "a:office", A["office"]["pred"], HALF)
    who = {"residents": {"units": units, "communities": communities, "radius_mi": HALF},
           "office_workers": {"count": workers, "osm_offices": len(offices), "radius_mi": HALF},
           "students": {"schools": len(schools), "universities": [u["name"] for u in unis], "radius_mi": 1.0},
           "visitors": {"hotels": len(hotels), "transit": [t["name"] for t in transit], "radius_mi": HALF}}
    cl, co, crow = competitor_arrays(city, key)
    comps = []
    known = places.has_any(city, f"comp:{key}", competitor_pred(key))
    if not known:
        counts = {"quarter_mi": None, "half_mi": None, "one_mi": None}
    elif len(cl):
        dd = miles(lat, lon, cl, co)
        order = np.argsort(dd)
        comps = [{"name": crow[i]["name"], "miles": round(float(dd[i]), 2), "lat": crow[i]["lat"], "lon": crow[i]["lon"]}
                 for i in order[:12] if dd[i] <= 1.0]
        counts = {"quarter_mi": int((dd <= 0.25).sum()), "half_mi": int((dd <= HALF).sum()), "one_mi": int((dd <= 1.0).sum())}
    else:
        counts = {"quarter_mi": 0, "half_mi": 0, "one_mi": 0}
    t = d.tenants
    history = []
    if prof["tenant"]:
        same = t[(t.property_id == s["property_id"]) & (t.business == prof["tenant"])]
        for _, r in same.sort_values("from_year", ascending=False).head(4).iterrows():
            yrs = f"{int(r.from_year)}–{'now' if r.current else int(r.to_year) if r.to_year == r.to_year else '?'}"
            history.append({"name": r["name"], "years": yrs, "current": bool(r.current)})
    rx = re.compile(prof["fitout"], re.I)
    feats = [re.sub(r"_", " ", f).strip().capitalize() + "." for f in s.get("features") or [] if f]   # listing codes → words
    fit = list(dict.fromkeys(_sentences(" ".join([s.get("notes") or ""] + feats), rx)))
    counts["in_building"] = sum(1 for h in history if h["current"])           # CoStar tenant records the map may miss
    draws = []
    for cat in prof["draws"]:
        if cat == "office":
            if offices:
                draws.append({"what": "offices", "count": len(offices), "radius_mi": HALF})
            continue
        lst = places.near(city, lat, lon, f"a:{cat}", A[cat]["pred"], HALF)
        if lst:
            draws.append({"what": A[cat]["label"], "count": len(lst), "nearest": lst[0][1]["name"], "radius_mi": HALF})
    use = {"fitout": fit, "same_type_in_building": history, "ground_floor": bool(s.get("is_ground")), "floor": s.get("floor_label"),
           "parking": {"spaces": s.get("parking_spaces"), "ratio_per_1000sf": s.get("parking_ratio")},
           "frontage": {"street": s.get("frontage_street"), "feet": s.get("frontage_ft")},
           "transit_quarter_mi": [x["name"] for x in transit if x["miles"] <= 0.25], "draws": draws,
           "tour": s.get("tour_model_id"), "building": {"name": s.get("building_name"), "class": s.get("building_class"),
                                                        "year_built": s.get("year_built"), "stories": s.get("stories")}}
    return {"id": int(space_id), "mode": "commercial", "business": prof["label"], "who_visits": who,
            "competitors": {"counts": counts, "nearest": comps, "kind": prof["label"].lower()},
            "can_use": use, "fair_rent": fair_rent(s, take), "area": places.neighbourhood(city, lat, lon) or s.get("zip"),
            "anchors": {a.label: _anchor_dist(city, a, lat, lon) for a in b.anchors},
            "sources": ["CoStar kit (listings, tenants, apartments, signed deals)", "OpenStreetMap (places, competitors)"]}


def _anchor_dist(city: str, a, lat: float, lon: float) -> dict:
    alat, alon, pts = places.anchor_arrays(city, a.model_dump())
    if not len(alat):
        return {"miles": None}
    dd = miles(lat, lon, alat, alon)
    i = int(np.argmin(dd))
    return {"miles": round(float(dd[i]), 1), "nearest": pts[i]["name"], "limit": a.radius_mi}


def home_context(home_id: int, b: Brief) -> dict[str, Any]:
    d = get_data()
    h = d.home_by_id.get(int(home_id))
    if not h:
        return {"error": f"No home {home_id}."}
    city, lat, lon = h["city_key"], h["lat"], h["lng"]
    around = {}
    asked = {a.category for a in b.anchors}
    for cat in [c for c in AROUND_HOME if c != "airport" or "airport" in asked]:   # the airport only when asked about
        n = places.nearest_of(city, lat, lon, cat)
        if n:
            around[places.ANCHOR_CATEGORIES[cat]["label"]] = n
    A = places.ANCHOR_CATEGORIES
    food = lambda r: r.get("amenity") in ("cafe", "restaurant", "fast_food")
    def count(key, pred, r):            # None when the map data has no places of this kind at all (unknown, not zero)
        return len(places.near(city, lat, lon, key, pred, r)) if places.has_any(city, key, pred) else None
    counts = {"schools_1mi": count("a:school", A["school"]["pred"], 1.0), "parks_1mi": count("a:park", A["park"]["pred"], 1.0),
              "food_half_mi": count("food", food, HALF), "grocery_1mi": count("a:grocery", A["grocery"]["pred"], 1.0)}
    from .search import plan_matches
    plans = [p for p in h.get("plans") or [] if (p.get("rentMin") or 0) > 0 and (p.get("available") or 0) > 0]
    fits = [p for p in plans if plan_matches(h, p, b)]
    return {"id": int(home_id), "mode": "home", "anchors": {a.label: _anchor_dist(city, a, lat, lon) for a in b.anchors},
            "around": around, "counts": counts, "neighbourhood": places.neighbourhood(city, lat, lon),
            "plans": [{k: p.get(k) for k in ("id", "name", "beds", "baths", "sqftMin", "sqftMax", "rentMin", "rentMax", "available")}
                      | {"tours": [t["id"] for t in p.get("tours") or []], "fits": p in fits} for p in plans],
            "pets": [p.get("type") for p in h.get("pets") or []] if h.get("noPets") is not True else [],
            "parking": sorted({parking_words(p.get("type")) for p in h.get("parking") or []}) if h.get("noParking") is not True else [],
            "manager": h.get("manager"), "units": h.get("units"), "stories": h.get("stories"),
            "sources": ["CoStar apartment data (HomeFit catalog)", "OpenStreetMap (places)"]}
