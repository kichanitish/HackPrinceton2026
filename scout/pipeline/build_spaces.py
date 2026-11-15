"""Flatten the lease listings into one row per available space, joined to its building.

Outputs (data/built/):
    spaces.parquet      one row per space for lease (3,955)
    properties.parquet  one row per kit property (3,339) — used for "what is nearby"

Usage: python pipeline/build_spaces.py
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from common import BUILT, MARKETS, STATE_TO_MARKET, decode, read_jsonl, split_camel, street_address

MATTERPORT_REF_TYPES = {36, 234}  # MatterportScan, MatterportStreamingKey
GROUND_FLOORS = {"Ground", "FirstFloor", "Lobby", "Plaza", "Concourse"}
ORDINALS = {
    "First": 1, "Second": 2, "Third": 3, "Fourth": 4, "Fifth": 5, "Sixth": 6, "Seventh": 7, "Eighth": 8,
    "Ninth": 9, "Tenth": 10, "Eleventh": 11, "Twelfth": 12, "Thirteenth": 13, "Fourteenth": 14,
    "Fifteenth": 15, "Sixteenth": 16, "Seventeenth": 17, "Eighteenth": 18, "Nineteenth": 19,
}
TENS = {"Twent": 20, "Thirt": 30, "Fort": 40, "Fift": 50, "Sixt": 60, "Sevent": 70, "Eight": 80, "Ninet": 90}
UNITS = {"First": 1, "Second": 2, "Third": 3, "Fourth": 4, "Fifth": 5, "Sixth": 6, "Seventh": 7, "Eighth": 8, "Ninth": 9}

# Signals mined from the broker's free-text note on each space. Suite-level evidence, unlike tenant history.
NOTE_FEATURES: dict[str, re.Pattern[str]] = {
    "second_gen_restaurant": re.compile(
        r"(second|2nd)[- ]gen(eration)?[^.]{0,40}(restaurant|kitchen|caf[eé]|food|bar)|"
        r"former(ly)?[^.]{0,25}(restaurant|caf[eé]|coffee|bakery|bar\b|eatery|deli)|"
        r"restaurant (space|build[- ]?out|opportunity)|turn[- ]?key (restaurant|caf[eé]|kitchen)|"
        r"existing (restaurant|kitchen|caf[eé])|fully (built|equipped)[^.]{0,30}(restaurant|kitchen)", re.I),
    "kitchen_infrastructure": re.compile(
        r"\b(hood|grease (trap|interceptor)|walk[- ]in (cooler|freezer)|commercial kitchen|kitchen equipment|"
        r"type (1|i) hood|vent(ed)? hood|full kitchen)\b", re.I),
    "food_use_mentioned": re.compile(r"\b(restaurants?|caf[eé]|coffee|food (use|service|hall)|dining|bakery|eatery)\b", re.I),
    "patio": re.compile(r"\b(patio|outdoor (seating|dining)|sidewalk seating|terrace)\b", re.I),
    "drive_thru": re.compile(r"drive[- ]?thr(u|ough)", re.I),
    "visibility": re.compile(
        r"\b(corner|end[- ]?cap|signalized|(high|excellent|great|prime) visibility|street frontage|"
        r"storefront|pylon sign\w*|monument sign\w*|foot traffic)\b", re.I),
    "medical_buildout": re.compile(
        r"\b(medical (build[- ]?out|space|suite|office)|exam (rooms?)|built[- ]?out (medical|dental)|"
        r"dental (build[- ]?out|office|suite|space)|operator(y|ies)|x-?ray|nurses?'? station|lab area|"
        r"procedure rooms?|sinks? in (each|every))\b", re.I),
    "dental": re.compile(r"\b(dental|operator(y|ies))\b", re.I),
    "fitness_friendly": re.compile(
        r"\b(fitness|gym|studio space|high ceilings?|open (floor ?plan|layout|concept)|clear height|showers?|locker)\b", re.I),
    "childcare_friendly": re.compile(
        r"\b(day ?care|child ?care|preschool|school|playground|play area|outdoor (space|area|play)|fenced (yard|area))\b", re.I),
    "move_in_ready": re.compile(r"\b(move[- ]in ready|turn[- ]?key|spec suite|fully (built|furnished)|plug[- ]and[- ]play)\b", re.I),
    "shell": re.compile(r"\b((cold|warm|vanilla|gray|grey)? ?shell (space|condition)|raw space|build[- ]to[- ]suit)\b", re.I),
    "private_restrooms": re.compile(
        r"\b(private|in[- ]suite|ensuite|own) (restrooms?|bathrooms?)|(restrooms?|bathrooms?) (in[- ]suite|within the suite)|"
        r"\b\d+ (restrooms?|bathrooms?)\b", re.I),
    "parking_mentioned": re.compile(r"\b(ample|abundant|free|on[- ]site|surface|garage|covered) parking\b", re.I),
}

SUITE_IN_CAPTION = re.compile(r"\b(?:suite|ste\.?|unit|space)\s*[-:#]?\s*([A-Za-z]?\d+[A-Za-z0-9-]*)(?![,.]?\d*\s*(?:r?sf|sq))", re.I)
SQFT_IN_CAPTION = re.compile(r"(\d{1,3}(?:,\d{3})+|\d{3,6})\s*(?:r?sf|sq\.? ?ft)", re.I)
APARTMENT_UNIT_CAPTION = re.compile(r"\b(\d\s*br|studio|\d\s*ba\b|bedroom|penthouse|townhome|loft \w)\b", re.I)


def floor_number(floor_name: str) -> int | None:
    """'TwentyFirstFloor' → 21, 'Ground' → 1, 'Basement' → 0; None when unknown."""
    if floor_name in GROUND_FLOORS:
        return 1
    if floor_name in ("Basement", "LowerLevel", "Subway", "Metro"):
        return 0
    if floor_name == "Mezzanine":
        return 2
    stem = floor_name.removesuffix("Floor")
    if stem in ORDINALS:
        return ORDINALS[stem]
    for prefix, base in TENS.items():
        if stem.startswith(prefix):
            rest = stem[len(prefix):]
            if rest in ("ieth", "y"):
                return base
            rest = rest.removeprefix("y")
            if rest in UNITS:
                return base + UNITS[rest]
    return None


def floor_label(floor_name: str, number: int | None) -> str:
    if floor_name in ("Unknown", "UnknownFloor"):
        return "Floor not given"
    named = {"Ground": "Ground floor", "Lobby": "Lobby level", "Plaza": "Plaza level", "Concourse": "Concourse level",
             "Basement": "Basement", "LowerLevel": "Lower level", "Mezzanine": "Mezzanine", "Terrace": "Terrace level"}
    if floor_name in named:
        return named[floor_name]
    if number is None:
        return split_camel(floor_name)
    suffix = "th" if 10 <= number % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return f"{number}{suffix} floor"


def yearly(rate: float | None, basis: int | None) -> float | None:
    """Normalize an asking rate to $/SF/year. 0 or missing means 'no rate given' → None."""
    if not rate or rate <= 0:
        return None
    return round(rate * 12, 2) if basis == 1 else round(float(rate), 2)


def norm_suite(s: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper()).lstrip("0")


def collect_tours(attachments: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Matterport tours from an attachment list, de-duplicated by model id."""
    tours: dict[str, dict[str, Any]] = {}
    for a in attachments or []:
        if a.get("videoExternalReferenceType") not in MATTERPORT_REF_TYPES or not a.get("videoKey"):
            continue
        t = tours.setdefault(a["videoKey"], {"model_id": a["videoKey"], "caption": None, "thumb": None})
        if a.get("caption") and not t["caption"]:
            t["caption"] = a["caption"].strip()
        uri = a.get("attachmentUri") or ""
        if uri.endswith((".jpg", ".jpeg", ".png")) and not t["thumb"]:
            t["thumb"] = uri
    return list(tours.values())


def pick_tour(space: dict[str, Any], tours: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Choose the tour that shows this space: by suite number, then by size, then a building tour."""
    if not tours:
        return None
    suite = norm_suite(space.get("suite"))
    sqft = space.get("squareFeetMax") or 0
    for t in tours:
        cap = t.get("caption") or ""
        m = SUITE_IN_CAPTION.search(cap)
        if suite and m and norm_suite(m.group(1)) == suite:
            return {**t, "level": "suite", "matched_by": "suite number"}
    size_hits = []
    for t in tours:
        cap = t.get("caption") or ""
        if APARTMENT_UNIT_CAPTION.search(cap):
            continue
        for m in SQFT_IN_CAPTION.finditer(cap):
            val = float(m.group(1).replace(",", ""))
            if sqft and abs(val - sqft) / sqft <= 0.01:
                size_hits.append(t)
    if len(size_hits) == 1:
        return {**size_hits[0], "level": "suite", "matched_by": "floor area in the tour caption"}
    general = [t for t in tours if not APARTMENT_UNIT_CAPTION.search(t.get("caption") or "")
               and not SUITE_IN_CAPTION.search(t.get("caption") or "")]
    if general:
        lobby = [t for t in general if re.search(r"lobby|exterior|building|entrance", t.get("caption") or "", re.I)]
        return {**(lobby or general)[0], "level": "building", "matched_by": None}
    return {**tours[0], "level": "other", "matched_by": None}


def year_built(prop: dict[str, Any]) -> int | None:
    for ev in prop.get("constructionEvents") or []:
        if decode("ConstructionEventType", ev.get("eventType")) in ("Built", "Completed", "ConstructionComplete", "YearBuilt") and ev.get("year"):
            return int(ev["year"])
    return None


def load_properties() -> tuple[pd.DataFrame, dict[int, list[dict[str, Any]]]]:
    rows, tours_by_prop = [], {}
    for p in read_jsonl("commercial-property.jsonl"):
        addr = p.get("primaryAddress") or {}
        market = addr.get("researchMarketId")
        apt = p.get("propertyApartment") or {}
        retail = p.get("propertyRetail") or {}
        lot = p.get("lotSize") or 0
        lot_sqft = lot * 43560 if p.get("lotSizeMeasurementType") == 2 else lot
        stories = p.get("numStoriesAboveGrade") or 0
        gba = p.get("grossBuildingAreaSquareFeet") or 0
        footprint = p.get("grossTypicalFloorSquareFeet") or (gba / stories if stories else 0)
        frontage = [f for f in retail.get("frontage") or [] if f.get("frontageInFeet")]
        zoning = (p.get("zoningDescription") or "").strip()
        if re.match(r"(none|n/?a\w*|unknown|tbd)\b", zoning, re.I) or not zoning:
            zoning = None
        ptype = decode("PropertyType", p.get("propertyType"))
        rows.append({
            "property_id": p["id"],
            "address": street_address(addr),
            "building_name": (addr.get("buildingName") or (p.get("aliases") or [None])[0] or None),
            "city": addr.get("city"),
            "state": addr.get("state"),
            "zip": (addr.get("postcode") or "")[:5] or None,
            "lat": addr.get("latitude"),
            "lon": addr.get("longitude"),
            "market_id": market,
            "property_type": ptype,
            "building_class": decode("BuildingClass", p.get("buildingClass")) if p.get("buildingClass") else None,
            "year_built": year_built(p),
            "stories": stories or None,
            "gba_sqft": gba or None,
            "lot_sqft": round(lot_sqft) if lot_sqft else None,
            "open_lot_sqft": round(lot_sqft - footprint) if lot_sqft and footprint and lot_sqft > footprint else None,
            "parking_ratio": p.get("parkingRatio") or None,
            "parking_spaces": sum(x.get("totalSpaces") or 0 for x in p.get("parking") or []) or None,
            "zoning": zoning,
            "photo_url": (p.get("primaryPhoto") or {}).get("attachmentUri"),
            "apt_units": apt.get("totalNumUnits") or None,
            "frontage_ft": round(sum(f["frontageInFeet"] for f in frontage)) if frontage else None,
            "frontage_street": next((f.get("streetName") for f in frontage if f.get("isPrimaryFrontage")),
                                    frontage[0].get("streetName") if frontage else None),
        })
        tours_by_prop[p["id"]] = collect_tours(p.get("attachments"))
    return pd.DataFrame(rows), tours_by_prop


def build() -> None:
    BUILT.mkdir(parents=True, exist_ok=True)
    props, tours_by_prop = load_properties()

    # Apartment listings fill unit counts the property record lacks.
    apt_units = {a["propertyId"]: a.get("totalNumUnits") for a in read_jsonl("apartment-listing.jsonl")}
    props["apt_units"] = props.apply(
        lambda r: r["apt_units"] if pd.notna(r["apt_units"]) else apt_units.get(r["property_id"]), axis=1)
    props.to_parquet(BUILT / "properties.parquet", index=False)
    prop_by_id = props.set_index("property_id").to_dict("index")

    now = datetime.now(timezone.utc)
    rows = []
    for lst in read_jsonl("commercial-listing-summary.jsonl"):
        fl = lst.get("forLeaseSummary") or {}
        spaces = fl.get("spaces") or []
        if not spaces or lst.get("listingStatus") != 1:
            continue
        listing_tours = collect_tours(lst.get("attachments"))
        park_props = {p["id"]: p for p in fl.get("properties") or [] if p.get("id")}
        for s in spaces:
            pid = s["propertyId"]
            b = prop_by_id.get(pid)
            in_kit = b is not None
            if not in_kit:
                # Building is outside the kit: fall back to the address the listing itself carries.
                src = park_props.get(pid) or ({"address": lst.get("address")} if pid == lst.get("propertyId") else {})
                a = src.get("address") or s.get("marketingAddress") or {}
                b = {
                    "address": street_address(a), "building_name": a.get("buildingName"), "city": a.get("city"),
                    "state": a.get("state"), "zip": (a.get("postcode") or "")[:5] or None, "lat": a.get("latitude"),
                    "lon": a.get("longitude"), "market_id": STATE_TO_MARKET.get(a.get("state")),
                    "photo_url": (src.get("primaryPhoto") or {}).get("attachmentUri"),
                }
            # A tour belongs to a space only when the property id matches (kit rule: join on id AND videoKey).
            tours = {t["model_id"]: t for t in tours_by_prop.get(pid, [])}
            if pid == lst.get("propertyId"):
                for t in listing_tours:
                    tours.setdefault(t["model_id"], t)
            tour = pick_tour(s, list(tours.values()))

            floor_name = decode("FloorName", s.get("floorName"))
            fnum = floor_number(floor_name)
            notes = " ".join(n["value"].strip() for n in s.get("notes") or [] if n.get("value"))
            notes = re.sub(r"\s+", " ", notes)
            avail = s.get("availableOnDate")
            avail_dt = datetime.fromisoformat(avail) if avail else None
            rate_low, rate_high = yearly(s.get("rateLow"), s.get("rateBasis")), yearly(s.get("rateHigh"), s.get("rateBasis"))
            market_id = b.get("market_id")
            rows.append({
                "space_id": s["id"],
                "listing_id": lst["id"],
                "property_id": pid,
                "in_kit": in_kit,
                "suite": (s.get("suite") or "").strip() or None,
                "floor_name": floor_name,
                "floor_number": fnum,
                "floor_label": floor_label(floor_name, fnum),
                "is_ground": floor_name in GROUND_FLOORS,
                "sqft_min": s.get("squareFeetMin"),
                "sqft_max": s.get("squareFeetMax"),
                "sqft_contiguous": s.get("squareFeetMaxContiguous"),
                "space_use": decode("SpaceUse", s.get("spaceUse")),
                "space_type": decode("SpaceType", s.get("spaceType")),
                "is_sublease": decode("SpaceType", s.get("spaceType")) == "Sublet",
                "rate_low_yr": rate_low,
                "rate_high_yr": rate_high or rate_low,
                "rate_quoted_monthly": s.get("rateBasis") == 1 and rate_low is not None,
                "service_type": split_camel(decode("ServiceType", s.get("serviceType"))),
                "available_now": avail_dt is None or avail_dt <= now,
                "available_date": avail_dt.date().isoformat() if avail_dt and avail_dt > now else None,
                "lease_pending": bool(s.get("isLeasePending")),
                "is_executive_suite": bool(s.get("isExecutiveSuite")),
                "is_full_floor": bool(s.get("isFullFloor")),
                "date_on_market": (s.get("dateOnMarket") or "")[:10] or None,
                "notes": notes[:2500] or None,
                "features": [k for k, rx in NOTE_FEATURES.items() if notes and rx.search(notes)],
                "floorplan_url": (s.get("floorPlan") or {}).get("attachmentUri"),
                "tour_model_id": tour["model_id"] if tour else None,
                "tour_caption": tour.get("caption") if tour else None,
                "tour_level": tour["level"] if tour else None,
                "tour_matched_by": tour.get("matched_by") if tour else None,
                "tour_thumb": tour.get("thumb") if tour else None,
                "building_tours": json.dumps([{"model_id": t["model_id"], "caption": t.get("caption")} for t in tours.values()][:12]),
                "brokerage": lst.get("brokerageCompanyName"),
                "listing_building_name": lst.get("buildingName") if pid == lst.get("propertyId") else None,
                "listing_year_built": lst.get("constructionCompleteYear") if pid == lst.get("propertyId") else None,
                # building join
                "address": b.get("address"), "city": b.get("city"), "state": b.get("state"), "zip": b.get("zip"),
                "lat": b.get("lat"), "lon": b.get("lon"), "market_id": market_id,
                "market": MARKETS[market_id]["key"] if market_id in MARKETS else None,
                "building_name": b.get("building_name"),
                "property_type": b.get("property_type"), "building_class": b.get("building_class"),
                "year_built": b.get("year_built"), "stories": b.get("stories"), "gba_sqft": b.get("gba_sqft"),
                "lot_sqft": b.get("lot_sqft"), "open_lot_sqft": b.get("open_lot_sqft"),
                "parking_ratio": b.get("parking_ratio"), "parking_spaces": b.get("parking_spaces"),
                "zoning": b.get("zoning"), "photo_url": b.get("photo_url"), "apt_units": b.get("apt_units"),
                "frontage_ft": b.get("frontage_ft"), "frontage_street": b.get("frontage_street"),
            })

    df = pd.DataFrame(rows)
    df["building_name"] = df["listing_building_name"].fillna(df["building_name"])
    df["year_built"] = df["year_built"].fillna(df["listing_year_built"])
    df = df.drop(columns=["listing_building_name", "listing_year_built"])
    for col in ("year_built", "stories", "floor_number", "market_id", "parking_spaces", "apt_units", "frontage_ft"):
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
    df.to_parquet(BUILT / "spaces.parquet", index=False)

    # ---- report
    print(f"properties: {len(props):,}  (with Matterport: {sum(1 for v in tours_by_prop.values() if v):,})")
    print(f"spaces: {len(df):,}  in kit buildings: {int(df.in_kit.sum()):,}  with lat/lon: {int(df.lat.notna().sum()):,}")
    print("by market:", df.market.value_counts(dropna=False).to_dict())
    print("by use:", df.space_use.value_counts().to_dict())
    print(f"with asking rent: {int(df.rate_low_yr.notna().sum()):,}  ({int(df.rate_quoted_monthly.sum()):,} were quoted monthly)")
    print(f"available now: {int(df.available_now.sum()):,}  ground floor: {int(df.is_ground.sum()):,}  with notes: {int(df.notes.notna().sum()):,}")
    print("tour level:", df.tour_level.value_counts(dropna=False).to_dict())
    print("tour matched by:", df.tour_matched_by.value_counts().to_dict())
    print(f"floor plan image: {int(df.floorplan_url.notna().sum()):,}")
    feats = pd.Series([f for fs in df.features for f in fs]).value_counts()
    print("note features:", feats.to_dict())
    print("median asking $/SF/yr by market:", df.groupby("market").rate_low_yr.median().round(2).to_dict())


if __name__ == "__main__":
    build()
