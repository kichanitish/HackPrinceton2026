"""The brief: what the user's place must be, written by the agent and editable by the user.

Two shapes, one per mode. Places to be near are anchors: a resolved place (or kind of place) plus a radius.
Every change after the first version is recorded as an adjustment, so the agent can widen a search but never
silently: the page shows what changed.
"""
from __future__ import annotations

import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from . import places
from .geo import CITIES, city_key
from .profiles import PROFILES, match_profile


class Anchor(BaseModel):
    query: str
    label: str
    kind: Literal["category", "points"]
    category: Optional[str] = None
    level_rx: Optional[str] = None
    points: list[dict] = Field(default_factory=list)
    count: int = 0
    radius_mi: float = 3.0


class Brief(BaseModel):
    mode: Literal["home", "commercial"]
    city: Literal["houston", "los_angeles"]
    anchors: list[Anchor] = Field(default_factory=list)
    zips: list[str] = Field(default_factory=list)
    # home
    beds: Optional[int] = None              # exact; 3 means 3+
    baths_min: Optional[float] = None
    budget_max: Optional[int] = None        # $/month
    sqft_min: Optional[int] = None
    pets: Optional[Literal["dog", "cat"]] = None
    parking: bool = False
    # commercial
    business: Optional[str] = None          # profile key
    business_label: Optional[str] = None    # the user's own words ("bakery")
    sqft_max: Optional[int] = None
    space_uses: list[str] = Field(default_factory=list)
    ground_floor: bool = False
    must_have: list[str] = Field(default_factory=list)   # e.g. kitchen, parking
    adjustments: list[dict] = Field(default_factory=list)
    locked: list[str] = Field(default_factory=list)       # fields the user set by hand

    def chips(self) -> list[dict[str, str]]:
        """The brief as labelled values for the page."""
        c = CITIES[self.city]["name"]
        out = [{"k": "city", "label": "Where", "value": c}]
        if self.mode == "home":
            out += [{"k": "beds", "label": "Bedrooms", "value": "Any" if self.beds is None else "Studio" if self.beds == 0 else f"{self.beds}{'+' if self.beds >= 3 else ''}"},
                    {"k": "baths_min", "label": "Bathrooms", "value": "Any" if not self.baths_min else f"{self.baths_min:g}+"},
                    {"k": "budget_max", "label": "Budget", "value": "Any" if not self.budget_max else f"Up to ${self.budget_max:,}/mo"}]
            if self.sqft_min:
                out.append({"k": "sqft_min", "label": "Size", "value": f"{self.sqft_min:,}+ sq ft"})
        else:
            out += [{"k": "business", "label": "Business", "value": (self.business_label or PROFILES[self.business or 'retail']['label']).capitalize()},
                    {"k": "size", "label": "Size", "value": f"{self.sqft_min or 0:,}–{self.sqft_max:,} sq ft" if self.sqft_max else "Any"},
                    {"k": "budget_max", "label": "Budget", "value": "Any" if not self.budget_max else f"Up to ${self.budget_max:,}/mo"},
                    {"k": "space_uses", "label": "Space", "value": ", ".join(USE_WORDS.get(u, u) for u in self.space_uses) or "Any"}]
        for a in self.anchors:
            out.append({"k": f"anchor:{a.query}", "label": "Near", "value": f"≤ {a.radius_mi:g} mi of {a.label}"})
        if self.zips:
            out.append({"k": "zips", "label": "ZIP", "value": ", ".join(self.zips)})
        flags = []
        if self.mode == "home":
            if self.pets:
                flags.append(f"{self.pets.capitalize()} allowed")
            if self.parking:
                flags.append("Parking")
        else:
            if self.ground_floor:
                flags.append("Ground floor")
            flags += [m.capitalize() for m in self.must_have]
        for f in flags:
            out.append({"k": f"flag:{f}", "label": "Must", "value": f})
        return out


USE_WORDS = {"Retail": "Retail", "OfficeRetail": "Office/retail", "Office": "Office", "OfficeMedical": "Medical office",
             "Medical": "Medical", "Flex": "Flex", "Industrial": "Industrial"}


def resolve_anchor(city: str, place: str, radius_mi: float) -> Anchor | dict:
    r = places.resolve(place, city)
    if r["kind"] == "none" or not r.get("points") and r["kind"] != "category":
        return {"error": f"Couldn't find '{place}' in {CITIES[city]['name']} map data. Try a more common name or a kind of place."}
    if r["kind"] == "category" and not r.get("count"):
        return {"error": f"No {r['label']} found in {CITIES[city]['name']} map data."}
    return Anchor(query=place, label=r["label"], kind=r["kind"], category=r.get("category"), level_rx=r.get("level_rx"),
                  points=r["points"], count=r.get("count") or len(r["points"]), radius_mi=max(0.25, min(float(radius_mi), 40)))


# ------------------------------------------------------------------ no-AI fallback: read the request with patterns
NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "studio": 0}

HOME_STRONG = r"\b(\d|one|two|three|four)[\s-]*(bed|bd|br|bedroom)s?\b|\bbath(room)?s?\b|\bapartments?\b|\bapt\b|\bcondo\b|\btownho(me|use)\b|\bhouse\b|\bhome\b|\bto live\b|\blive in\b|\broommates?\b|\bmy (family|kids|wife|husband|partner)\b|\bstudio (apartment|apt)\b"
HOME_WEAK = r"\bstudio\b|\bpet[- ]friendly\b|\bdogs?\b|\bcats?\b|\bmove (to|into)\b|\brelocat"
BUSINESS = (r"\bbusiness\b|\bshop\b|\bstore(front)?\b|\boffice\b|\bretail\b|\bcommercial\b|\blease (a )?space\b|\btenants?\b|\bopen(ing)? (a|an|my)\b"
            r"|\bcustomers?\b|\bfoot traffic\b|\bstartup\b|\bwarehouse\b|\bsq ?ft for\b|\bfranchise\b")
BUSINESS_TYPES = ("cafe", "bakery", "restaurant", "bar", "gym", "salon", "clinic", "pharmacy", "daycare", "grocery", "laundry")


def classify_mode(text: str) -> str:
    """Home to live in, or space for a business? Used when no model is available (the agent decides otherwise)."""
    t = (text or "").lower()
    # what follows 'near / close to / within 3 miles of' says where, not what: leave it out of the vote
    t = re.sub(r"\b(near|close to|next to|around|walking distance (to|from)|within\s+[\d.]+\s*(mi|miles?|km|minutes?)\s+(of|from))\b[^,.;]*", " ", t)
    home = 2 * len(re.findall(HOME_STRONG, t)) + len(re.findall(HOME_WEAK, t))
    biz = 2 * len(re.findall(BUSINESS, t)) + 2 * sum(1 for k in BUSINESS_TYPES if re.search(PROFILES[k]["words"], t))
    return "commercial" if biz > home else "home"


def _money(s: str) -> int | None:
    m = re.search(r"\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\b", s, re.I)
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    return int(v * 1000) if m.group(2) else int(v)


def parse_request(text: str, mode: str, city_hint: str | None = None) -> dict[str, Any]:
    """A best-effort brief from the sentence alone (used when no model is configured)."""
    t = " " + (text or "").lower() + " "
    city = city_key(t) or city_hint or "houston"
    out: dict[str, Any] = {"mode": mode, "city": city, "anchors": []}
    m = re.search(r"(?:under|below|max(?:imum)?|up to|budget(?: of)?|less than|<)\s*(\$?\s?\d[\d,.]*\s*k?)", t)
    if m:
        out["budget_max"] = _money(m.group(1))
    if mode == "home":
        m = re.search(r"\b(\d|one|two|three|four|five)[\s-]*(?:bed|bd|br|bedroom)", t) or re.search(r"\b(studio)\b", t)
        if m:
            g = m.group(1)
            out["beds"] = min(3, int(g) if g.isdigit() else NUM[g])      # "studio" → 0, "two" → 2
        m = re.search(r"\b(\d(?:\.5)?)[\s-]*(?:bath|ba\b|bathroom)", t)
        if m:
            out["baths_min"] = float(m.group(1))
        if re.search(r"\bdogs?\b|puppy", t):
            out["pets"] = "dog"
        elif re.search(r"\bcats?\b|kitten", t):
            out["pets"] = "cat"
        out["parking"] = bool(re.search(r"parking|garage|car\b", t))
    else:
        key = match_profile(t)
        p = PROFILES[key]
        words = re.search(p["words"], t)
        out.update(business=key, business_label=(words.group(0).strip() if words else p["label"]).lower(),
                   space_uses=list(p["uses"]), sqft_min=p["size"][0], sqft_max=p["size"][1])
        m = re.search(r"(\d[\d,]{2,})\s*(?:-|to|–)\s*(\d[\d,]{2,})\s*(?:sq|sf|square)", t)
        if m:
            out["sqft_min"], out["sqft_max"] = int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))
        else:
            m = re.search(r"(\d[\d,]{2,})\s*(?:sq|sf|square)", t)
            if m:
                v = int(m.group(1).replace(",", ""))
                out["sqft_min"], out["sqft_max"] = int(v * 0.8), int(v * 1.25)
        out["ground_floor"] = bool(re.search(r"ground|street[- ]level|storefront|walk-?in|foot traffic", t)) or key in ("cafe", "bakery", "restaurant", "retail", "salon")
        must = []
        if re.search(r"kitchen|hood|grease", t):
            must.append("kitchen")
        if re.search(r"parking", t):
            must.append("parking")
        out["must_have"] = must
    # places: "within 3 miles of X", "near X", "close to X", "downtown"
    for m in re.finditer(r"(?:within|under|less than)\s*(\d+(?:\.\d+)?)\s*(?:mi|miles?)\s*(?:of|from)\s+([a-z0-9' .&-]+?)(?=,| and | with | under | for |\.|$| in )", t):
        out["anchors"].append({"place": m.group(2).strip(), "radius_mi": float(m.group(1))})
    for m in re.finditer(r"(?:near|close to|next to|by|around)\s+(?:an?\s+|the\s+)?([a-z0-9' .&-]+?)(?=,| and | with | under | for |\.|$| in )", t):
        place = m.group(1).strip()
        if place and not any(place in a["place"] or a["place"] in place for a in out["anchors"]) and not re.match(r"^\d", place):
            out["anchors"].append({"place": place, "radius_mi": 2.0 if mode == "commercial" else 3.0})
    if re.search(places.DOWNTOWN_WORDS, t) and not any("downtown" in a["place"] for a in out["anchors"]):
        out["anchors"].append({"place": "downtown", "radius_mi": 2.0})
    zips = re.findall(r"\b(77\d{3}|9[01]\d{3})\b", t)
    if zips:
        out["zips"] = sorted(set(zips))
    return out
