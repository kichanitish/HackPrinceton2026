"""Matterport Model API (GraphQL): what the scan measured — floor area, rooms, wall outlines, floor-plan images.

Geometry is cached on disk (it never changes); floor-plan image URLs are signed and short-lived, so they are
fetched fresh and kept in memory briefly. Credentials come from .env and are never logged.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
from typing import Any

import requests

from .store import CACHE

URL = "https://api.matterport.com/api/models/graph"
M_TO_FT = 3.28084
MODEL_ID = re.compile(r"^[A-Za-z0-9]{6,20}$")
_PLAN_TTL = 20 * 60
_plans: dict[str, tuple[float, list[dict[str, Any]]]] = {}

SCAN_QUERY = """query($id: ID!) { model(id: $id) {
  id name
  dimensions { areaFloor areaFloorIndoor units }
  floors { id label sequence dimensions { areaFloor units } }
  rooms {
    id label tags
    floor { id }
    dimensions { areaFloor width depth height units }
    boundary { edges { type vertices { position { x y } } } }
    locations { id position { x y z } }
  }
}}"""
PLAN_QUERY = """query($id: ID!) { model(id: $id) { assets { floorplans { format flags url width height } } } }"""


class MatterportError(RuntimeError):
    pass


def configured() -> bool:
    return bool(os.environ.get("MATTERPORT_API_KEY") and os.environ.get("MATTERPORT_API_TOKEN"))


def _gql(query: str, model_id: str) -> dict[str, Any]:
    if not configured():
        raise MatterportError("Matterport API credentials are not set in .env")
    try:
        r = requests.post(URL, auth=(os.environ["MATTERPORT_API_KEY"], os.environ["MATTERPORT_API_TOKEN"]),
                          json={"query": query, "variables": {"id": model_id}}, timeout=30)
    except requests.RequestException as e:
        raise MatterportError(f"Matterport API unreachable ({type(e).__name__})") from None
    if r.status_code != 200:
        raise MatterportError(f"Matterport API returned HTTP {r.status_code}")
    body = r.json()
    model = (body.get("data") or {}).get("model")
    if not model:
        msg = "; ".join(e.get("message", "") for e in body.get("errors") or []) or "model not found"
        raise MatterportError(msg[:300])
    return model


def _chain(segments: list[tuple[tuple[float, float], tuple[float, float]]]) -> list[list[float]] | None:
    """Join wall segments end to end into one closed outline. None when they do not form a single loop."""
    if len(segments) < 3:
        return None
    key = lambda p: (round(p[0], 2), round(p[1], 2))
    adj: dict[tuple[float, float], list[tuple[float, float]]] = {}
    for a, b in segments:
        if key(a) != key(b):
            adj.setdefault(key(a), []).append(key(b))
            adj.setdefault(key(b), []).append(key(a))
    # Scans often carry stub walls that jut into a room; trim those dead ends before tracing the loop.
    while True:
        stubs = [p for p, nbrs in adj.items() if len(nbrs) == 1]
        if not stubs:
            break
        for p in stubs:
            for q in adj.pop(p, []):
                if q in adj and p in adj[q]:
                    adj[q].remove(p)
        adj = {p: nbrs for p, nbrs in adj.items() if nbrs}
    if len(adj) < 3 or any(len(v) != 2 for v in adj.values()):
        return None
    start = next(iter(adj))
    loop, prev, cur = [start], None, start
    while True:
        nxt = next((p for p in adj[cur] if p != prev), None)
        if nxt is None or nxt == start:
            break
        loop.append(nxt)
        prev, cur = cur, nxt
        if len(loop) > len(adj):
            return None
    return [[x, y] for x, y in loop] if len(loop) == len(adj) else None


def _polygon_area(pts: list[list[float]]) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2


def _min_rect(pts: list[list[float]]) -> tuple[float, float]:
    """Width and depth of the smallest rectangle around the outline (tried at every wall's angle)."""
    best: tuple[float, float, float] | None = None
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        ang = math.atan2(y2 - y1, x2 - x1)
        c, s = math.cos(-ang), math.sin(-ang)
        xs = [x * c - y * s for x, y in pts]
        ys = [x * s + y * c for x, y in pts]
        w, d = max(xs) - min(xs), max(ys) - min(ys)
        if best is None or w * d < best[0]:
            best = (w * d, w, d)
    return (best[1], best[2]) if best else (0.0, 0.0)


def _shape_room(room: dict[str, Any]) -> dict[str, Any]:
    dims = room.get("dimensions") or {}
    metric = dims.get("units") == "metric"
    to_ft, to_sqft = (M_TO_FT if metric else 1.0), (M_TO_FT ** 2 if metric else 1.0)
    segments = []
    for e in (room.get("boundary") or {}).get("edges") or []:
        v = e.get("vertices") or []
        if len(v) == 2:
            a, b = v[0]["position"], v[1]["position"]
            segments.append(((a["x"] * M_TO_FT, a["y"] * M_TO_FT), (b["x"] * M_TO_FT, b["y"] * M_TO_FT)))
    xs = [p[0] for s in segments for p in s]
    ys = [p[1] for s in segments for p in s]
    locations = [{"id": l["id"], **l["position"]} for l in room.get("locations") or [] if l.get("position")]
    outline = _chain(segments)
    area = round(dims["areaFloor"] * to_sqft, 1) if dims.get("areaFloor") else None
    width = round(dims["width"] * to_ft, 1) if dims.get("width") else None
    depth = round(dims["depth"] * to_ft, 1) if dims.get("depth") else None
    measured_by = "scan dimensions" if area else None
    if outline and len(outline) >= 3:
        # Matterport reports dimensions for only some rooms; the scanned wall outline gives the rest.
        if not area:
            area, measured_by = round(_polygon_area(outline), 1), "scanned wall outline"
        if not (width and depth):
            w, d = _min_rect(outline)
            width, depth = round(min(w, d), 1), round(max(w, d), 1)
            measured_by = measured_by if measured_by == "scanned wall outline" else "scan area + wall outline"
    return {
        "id": room["id"],
        "label": (room.get("label") or "").strip() or None,
        "tags": room.get("tags") or [],
        "floor_id": (room.get("floor") or {}).get("id"),
        "area_sqft": area,
        "width_ft": width,
        "depth_ft": depth,
        "height_ft": round(dims["height"] * to_ft, 1) if dims.get("height") else None,
        "measured_by": measured_by,
        "walls": [[round(a[0], 2), round(a[1], 2), round(b[0], 2), round(b[1], 2)] for a, b in segments],
        "outline": [[round(x, 2), round(y, 2)] for x, y in (outline or [])] or None,
        "center": [round(sum(xs) / len(xs), 2), round(sum(ys) / len(ys), 2)] if xs else None,
        "locations": locations,   # scan positions inside the room, in model coordinates (metres)
    }


def get_scan(model_id: str) -> dict[str, Any]:
    """Measured geometry of one Matterport model. Cached on disk after the first call."""
    if not MODEL_ID.match(model_id):
        raise MatterportError("invalid model id")
    path = CACHE / "scans-v3" / f"{model_id}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    model = _gql(SCAN_QUERY, model_id)
    dims = model.get("dimensions") or {}
    to_sqft = M_TO_FT ** 2 if dims.get("units") == "metric" else 1.0
    floors = sorted(model.get("floors") or [], key=lambda f: f.get("sequence") or 0)
    scan = {
        "model_id": model["id"],
        "name": (model.get("name") or "").strip(),
        "area_sqft": round(dims["areaFloor"] * to_sqft) if dims.get("areaFloor") else None,
        "floors": [{"id": f["id"], "label": f.get("label"),
                    "area_sqft": round(f["dimensions"]["areaFloor"] * to_sqft) if (f.get("dimensions") or {}).get("areaFloor") else None}
                   for f in floors],
        "rooms": [_shape_room(r) for r in model.get("rooms") or []],
    }
    scan["rooms_measured"] = sum(1 for r in scan["rooms"] if r["area_sqft"])
    scan["rooms_unmeasured"] = sum(1 for r in scan["rooms"] if not r["area_sqft"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(scan), encoding="utf-8")
    return scan


def get_floorplans(model_id: str) -> list[dict[str, Any]]:
    """Signed floor-plan image URLs (they expire, so they are not written to disk)."""
    if not MODEL_ID.match(model_id):
        raise MatterportError("invalid model id")
    hit = _plans.get(model_id)
    if hit and time.time() - hit[0] < _PLAN_TTL:
        return hit[1]
    model = _gql(PLAN_QUERY, model_id)
    plans = [{"format": p.get("format"), "flags": p.get("flags") or [], "url": p["url"], "width": p.get("width"), "height": p.get("height")}
             for p in ((model.get("assets") or {}).get("floorplans") or []) if p.get("url")]
    _plans[model_id] = (time.time(), plans)
    return plans
