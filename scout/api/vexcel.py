"""Vexcel aerial imagery: the outside view (yard, parking, frontage) that an interior scan cannot show.

Uses the v2 ortho extract endpoint with the `urban` layer. Images are cached on disk; the key stays server-side.
"""
from __future__ import annotations

import os

import requests

from .store import CACHE

EXTRACT_URL = "https://api.vexcelgroup.com/v2/ortho/extract"
LAYERS = ("urban", "wide-area")   # sharpest first; wide-area covers what urban misses
ATTRIBUTION = "Aerial imagery © Vexcel Imaging"


class VexcelError(RuntimeError):
    pass


def configured() -> bool:
    return bool(os.environ.get("VEXCEL_API_KEY"))


def get_aerial(property_id: int, lat: float, lon: float, radius_m: int = 70) -> bytes:
    """JPEG of the ground around a point, `radius_m` metres in each direction."""
    radius_m = max(30, min(int(radius_m), 200))
    path = CACHE / "aerial" / f"{int(property_id)}_{radius_m}.jpg"
    if path.exists():
        return path.read_bytes()
    if not configured():
        raise VexcelError("VEXCEL_API_KEY is not set in .env")
    last = "no imagery"
    for layer in LAYERS:
        try:
            r = requests.get(EXTRACT_URL, timeout=60, params={
                "api_key": os.environ["VEXCEL_API_KEY"], "layer": layer,
                "wkt": f"POINT({lon} {lat})", "buffer-meter": radius_m, "zoom": 20})
        except requests.RequestException as e:
            last = f"unreachable ({type(e).__name__})"
            continue
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
            return r.content
        last = f"HTTP {r.status_code}"
    raise VexcelError(f"Vexcel returned {last} for this location")
