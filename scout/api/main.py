"""Fit-to-Space API. Run from the repo root:  uvicorn api.main:app --port 8000   then open http://localhost:8000

Handlers stay thin: parse → size → match → explain → layout live in their own modules, and all data loading is
done once by store.get_store() from the pipeline's outputs.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

import json  # noqa: E402

from . import agent, llm, matterport, vexcel  # noqa: E402  (after load_dotenv)
from .explain import explain  # noqa: E402
from .layout import assign_to_rooms, build_layout  # noqa: E402
from .match import USE_LABEL, search, take_sqft  # noqa: E402
from .parse import ParseResult, Program, parse_request  # noqa: E402
from .sizing import compare_markets, size_program  # noqa: E402
from .store import BUSINESSES, MARKETS, get_store  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
app = FastAPI(title="Fit-to-Space", version="1.0")

EXAMPLES = [
    "Coffee shop, 40 seats, Houston, under $30/sq ft",
    "Daycare for 40 kids in Houston",
    "Dental clinic with 4 exam rooms in Los Angeles",
    "Yoga studio for 25 people in LA under $4/sq ft a month",
    "Restaurant, 80 seats, Los Angeles, with a patio",
]


class SearchRequest(BaseModel):
    text: Optional[str] = None
    program: Optional[Program] = None
    limit: int = 12


class SpaceRequest(BaseModel):
    program: Program


def _space_or_404(space_id: int) -> dict[str, Any]:
    space = get_store().space_by_id.get(space_id)
    if not space:
        raise HTTPException(404, "No such space")
    return space


def _take(space: dict[str, Any], sizing: dict[str, Any]) -> float:
    return take_sqft(space, float(sizing["recommended"]["low"]), float(sizing["recommended"]["high"]))


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    store = get_store()
    by_market = {k: sum(1 for s in store.spaces if s["market"] == k) for k in MARKETS}
    return {
        "businesses": [{"key": k, **v} for k, v in BUSINESSES.items()],
        "markets": [{**m, "spaces": by_market[k]} for k, m in MARKETS.items()],
        "examples": EXAMPLES,
        "counts": {"spaces": len(store.spaces), "buildings": len({s["property_id"] for s in store.spaces}),
                   "suite_tours": sum(1 for s in store.spaces if s["tour_level"] == "suite"),
                   "graph_nodes": store.graph.number_of_nodes(), "graph_edges": store.graph.number_of_edges()},
        "integrations": {"matterport_api": matterport.configured(), "matterport_sdk": bool(os.environ.get("MATTERPORT_SDK_KEY")),
                         "vexcel": vexcel.configured(), "agent": llm.model_spec()},
        "disclaimer": store.disclaimer,
    }


@app.get("/api/config")
def config() -> dict[str, Any]:
    """The one secret the browser needs: the Showcase SDK key, which Matterport locks to localhost."""
    return {"matterport_sdk_key": os.environ.get("MATTERPORT_SDK_KEY") or None}


@app.post("/api/search")
def search_spaces(req: SearchRequest) -> dict[str, Any]:
    store = get_store()
    if req.program is not None:
        parsed = ParseResult(program=req.program, understood=[], assumed=[], parser="form")
    elif req.text and req.text.strip():
        parsed = parse_request(req.text[:500])
    else:
        raise HTTPException(400, "Describe your business, or send a program.")
    program = parsed.program
    sizing = size_program(store, program)
    found = search(store, program, sizing, limit=max(1, min(req.limit, 40)))
    return {
        "program": program.model_dump(),
        "business": {"key": program.business, **BUSINESSES[program.business]},
        "display_name": program.display_name(),
        "parse": {"understood": parsed.understood, "assumed": parsed.assumed, "parser": parsed.parser},
        "sizing": sizing,
        "compare": compare_markets(store, program),
        **found,
    }


@app.post("/api/space/{space_id}")
def space_detail(space_id: int, req: SpaceRequest) -> dict[str, Any]:
    store = get_store()
    space = _space_or_404(space_id)
    program = req.program.model_copy(update={"market": space["market"] or req.program.market})
    sizing = size_program(store, program)
    take = _take(space, sizing)
    feat = store.features.get(int(space["property_id"]), {})
    keep = ("space_id", "property_id", "suite", "floor_label", "is_ground", "sqft_min", "sqft_max", "space_type", "is_sublease",
            "service_type", "available_now", "available_date", "date_on_market", "notes", "floorplan_url", "tour_model_id",
            "tour_caption", "tour_level", "tour_matched_by", "tour_thumb", "building_tours", "brokerage", "address", "city",
            "state", "zip", "lat", "lon", "building_name", "property_type", "building_class", "year_built", "stories", "gba_sqft",
            "lot_sqft", "open_lot_sqft", "parking_ratio", "parking_spaces", "zoning", "photo_url", "apt_units", "frontage_ft",
            "frontage_street", "in_kit", "rate_low_yr", "rate_high_yr", "features")
    return {
        "space": {**{k: space.get(k) for k in keep}, "space_use": USE_LABEL.get(space["space_use"], space["space_use"]),
                  "take_sqft": round(take), "divisible": (space["sqft_min"] or space["sqft_max"]) < space["sqft_max"]},
        "program": program.model_dump(),
        "business": {"key": program.business, **BUSINESSES[program.business]},
        "sizing": sizing,
        "why": explain(store, program, space, take),
        "layout": build_layout(store, program, space, take),
        "nearby": {k: feat.get(k) for k in ("apt_units_nearby", "apt_communities_nearby", "workers_nearby", "workers_in_building")},
        "aerial": {"available": vexcel.configured() and space.get("lat") is not None,
                   "url": f"/api/aerial/{space['property_id']}.jpg", "attribution": vexcel.ATTRIBUTION},
        "scan_available": bool(space.get("tour_model_id")) and matterport.configured(),
    }


@app.post("/api/scan/{space_id}")
def scan(space_id: int, req: SpaceRequest) -> dict[str, Any]:
    """What the Matterport scan measured for this space's tour, and the zones placed in its rooms."""
    store = get_store()
    space = _space_or_404(space_id)
    if not space.get("tour_model_id"):
        raise HTTPException(404, "This space has no Matterport tour")
    try:
        data = matterport.get_scan(space["tour_model_id"])
    except matterport.MatterportError as e:
        raise HTTPException(502, str(e)) from None
    program = req.program.model_copy(update={"market": space["market"] or req.program.market})
    sizing = size_program(store, program)
    layout = build_layout(store, program, space, _take(space, sizing))
    out: dict[str, Any] = {"scan": data, "level": space["tour_level"], "caption": space.get("tour_caption"),
                           "listed_sqft": space["sqft_max"]}
    if data.get("area_sqft") and space["tour_level"] == "suite":
        diff = (data["area_sqft"] - space["sqft_max"]) / space["sqft_max"]
        out["area_check"] = {
            "measured_sqft": data["area_sqft"], "listed_sqft": space["sqft_max"], "diff_pct": round(diff * 100, 1),
            "note": ("The scan covers more floor than the listing quotes, so the tour probably takes in neighbouring space or "
                     "shared areas as well as this suite. Trust the listing for the lease area."
                     if diff > 0.1 else
                     "The scan measures usable floor inside the walls; listings quote rentable area, which adds a share of "
                     "walls and common areas. A scan somewhat below the listing is normal."
                     if diff < -0.02 else "The scan and the listing agree closely."),
        }
    if space["tour_level"] == "suite" and data["rooms_measured"]:
        out["assignment"] = assign_to_rooms(layout["zones"], data["rooms"])
    return out


@app.get("/api/floorplans/{model_id}")
def floorplans(model_id: str) -> dict[str, Any]:
    try:
        return {"floorplans": matterport.get_floorplans(model_id)}
    except matterport.MatterportError as e:
        raise HTTPException(502, str(e)) from None


@app.get("/api/aerial/{property_id}.jpg")
def aerial(property_id: int, r: int = Query(70, ge=30, le=200), w: Optional[int] = Query(None, ge=120, le=1600)) -> Response:
    """Vexcel aerial of a building. `w` returns a resized copy (cached on disk) for thumbnails."""
    store = get_store()
    space = next((s for s in store.spaces if int(s["property_id"]) == property_id and s.get("lat") is not None), None)
    if not space:
        raise HTTPException(404, "No such building")
    try:
        image = vexcel.get_aerial(property_id, space["lat"], space["lon"], r)
    except vexcel.VexcelError as e:
        raise HTTPException(502, str(e)) from None
    if w:
        thumb = vexcel.CACHE / "aerial" / f"{property_id}_{r}_w{w}.jpg"
        if not thumb.exists():
            from io import BytesIO

            from PIL import Image
            im = Image.open(BytesIO(image)).convert("RGB")
            im.thumbnail((w, w))
            im.save(thumb, "JPEG", quality=82, optimize=True)
        image = thumb.read_bytes()
    return Response(image, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/points")
def points() -> dict[str, Any]:
    """Every space's location, for the survey field: [space_id, lat, lon, market (0 Houston, 1 LA)]."""
    store = get_store()
    return {"points": [[int(s["space_id"]), round(s["lat"], 5), round(s["lon"], 5), 0 if s["market"] == "houston" else 1]
                       for s in store.spaces if s.get("lat") is not None and s.get("market")]}


@app.post("/api/proof/{space_id}")
def proof(space_id: int, req: SpaceRequest) -> dict[str, Any]:
    """The layout check for one space plus the measured room geometry it was made on, for drawing."""
    from .agent_tools import verify_impl
    store = get_store()
    space = _space_or_404(space_id)
    program = req.program.model_copy(update={"market": space["market"] or req.program.market})
    result = verify_impl(space_id, program)
    rooms, floors = [], []
    if result.get("model_id"):
        try:
            scan_data = matterport.get_scan(result["model_id"])
            rooms = [{k: r.get(k) for k in ("id", "label", "tags", "floor_id", "area_sqft", "width_ft", "depth_ft", "height_ft",
                                            "walls", "outline", "center", "locations")} for r in scan_data["rooms"] if r.get("walls")]
            floors = scan_data["floors"]
        except matterport.MatterportError:
            pass
    return {"verify": result, "rooms": rooms, "floors": floors}


class AgentRequest(BaseModel):
    text: Optional[str] = None
    program: Optional[Program] = None


@app.get("/api/agent/status")
def agent_status() -> dict[str, Any]:
    spec = llm.model_spec()
    return {"available": spec is not None, "model": spec, "framework": "LangChain create_agent",
            "limits": {"model_calls": agent.MAX_MODEL_CALLS, "tool_calls": agent.MAX_TOOL_CALLS, "seconds": agent.DEADLINE_S},
            "tools": [t.name for t in agent.TOOLS]}


@app.post("/api/agent")
def agent_run(req: AgentRequest) -> StreamingResponse:
    """Server-sent events: every tool call and result as it happens, then the answer. Falls back deterministically."""
    if req.program is None and not (req.text and req.text.strip()):
        raise HTTPException(400, "Describe your business, or send a program.")
    program = req.program or parse_request(req.text[:500]).program
    query = (req.text or "").strip()[:500]

    def events():
        try:
            for ev in agent.run(query, program):
                yield f"data: {json.dumps(ev, default=str)}\n\n"
        except Exception as e:   # last line of defence; agent.run already falls back internally
            logging.getLogger("fit.agent").exception("agent stream failed")
            yield f"data: {json.dumps({'type': 'error', 'text': f'The investigation failed ({type(e).__name__}).'})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "spaces": len(get_store().spaces)}


WEB = ROOT / "web"


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


class FreshStatic(StaticFiles):
    """Static files that the browser always revalidates, so an edit shows up on the next reload."""

    async def get_response(self, path: str, scope: Any) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", FreshStatic(directory=WEB), name="web")
