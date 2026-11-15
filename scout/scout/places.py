"""Places people search around (schools, airports, parks, neighbourhoods...) and businesses near a listing.

Backed by the one-time OpenStreetMap snapshot in data/places/ (pipeline/fetch_places.py). Lookups are local and
fast; nothing is sent anywhere at query time.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .geo import CITIES, miles

ROOT = Path(__file__).resolve().parent.parent
PLACES_DIR = ROOT / "data" / "places"
SOURCE = "OpenStreetMap contributors"

MAJOR_AIRPORTS = {"IAH", "HOU", "LAX", "BUR", "LGB", "SNA", "ONT"}

Pred = Callable[[dict], bool]


def _tag(key: str, *values: str) -> Pred:
    vs = set(values)
    return lambda r: r.get(key) in vs if vs else key in r


def _any(*preds: Pred) -> Pred:
    return lambda r: any(p(r) for p in preds)


# What a word in a request means as a place to be near. Order matters: first match wins.
ANCHOR_CATEGORIES: dict[str, dict[str, Any]] = {
    "airport": {"label": "airport", "words": r"\b(airports?|airfield)\b",
                "pred": lambda r: r.get("aeroway") == "aerodrome" and r.get("iata") in MAJOR_AIRPORTS},
    "university": {"label": "university or college", "words": r"\b(universit(y|ies)|colleges?|campus(es)?)\b",
                   "pred": _tag("amenity", "university", "college")},
    "preschool": {"label": "preschool or daycare", "words": r"\b(preschools?|pre-k|kindergartens?|day ?cares?|nurser(y|ies))\b",
                  "pred": _tag("amenity", "kindergarten", "childcare")},
    "school": {"label": "school", "words": r"\b(schools?|elementary|middle school|high school)\b", "pred": _tag("amenity", "school")},
    "hospital": {"label": "hospital", "words": r"\b(hospitals?|medical cent(er|re)s?|er)\b", "pred": _tag("amenity", "hospital")},
    "park": {"label": "park", "words": r"\b(parks?|green ?space|trails?)\b", "pred": _tag("leisure", "park")},
    "transit": {"label": "rail or transit station", "words": r"\b(metro|subway|train|rail|light rail|transit|stations?)\b",
                "pred": _any(_tag("railway", "station", "halt"), _tag("public_transport", "station"))},
    "grocery": {"label": "grocery store", "words": r"\b(grocer(y|ies)|supermarkets?)\b", "pred": _tag("shop", "supermarket")},
    "mall": {"label": "mall or department store", "words": r"\b(malls?|shopping cent(er|re)s?|department stores?)\b",
             "pred": _tag("shop", "mall", "department_store")},
    "library": {"label": "library", "words": r"\b(librar(y|ies))\b", "pred": _tag("amenity", "library")},
    "hotel": {"label": "hotel", "words": r"\b(hotels?)\b", "pred": _tag("tourism", "hotel")},
    "gym": {"label": "gym", "words": r"\b(gyms?|fitness)\b", "pred": _tag("leisure", "fitness_centre", "sports_centre")},
    "office": {"label": "offices", "words": r"\b(offices|office district|business district)\b", "pred": _tag("office")},
}
SCHOOL_LEVEL = {"elementary": r"elementary|primary", "middle": r"middle|intermediate|junior high", "high": r"high school|\bhs\b|academy"}
DOWNTOWN_WORDS = r"\b(downtown|city cent(er|re)|cbd|central business district)\b"
STOP = set("a an the near nearby close to by in within of mi mile miles minutes min km around from good best top any my our".split())


@dataclass
class CityPlaces:
    rows: list[dict]
    lat: np.ndarray
    lon: np.ndarray
    _cache: dict[str, np.ndarray] = field(default_factory=dict)

    def mask(self, key: str, pred: Pred) -> np.ndarray:
        if key not in self._cache:
            self._cache[key] = np.array([pred(r) for r in self.rows], dtype=bool) if self.rows else np.zeros(0, bool)
        return self._cache[key]


def city_places(city: str) -> CityPlaces:
    """The snapshot for a city; reloads by itself when the download adds data (file time and part count)."""
    path = PLACES_DIR / f"{city}.json"
    stamp = path.stat().st_mtime if path.exists() else len(list((PLACES_DIR / "_parts").glob(f"{city}_*.json")))
    return _load_city(city, stamp)


@lru_cache(maxsize=8)
def _load_city(city: str, stamp: float) -> CityPlaces:
    path = PLACES_DIR / f"{city}.json"
    if path.exists():
        rows = json.loads(path.read_text(encoding="utf-8"))["places"]
    else:                                   # a download still in progress: use the groups that finished
        seen: dict[str, dict] = {}
        for part in sorted((PLACES_DIR / "_parts").glob(f"{city}_*.json")):
            for r in json.loads(part.read_text(encoding="utf-8")):
                seen[r["id"]] = r
        rows = list(seen.values())
    return CityPlaces(rows=rows, lat=np.array([r["lat"] for r in rows], float), lon=np.array([r["lon"] for r in rows], float))


def available() -> dict[str, int]:
    return {c: len(city_places(c).rows) for c in CITIES}


def category_points(city: str, category: str, name_rx: str | None = None) -> list[dict]:
    cp = city_places(city)
    spec = ANCHOR_CATEGORIES[category]
    m = cp.mask(f"a:{category}", spec["pred"])
    out = [cp.rows[i] for i in np.flatnonzero(m)]
    if name_rx:
        rx = re.compile(name_rx, re.I)
        out = [r for r in out if rx.search(r["name"])]
    return out


def _point(r: dict) -> dict:
    return {"name": r["name"], "lat": r["lat"], "lon": r["lon"], "id": r.get("id"), "iata": r.get("iata")}


def resolve(query: str, city: str, limit: int = 8) -> dict[str, Any]:
    """What a phrase like 'IAH', 'a good elementary school', 'Rice University' or 'downtown' refers to.

    Returns kind 'category' (any place of that type counts: distance = to the nearest one) or 'points' (these
    specific places), with the points found. Never invents a place: an unknown name returns no points.
    """
    raw = (query or "").strip()
    q = raw.lower()
    c = CITIES[city]
    if re.search(DOWNTOWN_WORDS, q):
        lat, lon = c["downtown"]
        return {"query": raw, "kind": "points", "label": f"Downtown {c['name']}", "category": "downtown",
                "points": [{"name": f"Downtown {c['name']}", "lat": lat, "lon": lon, "id": "downtown"}], "source": "city centre"}
    code = re.search(r"\b([A-Z]{3})\b", raw)
    if code and code.group(1) in MAJOR_AIRPORTS:
        pts = [r for r in category_points(city, "airport") if r.get("iata") == code.group(1)]
        if pts:
            return {"query": raw, "kind": "points", "label": f"{pts[0]['name']} ({code.group(1)})", "category": "airport",
                    "points": [_point(r) for r in pts[:1]], "source": SOURCE}
    category = next((k for k, v in ANCHOR_CATEGORIES.items() if re.search(v["words"], q)), None)
    words = [w for w in re.findall(r"[a-z0-9']+", q) if w not in STOP]
    if category:                                     # drop the words that only name the category
        words = [w for w in words if not re.search(ANCHOR_CATEGORIES[category]["words"], w)]
    name_words = [w for w in words if len(w) > 2 and w not in SCHOOL_LEVEL and w not in ("public", "private", "major", "international")]
    cp = city_places(city)
    if name_words:                                   # a named place: match on its words, anchors first
        rx = [re.compile(rf"\b{re.escape(w)}", re.I) for w in name_words]
        pool = [r for r in cp.rows if all(x.search(r["name"]) for x in rx)]
        if category:
            pred = ANCHOR_CATEGORIES[category]["pred"]
            pool = [r for r in pool if pred(r)] or pool
        pool.sort(key=lambda r: (r.get("kind") != "anchors", len(r["name"])))
        if pool:
            label = pool[0]["name"] if len({r["name"] for r in pool}) == 1 or len(pool) == 1 else raw.strip().title()
            return {"query": raw, "kind": "points", "label": label, "category": category or "named",
                    "points": [_point(r) for r in pool[:limit if len({r['name'] for r in pool}) > 1 else 3]], "count": len(pool), "source": SOURCE}
    if category:
        level = next((rx for k, rx in SCHOOL_LEVEL.items() if k in q), None) if category == "school" else None
        pts = category_points(city, category, level)
        label = ANCHOR_CATEGORIES[category]["label"] if not level else f"{next(k for k in SCHOOL_LEVEL if k in q)} school"
        return {"query": raw, "kind": "category", "label": label, "category": category, "level_rx": level,
                "count": len(pts), "points": [_point(r) for r in pts[:limit]], "source": SOURCE}
    return {"query": raw, "kind": "none", "label": raw, "points": [], "count": 0,
            "note": "No place by that name in the map data for this city."}


def anchor_arrays(city: str, anchor: dict) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Every point an anchor stands for (all schools for a 'school' anchor; the named points otherwise)."""
    if anchor.get("kind") == "category":
        pts = category_points(city, anchor["category"], anchor.get("level_rx"))
    else:
        pts = anchor.get("points") or []
    return np.array([p["lat"] for p in pts], float), np.array([p["lon"] for p in pts], float), pts


def distance_to(city: str, anchor: dict, lats: np.ndarray, lons: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Distance from each listing to the nearest point of an anchor, and that point's index."""
    alat, alon, _ = anchor_arrays(city, anchor)
    if len(alat) == 0:
        return np.full(len(lats), np.inf), np.full(len(lats), -1)
    d = miles(lats[:, None], lons[:, None], alat[None, :], alon[None, :])
    idx = np.argmin(d, axis=1)
    return d[np.arange(len(lats)), idx], idx


def has_any(city: str, pred_key: str, pred: Pred) -> bool:
    """Whether the snapshot holds any place of this kind for the city (if not, a count of 0 means 'unknown')."""
    cp = city_places(city)
    return bool(cp.rows) and bool(cp.mask(pred_key, pred).any())


def near(city: str, lat: float, lon: float, pred_key: str, pred: Pred, radius_mi: float) -> list[tuple[float, dict]]:
    """Places matching a predicate within a radius, nearest first."""
    cp = city_places(city)
    if not cp.rows:
        return []
    m = cp.mask(pred_key, pred)
    idx = np.flatnonzero(m)
    if not len(idx):
        return []
    d = miles(lat, lon, cp.lat[idx], cp.lon[idx])
    keep = np.flatnonzero(d <= radius_mi)
    order = keep[np.argsort(d[keep])]
    return [(float(d[i]), cp.rows[idx[i]]) for i in order]


def nearest_of(city: str, lat: float, lon: float, category: str) -> dict | None:
    pts = category_points(city, category)
    if not pts:
        return None
    d = miles(lat, lon, np.array([p["lat"] for p in pts]), np.array([p["lon"] for p in pts]))
    i = int(np.argmin(d))
    return {"name": pts[i]["name"], "miles": round(float(d[i]), 2), "lat": pts[i]["lat"], "lon": pts[i]["lon"]}


def neighbourhood(city: str, lat: float, lon: float) -> str | None:
    """Name of the nearest neighbourhood/suburb node within ~1.5 mi."""
    cp = city_places(city)
    if not cp.rows:
        return None
    m = cp.mask("place", lambda r: r.get("place") in ("suburb", "neighbourhood", "quarter"))
    idx = np.flatnonzero(m)
    if not len(idx):
        return None
    d = miles(lat, lon, cp.lat[idx], cp.lon[idx])
    i = int(np.argmin(d))
    return cp.rows[idx[i]]["name"] if d[i] <= 1.5 else None
