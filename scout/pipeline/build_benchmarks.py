"""Market norms from the kit: how much space each business type really occupies, and what rents were signed.

Outputs (data/built/):
    benchmarks.json     size percentiles per business type + rent benchmarks per space use and market
    tenants.parquet     one row per classified tenancy (used by build_graph.py)

Usage: python pipeline/build_benchmarks.py [--samples]
"""
from __future__ import annotations

import json
import random
import sys
from collections import defaultdict
from typing import Any

import pandas as pd

from common import BUILT, BUILDOUT_TO_BUSINESS, MARKETS, classify_business, decode, is_food_industry, read_jsonl

DEFAULT_SQFT = 500.0   # many tenancies record exactly 500 sq ft — a data-entry default, excluded
MIN_N = 40             # below this the benchmark is "too few — use the law"
RENT_SINCE_YEAR = 2018  # signed deals older than this say little about today's rent

LABELS = {"cafe": "Café / coffee", "restaurant": "Restaurant", "gym": "Gym / fitness",
          "clinic": "Clinic / medical", "daycare": "Daycare"}


def load_companies() -> dict[int, dict[str, Any]]:
    out = {}
    for c in read_jsonl("company-detail.jsonl"):
        prof = c.get("profile") or {}
        out[c["id"]] = {
            "name": c.get("name") or prof.get("companyName"),
            "industry": prof.get("industryType"),
            "employees": c.get("numEmployees"),
            "active": c.get("businessStatus") == 1,
        }
    return out


def to_yearly(rate: float | None, basis: int | None) -> float | None:
    if not rate or rate <= 0 or basis not in (1, 2):
        return None
    return rate * 12 if basis == 1 else rate


def pct(series: pd.Series, q: float) -> int:
    return int(round(float(series.quantile(q))))


def build(show_samples: bool = False) -> None:
    BUILT.mkdir(parents=True, exist_ok=True)
    companies = load_companies()
    props = pd.read_parquet(BUILT / "properties.parquet").set_index("property_id")
    market_of = props["market_id"].to_dict()

    tenancies, deals = [], []
    n_default = 0
    for occ in read_jsonl("location-occupancy.jsonl"):
        comp = companies.get(occ.get("tenantLocationId")) or {}
        name = comp.get("name")
        business = classify_business(name)
        food_by_industry = is_food_industry(name, comp.get("industry"))
        spaces = occ.get("spaces") or []
        sqft = sum(s.get("squareFeetOccupied") or 0 for s in spaces)
        buildouts = sorted({decode("BuildOut", s.get("buildOut")) for s in spaces} & set(BUILDOUT_TO_BUSINESS))
        if business or food_by_industry or buildouts or (comp.get("employees") and not occ.get("toDate")):
            tenancies.append({
                "occupancy_id": occ["id"],
                "property_id": occ["propertyId"],
                "company_id": occ.get("tenantLocationId"),
                "name": name,
                "business": business,
                "food_by_industry": food_by_industry,
                "buildouts": ",".join(buildouts) or None,
                "sqft": sqft or None,
                "current": not occ.get("toDate"),
                "from_year": int(occ["fromDate"][:4]) if occ.get("fromDate") else None,
                "to_year": int(occ["toDate"][:4]) if occ.get("toDate") else None,
                "employees": comp.get("employees"),
                "industry": decode("IndustryType", comp.get("industry")) if comp.get("industry") else None,
            })
        ld = occ.get("leaseDeal") or {}
        rate = to_yearly(ld.get("rateActual"), ld.get("rateBasis"))
        signed = ld.get("signDate") or ld.get("commencementDate")
        if rate and signed and market_of.get(occ["propertyId"]) in MARKETS:
            deals.append({
                "market": MARKETS[market_of[occ["propertyId"]]]["key"],
                "space_use": decode("SpaceUse", ld.get("spaceUse")),
                "rate_yr": rate,
                "year": int(signed[:4]),
                "service_type": decode("ServiceType", ld.get("serviceType")),
            })

    ten = pd.DataFrame(tenancies)
    ten.to_parquet(BUILT / "tenants.parquet", index=False)

    # ---- size benchmarks
    sizes: dict[str, Any] = {}
    for key, label in LABELS.items():
        g = ten[(ten.business == key) & ten.sqft.notna() & (ten.sqft > 0)]
        n_default += int((g.sqft == DEFAULT_SQFT).sum())
        g = g[g.sqft != DEFAULT_SQFT]
        entry: dict[str, Any] = {"label": label, "n": int(len(g)), "enough": bool(len(g) >= MIN_N)}
        if len(g):
            entry.update(p25=pct(g.sqft, .25), median=pct(g.sqft, .5), p75=pct(g.sqft, .75))
        sizes[key] = entry
        if show_samples:
            random.seed(7)
            names = g.name.dropna().unique().tolist()
            print(f"\n[{key}] n={len(g)}  sample names:", random.sample(names, min(22, len(names))))

    # ---- rent benchmarks: signed deals and current asking, $/SF/year, by market and space use
    deals_df = pd.DataFrame(deals)
    recent = deals_df[deals_df.year >= RENT_SINCE_YEAR]
    signed: dict[str, dict[str, Any]] = defaultdict(dict)
    for (market, use), g in recent.groupby(["market", "space_use"]):
        if len(g) >= 5:
            signed[market][use] = {"n": int(len(g)), "p25": round(float(g.rate_yr.quantile(.25)), 2),
                                   "median": round(float(g.rate_yr.median()), 2),
                                   "p75": round(float(g.rate_yr.quantile(.75)), 2)}
    spaces = pd.read_parquet(BUILT / "spaces.parquet")
    asking: dict[str, dict[str, Any]] = defaultdict(dict)
    priced = spaces[spaces.rate_low_yr.notna() & spaces.market.notna()]
    for (market, use), g in priced.groupby(["market", "space_use"]):
        if len(g) >= 5:
            mid = (g.rate_low_yr + g.rate_high_yr) / 2
            asking[market][use] = {"n": int(len(g)), "p25": round(float(mid.quantile(.25)), 2),
                                   "median": round(float(mid.median()), 2), "p75": round(float(mid.quantile(.75)), 2),
                                   "sf_weighted": round(float((mid * g.sqft_max).sum() / g.sqft_max.sum()), 2)}

    out = {
        "sizes": sizes,
        "size_method": ("Sum of squareFeetOccupied per tenancy in location-occupancy, tenants found by name keywords "
                        f"on company-detail; tenancies recording exactly {int(DEFAULT_SQFT)} sq ft (a default) excluded."),
        "min_n": MIN_N,
        "rent_signed": signed,
        "rent_signed_method": (f"leaseDeal.rateActual on deals signed {RENT_SINCE_YEAR} or later, normalized to $/SF/year "
                               "with leaseDeal.rateBasis; all service types."),
        "rent_asking": asking,
        "rent_asking_method": "Midpoint of rateLow/rateHigh on active spaces with a quoted rate, normalized to $/SF/year; all service types.",
    }
    (BUILT / "benchmarks.json").write_text(json.dumps(out, indent=2), encoding="utf-8")

    print(f"tenancies kept: {len(ten):,}   classified by name: {int(ten.business.notna().sum()):,}   "
          f"food by industry code: {int(ten.food_by_industry.sum()):,}   with build-out record: {int(ten.buildouts.notna().sum()):,}")
    print(f"excluded as 500 sq ft default: {n_default}")
    print(f"{'business':12} {'n':>5} {'p25':>7} {'median':>7} {'p75':>7}")
    for key, e in sizes.items():
        print(f"{key:12} {e['n']:>5} {e.get('p25', '-'):>7} {e.get('median', '-'):>7} {e.get('p75', '-'):>7}  {'' if e['enough'] else '(too few — use the law)'}")
    print(f"signed deals with a rate: {len(deals_df):,}  since {RENT_SINCE_YEAR}: {len(recent):,}")
    for market in signed:
        print(" signed", market, {u: (v['median'], v['n']) for u, v in signed[market].items()})
    for market in asking:
        print(" asking", market, {u: (v['median'], v['n']) for u, v in asking[market].items()})


if __name__ == "__main__":
    build(show_samples="--samples" in sys.argv)
