"""Filter the 3,955 spaces to those the program fits, then rank them. All deterministic.

Every score part is returned so the UI can show why a space ranks where it does.
"""
from __future__ import annotations

from typing import Any

from .parse import Program
from .sizing import max_capacity
from .store import BUSINESSES, MARKETS, Store

# How well each kit space use suits each business (0 = not offered).
USE_FIT: dict[str, dict[str, float]] = {
    "cafe": {"Retail": 1.0, "OfficeRetail": 0.8},
    "restaurant": {"Retail": 1.0, "OfficeRetail": 0.7},
    "gym": {"Retail": 1.0, "Flex": 0.9, "OfficeRetail": 0.7, "Industrial": 0.6},
    "clinic": {"OfficeMedical": 1.0, "Medical": 1.0, "OfficeRetail": 0.6, "Retail": 0.5, "Office": 0.45},
    "daycare": {"Retail": 0.9, "OfficeRetail": 0.85, "Office": 0.55, "Flex": 0.5},
}
USE_LABEL = {"OfficeMedical": "Medical office", "OfficeRetail": "Office / retail", "Medical": "Medical",
             "Retail": "Retail", "Office": "Office", "Flex": "Flex", "Industrial": "Industrial"}

WEIGHTS = {"size": 0.25, "fitout": 0.22, "use": 0.15, "demand": 0.15, "rent": 0.10, "tour": 0.08, "competition": 0.05}
PART_LABELS = {"size": "Size fit", "fitout": "Fit-out & history", "use": "Right kind of space", "demand": "Customers nearby",
               "rent": "Rent", "tour": "3D tour & plans", "competition": "Competition"}

# resident share of the demand score; the rest is office workers
RESIDENT_SHARE = {"cafe": 0.5, "restaurant": 0.5, "gym": 0.7, "clinic": 0.6, "daycare": 0.65}
MAX_PER_BUILDING = 2
FOOD = ("cafe", "restaurant")


def _fmt_int(n: float) -> str:
    return f"{int(round(n)):,}"


def take_sqft(space: dict[str, Any], low: float, high: float) -> float:
    """Area the tenant would lease: the whole space, or a slice of a divisible one near the middle of the range."""
    lo, hi = space["sqft_min"] or space["sqft_max"], space["sqft_max"]
    if lo >= hi:
        return hi
    return min(max((low + high) / 2, lo), hi)


def use_fit(space: dict[str, Any], business: str) -> float:
    fit = USE_FIT[business].get(space["space_use"], 0.0)
    feats = space["features"]
    if fit == 0 and business in FOOD and space["is_ground"] and (
            "second_gen_restaurant" in feats or "kitchen_infrastructure" in feats or "food_use_mentioned" in feats):
        fit = 0.6   # the broker's own note pitches it for food
    if fit == 0 and business == "gym" and "fitness_friendly" in feats and space["space_use"] == "Office" and space["is_ground"]:
        fit = 0.4
    return fit


def floor_ok(space: dict[str, Any], business: str) -> bool:
    floor = space.get("floor_number")
    if floor is None:
        return True
    if business == "daycare":
        return floor == 1
    if business in FOOD:
        return floor <= 2 or "food_use_mentioned" in space["features"] or "second_gen_restaurant" in space["features"]
    return True


def _size_score(take: float, legal: float, low: float, high: float) -> float:
    if low <= take <= high:
        return 1.0
    if take < low:
        return 0.55 + 0.45 * (take - legal) / max(low - legal, 1.0) if take >= legal else 0.0
    return max(0.0, 1.0 - (take - high) / high)


def _fitout(space: dict[str, Any], feat: dict[str, Any], business: str, outdoor_need: float | None) -> tuple[float, list[dict[str, str]]]:
    """Fit-out score and the chips that justify it. Suite-level notes outrank building-level history."""
    f = set(space["features"])
    score, chips = 0.0, []

    def add(value: float, text: str, tone: str = "good", kind: str = "fitout") -> None:
        nonlocal score
        score = max(score, value)
        chips.append({"kind": kind, "tone": tone, "text": text, "weight": value})

    if business in FOOD:
        if "second_gen_restaurant" in f:
            add(1.0, "Second-generation restaurant space")
        if "kitchen_infrastructure" in f:
            add(0.9, "Kitchen infrastructure in place")
        if feat.get("buildout_food"):
            add(0.6, "Restaurant build-out recorded in this building", kind="history")
        if feat.get("tenants_food"):
            n = feat["tenants_food"]
            add(0.5, f"{n} food business{'es' if n != 1 else ''} operated in this building", kind="history")
        if "food_use_mentioned" in f and score < 0.5:
            add(0.45, "Broker pitches it for food use")
        if "patio" in f:
            score = min(1.0, score + 0.1)
            chips.append({"kind": "fitout", "tone": "good", "text": "Patio", "weight": 0.3})
        if "drive_thru" in f:
            chips.append({"kind": "fitout", "tone": "good", "text": "Drive-thru", "weight": 0.3})
    elif business == "clinic":
        if "dental" in f:
            add(1.0, "Dental build-out in place")
        elif "medical_buildout" in f:
            add(1.0, "Medical build-out in place")
        if feat.get("buildout_clinic"):
            add(0.6, "Medical build-out recorded in this building", kind="history")
        if feat.get("tenants_clinic"):
            n = feat["tenants_clinic"]
            add(0.55 if n >= 3 else 0.4, f"{n} medical practice{'s' if n != 1 else ''} in this building", kind="history")
        if space["space_use"] in ("OfficeMedical", "Medical") and score < 0.5:
            add(0.5, "Listed as medical space")
    elif business == "gym":
        if "fitness_friendly" in f:
            add(0.8, "Open plan or fitness-ready, per the broker")
        if feat.get("tenants_gym"):
            add(0.6, "A gym operated in this building", kind="history")
        if space["space_use"] in ("Flex", "Industrial") and score < 0.35:
            add(0.35, "Flex / industrial shell — high clear height likely")
    elif business == "daycare":
        if "childcare_friendly" in f:
            add(0.9, "Broker mentions school or play space")
        if feat.get("tenants_daycare"):
            add(0.7, "A childcare tenant operated in this building", kind="history")
        open_lot = space.get("open_lot_sqft")
        if outdoor_need and open_lot and open_lot >= outdoor_need:
            add(0.6, f"Lot has ~{_fmt_int(open_lot)} sq ft not under the building", kind="outside")
    if "move_in_ready" in f:
        score = min(1.0, score + 0.08)
    return score, chips


def _rent(space: dict[str, Any], program: Program, take: float, median: float | None) -> tuple[float, dict[str, Any] | None, bool, bool | None]:
    """Rent score, chip, whether the space is over budget, and whether the budget could be checked at all.

    A range is over budget only when even its low end is; a range that straddles the budget is flagged.
    A space with no listed rent is kept, but marked as unchecked rather than silently "within budget".
    """
    low = space.get("rate_low_yr")
    high = space.get("rate_high_yr") or low
    has_budget = bool(program.budget_psf_yr or program.budget_monthly)
    if low is None:
        chip = {"kind": "rent", "tone": "warn", "text": "Rent not listed — budget not checked", "weight": 0.45} if has_budget else None
        return 0.5, chip, False, (False if has_budget else None)
    over = partly = False
    if program.budget_psf_yr:
        over |= low > program.budget_psf_yr * 1.0001
        partly |= high > program.budget_psf_yr * 1.0001
    if program.budget_monthly:
        over |= low * take / 12 > program.budget_monthly * 1.0001
        partly |= high * take / 12 > program.budget_monthly * 1.0001
    score, chip = 0.6, None
    mid = (low + high) / 2
    if median:
        ratio = mid / median
        score = min(1.0, max(0.0, 1.25 - 0.5 * ratio))
        pct = round((ratio - 1) * 100)
        if pct <= -5:
            chip = {"kind": "rent", "tone": "good", "text": f"{-pct}% below the asking median", "weight": 0.5}
        elif pct >= 15:
            chip = {"kind": "rent", "tone": "warn", "text": f"{pct}% above the asking median", "weight": 0.3}
    if has_budget and not over:
        if partly:
            score = max(score, 0.6)
            chip = {"kind": "rent", "tone": "warn", "text": "Only the low end of the rent range fits your budget", "weight": 0.45}
        else:
            score = max(score, 0.7)
            chip = chip or {"kind": "rent", "tone": "good", "text": "Within your budget", "weight": 0.4}
    return score, chip, over, (True if has_budget else None)


def _competition(n: int, business: str) -> float:
    if business == "clinic":
        return 1.0   # medical clusters help referrals
    return 1.0 if n == 0 else 0.8 if n <= 2 else 0.6 if n <= 5 else 0.4


def _context(store: Store, program: Program, sizing: dict[str, Any]) -> dict[str, Any]:
    return {"store": store, "program": program, "biz": program.business, "market": MARKETS[program.market],
            "legal": float(sizing["legal"]["gross_sqft"]),
            "low": float(sizing["recommended"]["low"]), "high": float(sizing["recommended"]["high"]),
            "outdoor_need": sizing["outdoor"]["sqft"] if sizing["outdoor"] else None,
            "asking": store.benchmarks["rent_asking"].get(program.market, {})}


def _card(ctx: dict[str, Any], s: dict[str, Any]) -> dict[str, Any]:
    """Score one space for one program and build its full card. The same function serves screening and any space
    the agent brings in later, so every card on the page carries the same fields."""
    store, program, biz = ctx["store"], ctx["program"], ctx["biz"]
    legal, low, high = ctx["legal"], ctx["low"], ctx["high"]
    feat = store.features.get(int(s["property_id"]), {})
    tenant_data = bool(feat) and bool(s.get("in_kit"))
    take = take_sqft(s, low, high)
    median = (ctx["asking"].get(s["space_use"]) or {}).get("median")
    rent_score, rent_chip, over, budget_checked = _rent(s, program, take, median)
    fit_score, chips = _fitout(s, feat, biz, ctx["outdoor_need"])
    share = RESIDENT_SHARE[biz]
    demand = share * (feat.get("apt_units_pct") or 0) + (1 - share) * (feat.get("workers_pct") or 0)
    n_comp = int(feat.get(f"competitors_{biz}") or 0)
    tour = 1.0 if s["tour_level"] == "suite" else 0.4 if s["tour_level"] == "building" else 0.0
    tour = min(1.0, tour + (0.2 if s.get("floorplan_url") else 0.0))
    parts = {
        "size": _size_score(take, legal, low, high),
        "fitout": fit_score,
        "use": use_fit(s, biz),
        "demand": demand,
        "rent": rent_score,
        "tour": tour,
        "competition": _competition(n_comp, biz) if tenant_data else 0.6,   # unknown, not "no competitors"
    }
    score = 100 * sum(WEIGHTS[k] * v for k, v in parts.items())
    for want in program.wants:
        if (want == "patio" and "patio" in s["features"]) or (want == "drive_thru" and "drive_thru" in s["features"]) \
                or (want == "kitchen" and ("second_gen_restaurant" in s["features"] or "kitchen_infrastructure" in s["features"])) \
                or (want == "tour" and s["tour_level"] == "suite") or (want == "ground_floor" and s["is_ground"]) \
                or (want == "parking" and (s.get("parking_ratio") or 0) >= 3):
            score += 4

    # ---- chips, most telling first
    units, workers = int(feat.get("apt_units_nearby") or 0), int(feat.get("workers_nearby") or 0)
    if units >= 300:
        chips.append({"kind": "demand", "tone": "good" if (feat.get("apt_units_pct") or 0) >= 0.5 else "neutral",
                      "text": f"{_fmt_int(units)} apartments within ½ mi", "weight": 0.35 + 0.3 * (feat.get("apt_units_pct") or 0)})
    if workers >= 200 and biz != "daycare":
        chips.append({"kind": "demand", "tone": "good" if (feat.get("workers_pct") or 0) >= 0.5 else "neutral",
                      "text": f"{_fmt_int(workers)} office workers within ½ mi", "weight": 0.3 + 0.3 * (feat.get("workers_pct") or 0)})
    if s.get("apt_units") and s["property_type"] == "Multifamily":
        chips.append({"kind": "demand", "tone": "good", "text": f"{_fmt_int(s['apt_units'])} apartments in this building", "weight": 0.7})
    if biz != "clinic" and tenant_data:
        label = {"cafe": "café", "restaurant": "restaurant", "gym": "gym", "daycare": "daycare"}[biz]
        if n_comp == 0:
            chips.append({"kind": "competition", "tone": "good", "text": f"No {label} in CoStar tenant records within ¼ mi", "weight": 0.3})
        else:
            chips.append({"kind": "competition", "tone": "warn" if n_comp > 2 else "neutral",
                          "text": f"{n_comp} {label}{'s' if n_comp != 1 else ''} within ¼ mi", "weight": 0.25})
    if rent_chip:
        chips.append(rent_chip)
    if s["tour_level"] == "suite":
        chips.append({"kind": "tour", "tone": "good", "text": "3D scan of this suite", "weight": 0.6})
    if s["space_use"] == "Industrial":
        chips.append({"kind": "caveat", "tone": "warn", "text": "Industrial — check zoning", "weight": 0.5})
    if biz == "clinic" and s["space_use"] == "Office" and fit_score < 0.5:
        chips.append({"kind": "caveat", "tone": "warn", "text": "Office space — needs a medical build-out", "weight": 0.45})
    if biz == "daycare" and not any(c["kind"] == "outside" for c in chips):
        chips.append({"kind": "caveat", "tone": "warn", "text": "Outdoor play space not confirmed", "weight": 0.45})
    if not tenant_data:
        chips.append({"kind": "caveat", "tone": "neutral", "text": "No CoStar tenant data for this building", "weight": 0.1})
    chips.sort(key=lambda c: -c["weight"])

    rate_low, rate_high = s.get("rate_low_yr"), s.get("rate_high_yr") or s.get("rate_low_yr")
    mid_rate = (rate_low + rate_high) / 2 if rate_low else None
    return {
        "space_id": int(s["space_id"]), "property_id": int(s["property_id"]),
        "address": s["address"], "building_name": s["building_name"], "city": s["city"], "state": s["state"], "zip": s["zip"],
        "suite": s["suite"], "floor_label": s["floor_label"], "lat": s["lat"], "lon": s["lon"],
        "sqft_min": s["sqft_min"], "sqft_max": s["sqft_max"], "take_sqft": round(take),
        "divisible": (s["sqft_min"] or s["sqft_max"]) < s["sqft_max"],
        "space_use": USE_LABEL.get(s["space_use"], s["space_use"]), "is_sublease": s["is_sublease"],
        "rent": {"low": rate_low, "high": rate_high if rate_low else None, "service_type": s.get("service_type"),
                 "known": rate_low is not None, "is_range": bool(rate_low and rate_high and rate_high > rate_low),
                 "monthly_est": round(mid_rate * take / 12) if mid_rate else None,
                 "budget_checked": budget_checked, "over_budget": over},
        "photo_url": s.get("photo_url"), "tour_level": s.get("tour_level"), "has_floorplan": bool(s.get("floorplan_url")),
        "scan_of_suite": s.get("tour_level") == "suite",
        "available_now": s["available_now"], "available_date": s.get("available_date"),
        "score": round(min(score, 99.0), 1), "match_pct": int(round(min(score, 99.0), 1) + 0.5),
        "score_parts": [{"key": k, "label": PART_LABELS[k], "value": round(v, 3), "weight": WEIGHTS[k]} for k, v in parts.items()],
        "chips": [{k: c[k] for k in ("kind", "tone", "text")} for c in chips[:5]],
        "max_capacity": max_capacity(store, biz, ctx["market"]["state"], take),
    }


def search(store: Store, program: Program, sizing: dict[str, Any], limit: int = 12) -> dict[str, Any]:
    ctx = _context(store, program, sizing)
    biz, market, legal, low, high = ctx["biz"], ctx["market"], ctx["legal"], ctx["low"], ctx["high"]

    in_market = [s for s in store.spaces if s["market"] == program.market and not s["lease_pending"] and not s["is_executive_suite"]]
    right_use = [s for s in in_market if use_fit(s, biz) > 0 and floor_ok(s, biz)]
    right_size = [s for s in right_use if s["sqft_max"] >= min(legal, low) and (s["sqft_min"] or s["sqft_max"]) <= high * 1.15]

    scored, over_budget = [], 0
    for s in right_size:
        card = _card(ctx, s)
        if card["rent"]["over_budget"]:
            over_budget += 1
            continue
        scored.append(card)

    scored.sort(key=lambda r: -r["score"])
    results, per_building = [], {}
    for r in scored:
        if per_building.get(r["property_id"], 0) >= MAX_PER_BUILDING:
            continue
        per_building[r["property_id"]] = per_building.get(r["property_id"], 0) + 1
        results.append(r)
        if len(results) >= limit:
            break
    for i, r in enumerate(results, 1):
        r["rank"] = i

    unit = BUSINESSES[biz]["unit"]
    funnel = [
        {"label": f"spaces for lease in {market['name']}", "n": len(in_market)},
        {"label": f"right kind of space for a {program.display_name()}", "n": len(right_use)},
        {"label": f"big enough for {program.capacity:,} {unit.split(' ')[0]}, not oversized", "n": len(right_size)},
    ]
    if program.budget_psf_yr or program.budget_monthly:
        funnel.append({"label": "within budget, or rent not listed", "n": len(scored)})
    return {
        "results": results,
        "total_matches": len(scored),
        "buildings": len({r["property_id"] for r in scored}),
        "over_budget": over_budget,
        "rent_unknown": sum(1 for r in scored if not r["rent"]["known"]),
        "funnel": funnel,
        "weights": [{"key": k, "label": PART_LABELS[k], "weight": w} for k, w in WEIGHTS.items()],
        "match_points": [[r["space_id"], r["lat"], r["lon"]] for r in scored if r["lat"] is not None],
    }


def card_for(store: Store, program: Program, sizing: dict[str, Any], space_id: int) -> dict[str, Any] | None:
    """The full card for any space, even one outside the screening results, with the filters it fails listed."""
    s = store.space_by_id.get(int(space_id))
    if not s:
        return None
    ctx = _context(store, program, sizing)
    card = _card(ctx, s)
    outside = []
    if s["market"] != program.market:
        outside.append("different city")
    if use_fit(s, program.business) == 0 or not floor_ok(s, program.business):
        outside.append("not the right kind of space")
    if s["sqft_max"] < min(ctx["legal"], ctx["low"]):
        outside.append("smaller than the legal minimum")
    if card["rent"]["over_budget"]:
        outside.append("over budget")
    card["outside_filters"] = outside
    return card
