"""Exterior: what the CoStar property record says about the site, plus what a vision model observes in the
Vexcel aerial image. The two are kept apart: a record is data, an image read is an observation, and neither
is a site survey. Observations are cached on disk."""
from __future__ import annotations

import base64
import json
import logging
from typing import Any, Literal

from pydantic import BaseModel, Field

from . import llm, vexcel
from .store import CACHE

log = logging.getLogger("fit.exterior")
RADIUS_M = 70                      # the aerial covers about 140 m (460 ft) square
IMAGE_FT = round(RADIUS_M * 2 * 3.28084)


class AerialObservation(BaseModel):
    """What can be seen in an overhead image. 'unclear' whenever the image does not show it plainly."""
    image_usable: bool = Field(description="False if the image is blank, cloudy or does not show buildings.")
    open_ground_next_to_building: Literal["yes", "no", "unclear"] = Field(
        description="Unbuilt ground (lawn, yard, unused paving) directly beside the building at the centre.")
    open_ground_description: str = Field(description="Where it is and roughly how big, in feet, using the stated image width.")
    could_hold_required_outdoor_area: Literal["yes", "no", "unclear", "not applicable"]
    parking_visible: Literal["none", "street only", "a few spaces", "a lot"]
    street_frontage: str = Field(description="Which side faces a street, and whether it is a corner site, if visible.")
    other_notes: str = Field(description="Anything else relevant for the business; empty if nothing.")


def _record_facts(space: dict[str, Any]) -> dict[str, Any]:
    facts = {
        "lot_sqft": space.get("lot_sqft"),
        "lot_not_under_building_sqft": space.get("open_lot_sqft"),
        "parking_ratio_per_1000_sqft": space.get("parking_ratio"),
        "parking_spaces": space.get("parking_spaces"),
        "street_frontage_ft": space.get("frontage_ft"),
        "frontage_street": space.get("frontage_street"),
        "zoning": space.get("zoning"),
        "floor": space.get("floor_label"),
        "ground_floor": space.get("is_ground"),
    }
    return {k: v for k, v in facts.items() if v is not None}


def observe(space: dict[str, Any], business: str, outdoor_need_sqft: int | None) -> dict[str, Any]:
    """CoStar record facts and a Vexcel image observation for one building."""
    out: dict[str, Any] = {
        "space_id": int(space["space_id"]),
        "costar_record": {"source": "CoStar property record", "facts": _record_facts(space)},
        "vexcel_observation": None,
        "image_url": f"/api/aerial/{space['property_id']}.jpg?r={RADIUS_M}",
        "unverified": [],
    }
    if not out["costar_record"]["facts"]:
        out["unverified"].append("The kit has no site record (lot, parking, frontage) for this building.")
    if outdoor_need_sqft:
        lot = space.get("open_lot_sqft")
        out["unverified"].append(
            f"Outdoor play area ({outdoor_need_sqft:,} sq ft): " +
            (f"the CoStar record shows ~{lot:,.0f} sq ft of lot not under the building, which may be parking or landscaping. "
             if lot else "the CoStar record has no lot size. ") +
            "Only a site visit can confirm a usable, fenceable yard.")
    if space.get("lat") is None:
        out["unverified"].append("No coordinates, so no aerial image.")
        return out
    spec = llm.model_spec()
    if not vexcel.configured() or spec is None:
        out["unverified"].append("Aerial image not read: " + ("VEXCEL_API_KEY not set." if not vexcel.configured() else "no LLM key set."))
        return out

    key = f"{space['property_id']}_{business}_{outdoor_need_sqft or 0}_{spec['model']}"
    path = CACHE / "observations" / f"{key}.json"
    if path.exists():
        out["vexcel_observation"] = json.loads(path.read_text(encoding="utf-8"))
        return out
    try:
        image = vexcel.get_aerial(int(space["property_id"]), space["lat"], space["lon"], RADIUS_M)
    except vexcel.VexcelError as e:
        out["unverified"].append(f"Vexcel returned no image ({e}).")
        return out
    need = (f"The business needs {outdoor_need_sqft:,} sq ft of outdoor play space (about "
            f"{int(outdoor_need_sqft ** 0.5)} × {int(outdoor_need_sqft ** 0.5)} ft)." if outdoor_need_sqft else
            "No outdoor area is required; answer 'not applicable' for that field.")
    prompt = (f"This is a vertical aerial photo, about {IMAGE_FT} ft across, centred on the building of a {business} candidate "
              f"site. {need} Describe only what is visible. Say 'unclear' rather than guess.")
    try:
        model = llm.build_chat_model(timeout=45).with_structured_output(AerialObservation)
        data_url = "data:image/jpeg;base64," + base64.b64encode(image).decode()
        obs: AerialObservation = model.invoke([{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]}])
    except Exception as e:   # a failed image read must not break the investigation
        log.warning("aerial observation failed: %s", type(e).__name__)
        out["unverified"].append("The vision model could not read the aerial image this time.")
        return out
    record = {"source": f"Vexcel aerial imagery, read by {spec['model']} — an observation, not a measurement",
              **obs.model_dump()}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record), encoding="utf-8")
    out["vexcel_observation"] = record
    return out
