"""Scout web server. Run: python -m uvicorn scout.main:app --port 8000"""
from __future__ import annotations

import json
import os
from io import BytesIO
from pathlib import Path
from typing import Any, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

import logging  # noqa: E402
import time  # noqa: E402

(ROOT / "logs").mkdir(exist_ok=True)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                    handlers=[logging.FileHandler(ROOT / "logs" / "scout.log", encoding="utf-8"), logging.StreamHandler()])
for noisy in ("httpx", "httpcore", "openai", "urllib3"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("scout.server")

from api import llm, vexcel  # noqa: E402  (after load_dotenv)
from api.store import CACHE  # noqa: E402
from . import insights, places  # noqa: E402
from .agent import run_search  # noqa: E402
from .brief import Brief, resolve_anchor  # noqa: E402
from .data import get_data  # noqa: E402
from .geo import CITIES, city_of  # noqa: E402
from .search import home_card, plan_matches, space_card, take_sqft  # noqa: E402

app = FastAPI(title="Scout")
WEB = ROOT / "scout_web"


@app.on_event("startup")
def warm() -> None:
    """Load the data and the map snapshot in the background, so the page answers at once and the first search is fast."""
    import threading

    def load() -> None:
        get_data()
        for c in CITIES:
            places.city_places(c)
    threading.Thread(target=load, daemon=True).start()

EXAMPLES = {
    "home": ["2-bed with parking within 3 miles of an elementary school in Houston, under $2,200",
             "Pet-friendly 1-bed near downtown Los Angeles under $3,000",
             "3 bedrooms within 15 miles of IAH airport, dogs allowed",
             "Studio close to Rice University under $1,600"],
    "commercial": ["Coffee shop downtown Houston, near offices, under $4,000 a month",
                   "Bakery in Los Angeles, around 1,500 sq ft, ground floor",
                   "Dental clinic in Houston within 3 miles of the Texas Medical Center",
                   "Boutique gym in Los Angeles near apartments"],
}
EXAMPLES["all"] = [EXAMPLES["home"][0], EXAMPLES["commercial"][0], EXAMPLES["home"][2], EXAMPLES["commercial"][1],
                   EXAMPLES["home"][1], EXAMPLES["commercial"][2]]


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    d = get_data()
    spec = llm.model_spec()
    return {"counts": {"homes": len(d.homes), "plans": sum(len(h.get("plans") or []) for h in d.homes), "spaces": len(d.spaces),
                       "places": places.available()},
            "examples": EXAMPLES, "snapshot": d.snapshot,
            "agent": {"framework": "LangChain DeepAgents", "model": spec["model"], "provider": spec["provider"]} if spec else None,
            "google_embed": bool(os.environ.get("GOOGLE_MAPS_EMBED_KEY")), "vexcel": vexcel.configured()}


@app.get("/api/config")
def config() -> dict[str, Any]:
    # A browser key restricted to the Maps Embed API, delivered on purpose (like HomeFit). No server secret here.
    return {"google_embed_key": os.environ.get("GOOGLE_MAPS_EMBED_KEY") or None}


class PlaceEdit(BaseModel):
    place: str
    radius_mi: float = 3.0


class RunRequest(BaseModel):
    mode: Optional[Literal["home", "commercial"]] = None    # None: the agent works it out from the request
    query: str = ""
    brief: Optional[dict] = None           # the user's edited brief; `locked` lists the fields they changed
    places: Optional[list[PlaceEdit]] = None


@app.post("/api/run")
def run(req: RunRequest) -> StreamingResponse:
    if not req.query.strip() and not req.brief:
        raise HTTPException(400, "Tell us what you're looking for.")
    brief = None
    if req.brief:
        data = {**req.brief, "mode": req.mode or req.brief.get("mode"), "adjustments": []}
        if req.places is not None:          # places come back as words + radius; resolve them again
            anchors, missing = [], []
            for p in req.places:
                a = resolve_anchor(data.get("city") or "houston", p.place, p.radius_mi)
                (missing.append(a["error"]) if isinstance(a, dict) else anchors.append(a.model_dump()))
            if missing:
                raise HTTPException(400, missing[0])
            data["anchors"] = anchors
        try:
            brief = Brief(**data)
        except Exception as e:
            raise HTTPException(400, f"Brief is invalid: {str(e)[:200]}")

    def events():
        t0, n, last = time.time(), 0, "none"
        log.info("run start mode=%s brief=%s query=%r", req.mode, bool(brief), req.query[:80])
        try:
            for ev in run_search(req.mode, req.query, brief):
                n += 1
                last = ev.get("type")
                if last in ("start", "top", "fallback", "done", "error"):
                    log.info("run event %s +%.1fs%s", last, time.time() - t0, f" reason={ev.get('reason')}" if last == "fallback" else "")
                yield f"data: {json.dumps(ev, default=str)}\n\n"
        except GeneratorExit:       # the browser went away mid-stream
            log.warning("run client disconnected after %d events (last=%s) +%.1fs", n, last, time.time() - t0)
            raise
        except Exception as e:      # last resort: the stream always ends with a message the page can show
            log.exception("run failed after %d events (last=%s)", n, last)
            yield f"data: {json.dumps({'type': 'error', 'text': f'Search failed ({type(e).__name__}).'})}\n\n"
        else:
            log.info("run end %d events (last=%s) +%.1fs", n, last, time.time() - t0)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ListingRequest(BaseModel):
    mode: Literal["home", "commercial"]
    id: int
    brief: dict


@app.post("/api/listing")
def listing(req: ListingRequest) -> dict[str, Any]:
    """Card and context for any listing, for the details dialog (top 10 picks beyond the deep dives, too)."""
    try:
        b = Brief(**{**req.brief, "mode": req.mode})
    except Exception as e:
        raise HTTPException(400, f"Brief is invalid: {str(e)[:200]}")
    d = get_data()
    if req.mode == "home":
        h = d.home_by_id.get(req.id)
        if not h:
            raise HTTPException(404, "No such home.")
        plans = sorted([p for p in h.get("plans") or [] if plan_matches(h, p, b)] or
                       [p for p in h.get("plans") or [] if (p.get("rentMin") or 0) > 0], key=lambda p: p["rentMin"])
        card = home_card(h, plans[0], len(plans), {}) if plans else None
        return {"card": card, "context": insights.home_context(req.id, b)}
    s = d.space_by_id.get(req.id)
    if not s:
        raise HTTPException(404, "No such space.")
    take = take_sqft(s, b.sqft_min, b.sqft_max)
    return {"card": space_card(s, take, {}, {}, None), "context": insights.space_context(req.id, b)}


@app.get("/api/aerial/{key}.jpg")
def aerial(key: int, lat: float, lon: float, r: int = Query(60, ge=30, le=200), w: Optional[int] = Query(None, ge=120, le=1600)) -> Response:
    """Vexcel aerial around a listing. `w` returns a resized copy (cached) for cards."""
    if city_of(lat, lon) is None:
        raise HTTPException(400, "Outside Houston and Los Angeles.")
    try:
        image = vexcel.get_aerial(key, lat, lon, r)
    except vexcel.VexcelError as e:
        raise HTTPException(502, str(e))
    if w:
        thumb = CACHE / "aerial" / f"{key}_{r}_w{w}.jpg"
        if not thumb.exists():
            from PIL import Image
            im = Image.open(BytesIO(image)).convert("RGB")
            im.thumbnail((w, w))
            im.save(thumb, "JPEG", quality=82, optimize=True)
        image = thumb.read_bytes()
    return Response(image, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory=WEB), name="static")
app.mount("/vendor", StaticFiles(directory=ROOT / "web" / "vendor"), name="vendor")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})
