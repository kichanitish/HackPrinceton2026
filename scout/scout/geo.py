"""Distances on the ground. Straight-line miles (not drive time), vectorised with numpy."""
from __future__ import annotations

import numpy as np

EARTH_MI = 3958.8

CITIES = {
    "houston": {"key": "houston", "name": "Houston", "state": "TX", "center": (29.7604, -95.3698),
                "downtown": (29.7589, -95.3677), "bbox": (29.45, -95.90, 30.15, -94.95)},
    "los_angeles": {"key": "los_angeles", "name": "Los Angeles", "state": "CA", "center": (34.0522, -118.2437),
                    "downtown": (34.0505, -118.2551), "bbox": (33.65, -118.75, 34.35, -117.85)},
}


def miles(lat1, lon1, lat2, lon2):
    """Haversine miles; any argument may be a numpy array (broadcasts)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_MI * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def nearest(lat: float, lon: float, lats: np.ndarray, lons: np.ndarray) -> tuple[int, float]:
    """Index and distance of the nearest point, or (-1, inf) when there are none."""
    if len(lats) == 0:
        return -1, float("inf")
    d = miles(lat, lon, lats, lons)
    i = int(np.argmin(d))
    return i, float(d[i])


def city_of(lat: float, lon: float) -> str | None:
    for key, c in CITIES.items():
        s, w, n, e = c["bbox"]
        if s <= lat <= n and w <= lon <= e:
            return key
    return None


def city_key(text: str | None) -> str | None:
    t = (text or "").lower()
    if any(w in t for w in ("los angeles", " la", "l.a", "la ", "socal", "california", "santa monica", "hollywood", "pasadena")) or t == "la":
        return "los_angeles"
    if any(w in t for w in ("houston", "texas", "htx", " tx")):
        return "houston"
    return None
