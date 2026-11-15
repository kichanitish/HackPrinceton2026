"""Program → how much space it needs.

Three numbers, each with its source:
    legal minimum   capacity × the code's sq ft per person (rules.json), converted to gross
    market norm     what similar businesses in the kit actually occupy (benchmarks.json, with n)
    recommended     [max(legal, market p25), max(legal × 1.5, market median × 1.5)]
"""
from __future__ import annotations

import math
from typing import Any

from .parse import Program
from .store import BUSINESSES, MARKETS, Store


def _round50(x: float, up: bool = False) -> int:
    return int((math.ceil if up else round)(x / 50.0) * 50)


def rules_for(store: Store, business: str, state: str) -> dict[str, Any]:
    """The capacity rule, the outdoor rule (if any) and reference rules for a business in a state."""
    rows = [r for r in store.rules if business in r["business"] and state in r["states"]]
    capacity = next(r for r in rows if r["role"] == "capacity")
    return {
        "capacity": capacity,
        "outdoor": next((r for r in rows if r["role"] == "outdoor"), None),
        "reference": [r for r in rows if r["role"] == "reference"],
    }


def net_to_gross(store: Store, business: str) -> dict[str, Any]:
    return store.assumptions["net_to_gross"][business]


def max_capacity(store: Store, business: str, state: str, gross_sqft: float) -> int:
    """How many seats / people / children a space of this size supports under the capacity rule."""
    rule = rules_for(store, business, state)["capacity"]
    usable = gross_sqft * (net_to_gross(store, business)["value"] if rule["basis"] == "net" else 1.0)
    return int(usable // rule["sqft_per_person"])


def size_program(store: Store, program: Program) -> dict[str, Any]:
    market = MARKETS[program.market]
    biz = BUSINESSES[program.business]
    rules = rules_for(store, program.business, market["state"])
    rule = rules["capacity"]
    ntg = net_to_gross(store, program.business)
    cap = program.capacity
    unit = biz["unit_one"] if cap == 1 else biz["unit"]

    area = cap * rule["sqft_per_person"]
    if rule["basis"] == "net":
        net_sqft, gross_sqft = area, area / ntg["value"]
        steps = [
            f"{cap:,} {unit} × {rule['sqft_per_person']} sq ft = {area:,.0f} sq ft of {_net_name(program.business)}",
            f"{area:,.0f} ÷ {ntg['value']:.2f} = {gross_sqft:,.0f} sq ft of leased space",
        ]
    else:
        net_sqft, gross_sqft = None, float(area)
        steps = [f"{cap:,} {unit} × {rule['sqft_per_person']} sq ft = {area:,.0f} sq ft of leased space"]

    legal = {
        "rule": rule,
        "net_sqft": round(net_sqft) if net_sqft else None,
        "net_name": _net_name(program.business) if net_sqft else None,
        "gross_sqft": round(gross_sqft),
        "net_to_gross": ntg if rule["basis"] == "net" else None,
        "steps": steps,
    }

    outdoor = None
    if rules["outdoor"]:
        o = rules["outdoor"]
        total = cap * o["sqft_per_person"]
        outdoor = {
            "rule": o,
            "sqft": total,
            "steps": [f"{cap:,} children × {o['sqft_per_person']} sq ft = {total:,} sq ft outdoors"
                      + (" if everyone is outside together" if market["state"] == "TX" else "")],
            "note": ("Texas counts only the children outside at one time, so rotating groups cuts this."
                     if market["state"] == "TX" else "California counts every child in the licensed capacity."),
        }

    bench = dict(store.benchmarks["sizes"][program.business])
    bench["method"] = store.benchmarks["size_method"]
    bench["scope"] = "Houston and Los Angeles tenancies in the CoStar kit"

    headroom = store.assumptions["recommended_headroom"]["value"]
    if program.target_sqft:
        low, high = _round50(program.target_sqft * 0.85), _round50(program.target_sqft * 1.15, up=True)
        basis = f"You asked for about {program.target_sqft:,} sq ft, so the search uses ±15% of that."
        if program.target_sqft < gross_sqft:
            basis += f" That is below the {gross_sqft:,.0f} sq ft legal minimum for {cap:,} {unit}."
    elif bench.get("enough"):
        low = _round50(max(gross_sqft, bench["p25"]), up=True)
        high = _round50(max(gross_sqft * headroom, bench["median"] * headroom), up=True)
        basis = (f"From the larger of the legal minimum ({gross_sqft:,.0f}) and the market's lower quartile ({bench['p25']:,}), "
                 f"up to {headroom:g}× the larger of the legal minimum and the market median ({bench['median']:,}).")
    else:
        low = _round50(gross_sqft, up=True)
        high = _round50(gross_sqft * headroom, up=True)
        basis = (f"Only {bench['n']} {biz['label'].lower()} tenancies in the kit — too few to trust — so the range is the "
                 f"legal minimum up to {headroom:g}× it.")
    if high <= low:
        high = low + 250

    return {
        "legal": legal,
        "outdoor": outdoor,
        "reference_rules": rules["reference"],
        "market": bench,
        "recommended": {"low": low, "high": high, "basis": basis, "from_target": bool(program.target_sqft)},
        "state": market["state"],
        "state_name": market["state_name"],
        "market_name": market["name"],
        "disclaimer": store.disclaimer,
        "ibc_note": store.ibc_note,
    }


def _net_name(business: str) -> str:
    return {"cafe": "dining floor", "restaurant": "dining floor", "daycare": "indoor activity space"}.get(business, "floor")


# The kind of space each business usually leases, for the rent comparison (medical first, then medical office).
RENT_USE: dict[str, tuple[str, ...]] = {"cafe": ("Retail",), "restaurant": ("Retail",), "gym": ("Retail", "Flex"),
                                        "clinic": ("OfficeMedical", "Medical"), "daycare": ("Retail",)}
USE_WORDS = {"Retail": "retail", "Flex": "flex", "OfficeMedical": "medical office", "Medical": "medical"}
MIN_RENT_N = 10


def rent_for(store: Store, business: str, market: str, sqft: float) -> dict[str, Any] | None:
    """Monthly rent for `sqft` at the median of signed deals (or asking rents when too few deals), with its n."""
    for kind, table in (("signed", "rent_signed"), ("asking", "rent_asking")):
        for use in RENT_USE[business]:
            b = (store.benchmarks[table].get(market) or {}).get(use)
            if b and b["n"] >= MIN_RENT_N:
                return {"rate_psf_yr": b["median"], "monthly": round(sqft * b["median"] / 12, -1), "n": b["n"], "kind": kind,
                        "use": use, "basis": (f"median of {b['n']} signed {USE_WORDS[use]} leases since 2018" if kind == "signed"
                                              else f"median asking rent of {b['n']} {USE_WORDS[use]} spaces for lease now")}
    return None


def compare_markets(store: Store, program: Program) -> list[dict[str, Any]]:
    """The same program sized under each city's rules, and what that space rents for there."""
    out = []
    for key, market in MARKETS.items():
        p = program.model_copy(update={"market": key, "target_sqft": None})
        s = size_program(store, p)
        out.append({
            "market": key, "market_name": market["name"], "state_name": market["state_name"],
            "rule_code": s["legal"]["rule"]["code"], "sqft_per_person": s["legal"]["rule"]["sqft_per_person"],
            "legal_gross_sqft": s["legal"]["gross_sqft"], "legal_net_sqft": s["legal"]["net_sqft"],
            "outdoor_sqft": s["outdoor"]["sqft"] if s["outdoor"] else None,
            "outdoor_per_person": s["outdoor"]["rule"]["sqft_per_person"] if s["outdoor"] else None,
            "recommended": s["recommended"],
            "source_url": s["legal"]["rule"]["source_url"],
            # what a fixed 1,500 sq ft of net space allows — the demo hook
            "capacity_in_1500_net": int(1500 // s["legal"]["rule"]["sqft_per_person"]) if s["legal"]["rule"]["basis"] == "net" else None,
            "rent": rent_for(store, program.business, key, s["legal"]["gross_sqft"]),
        })
    return out
