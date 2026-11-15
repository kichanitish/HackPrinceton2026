"""Shared helpers for the pipeline: paths, JSONL reading, enum decoding, geo math, business classification."""
from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "data" / "costar-kit"
KIT_DATA = KIT / "data"
BUILT = ROOT / "data" / "built"

MARKETS: dict[int, dict[str, str]] = {
    14: {"key": "houston", "name": "Houston", "state": "TX", "state_name": "Texas"},
    20: {"key": "los_angeles", "name": "Los Angeles", "state": "CA", "state_name": "California"},
}
STATE_TO_MARKET = {"TX": 14, "CA": 20}

EARTH_RADIUS_MI = 3958.7613


def read_jsonl(name: str) -> Iterator[dict[str, Any]]:
    """Yield one record per line from data/costar-kit/data/<name>."""
    with open(KIT_DATA / name, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


@lru_cache(maxsize=1)
def enums() -> dict[str, dict[str, str]]:
    return json.loads((KIT / "schemas" / "enums.json").read_text(encoding="utf-8"))


def decode(enum_name: str, value: Any) -> str:
    """Integer enum → its name ('Unknown' when missing)."""
    if value is None:
        return "Unknown"
    return enums().get(enum_name, {}).get(str(value), str(value))


def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(a))


def street_address(addr: dict[str, Any] | None) -> str:
    """'3330 Audley St' from a kit address object."""
    if not addr:
        return ""
    parts = [addr.get("streetNumber"), addr.get("streetPreDirection"), addr.get("streetName"),
             addr.get("streetType"), addr.get("streetPostDirection")]
    return " ".join(str(p).strip() for p in parts if p and str(p).strip())


def split_camel(name: str) -> str:
    """'OfficeMedical' → 'Office Medical'."""
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)


# ---------------------------------------------------------------------------
# Business classification from a tenant's name.
#
# The kit's occupancy.industryType is Unknown on nearly every record, so names are the
# signal (CLAUDE.md "Benchmarks"). Patterns are deliberately tight: a missed tenant costs
# little, a wrong one pollutes "a café operated here before".
# ---------------------------------------------------------------------------
_EXCLUDE_ANY = re.compile(
    r"\b(llc holdings|holdings|capital|investments?|properties|realty|real estate|management|consult\w*|"
    r"staffing|insurance|billing|supply|supplies|equipment|distribut\w*|wholesale|software|logistics|"
    r"law|attorney|association|foundation|ministr\w*|church|construction|architect\w*|travel|marketing|"
    r"council|tenant|institute|education|university|magazine|media|records)\b"
)

BUSINESS_PATTERNS: dict[str, re.Pattern[str]] = {
    "daycare": re.compile(
        r"\b(day ?care|child ?care|preschool|pre-school|montessori|kindercare|primrose school|goddard school|"
        r"nursery school|kids r kids|childtime|la petite academy|early (learning|childhood)|"
        r"children'?s (learning|academy)|learning (center|academy) for (kids|children)|head start)\b"
    ),
    "clinic": re.compile(
        r"\b(clinic|dental|dentist\w*|orthodont\w*|endodont\w*|periodont\w*|pediatrics?|physicians?|urgent care|"
        r"family (practice|medicine)|dermatolog\w*|chiropract\w*|physical therapy|optometr\w*|eye ?care|"
        r"cardiolog\w*|oncolog\w*|m\.?d\.?|d\.?d\.?s\.?|d\.?m\.?d\.?|medical (group|center|associates|clinic|office|practice)|"
        r"radiology|imaging center|surgery center|surgical (associates|center)|ob/?gyn|women'?s health|"
        r"internal medicine|podiatr\w*|orthop(a)?edic\w*|psychiatr\w*|health center|primary care|"
        r"med ?spa|plastic surgery|gastroenterolog\w*|urolog\w*|neurolog\w*|ent associates|dialysis)\b"
    ),
    "gym": re.compile(
        r"\b(gym|fitness|crossfit|pilates|yoga|orangetheory|equinox|barre|soulcycle|f45|boxing|kickboxing|"
        r"martial arts|jiu[- ]?jitsu|karate|taekwondo|athletic club|health club|personal training|"
        r"spin studio|cycle ?bar|pure barre|club pilates|9round|title boxing|strength (lab|studio|training))\b"
    ),
    "cafe": re.compile(
        r"\b(coffee|caf[eé]|espresso|starbucks|roasters?|roastery|boba|tea (house|bar|room|shop)|"
        r"bakery|donuts?|doughnuts?|bagels?|juice|smoothie\w*|creamery|gelato|ice cream|patisserie)\b"
    ),
    "restaurant": re.compile(
        r"\b(restaurant\w*|grill\w*|pizza|pizzeria|taqueria|tacos?|burgers?|bbq|barbecue|sushi|ramen|bistro|diner|"
        r"steakhouse|cantina|eatery|deli|delicatessen|noodles?|wings|seafood|pho|trattoria|brasserie|tavern|"
        r"gastropub|kitchen(?! (and|&|\+) bath)(?! cabinets?)(?! design)|cocina|brewery|brewing|taproom|"
        r"subway|chipotle|mcdonald'?s|wendy'?s|chick-fil-a|taco bell|kfc|popeyes|domino'?s|papa john'?s|"
        r"panda express|jimmy john'?s|whataburger|jack in the box|in-n-out|panera|ihop|denny'?s|"
        r"jersey mike'?s|five guys|shake shack|sweetgreen|cava|chili'?s|applebee'?s|olive garden|poke)\b"
    ),
}

# Order matters: the first match wins.
BUSINESS_ORDER = ["daycare", "clinic", "gym", "cafe", "restaurant"]
FOOD_TYPES = {"cafe", "restaurant"}

_HOTEL = re.compile(r"\b(hotel|inn|suites|motel|resort|lodg\w+|marriott|hilton|hyatt|sheraton|westin|hostel)\b")


def classify_business(name: str | None) -> str | None:
    """Return 'cafe' | 'restaurant' | 'gym' | 'clinic' | 'daycare' or None, from the tenant name alone."""
    if not name:
        return None
    n = name.lower()
    if _EXCLUDE_ANY.search(n):
        return None
    for key in BUSINESS_ORDER:
        if BUSINESS_PATTERNS[key].search(n):
            if key in FOOD_TYPES and re.search(r"\b(massage|spa|salon|nails?)\b", n):
                continue
            return key
    return None


def is_food_industry(name: str | None, industry_type: int | None) -> bool:
    """Kit industry 17 = AccommodationAndFoodServices; drop the accommodation half by name."""
    return industry_type == 17 and not _HOTEL.search((name or "").lower())


# Build-out types recorded on past tenancies (location-occupancy spaces[].buildOut).
BUILDOUT_TO_BUSINESS: dict[str, str] = {
    "RestaurantsAndCafes": "food",
    "FastFood": "food",
    "QuickService": "food",
    "BarOrNightclub": "food",
    "StandardMedical": "clinic",
    "Dental": "clinic",
    "PhysicalTherapy": "clinic",
    "Healthcare": "clinic",
}
