"""Program + space → zones → rectangles.

v1 (always works): the kit gives a space's size, not its shape, so the plan is drawn in an assumed 1:2
rectangle (storefront on the short side) and labelled "approximate shape". Zone sizes follow the same
net-to-gross assumption the sizing uses, so the seats a plan shows always equal the legal calculation.

v2: when a Matterport scan of the suite exists, `assign_to_rooms` maps the zones onto the scanned rooms.
"""
from __future__ import annotations

import math
from typing import Any

from .parse import Program
from .sizing import max_capacity, net_to_gross, rules_for
from .store import BUSINESSES, MARKETS, Store

RESTROOM_SQFT = 60          # one accessible single-user restroom
EXAM_ROOM_SQFT = 110
ASPECT = 2.0                # depth = 2 × width

# Split of the non-revenue area once restrooms are taken out (assumptions, shown in the UI).
BACK_OF_HOUSE = {
    "cafe": [("kitchen", "Kitchen & prep", 0.50), ("counter", "Counter & service", 0.30), ("circulation", "Entry & circulation", 0.20)],
    "restaurant": [("kitchen", "Kitchen & back of house", 0.62), ("counter", "Bar & host stand", 0.16), ("circulation", "Entry & circulation", 0.22)],
    "daycare": [("office", "Reception & office", 0.28), ("kitchen", "Kitchen & food prep", 0.20), ("circulation", "Halls & storage", 0.52)],
}
GYM_SHARES = [("workout", "Workout floor", 0.58), ("studio", "Class studio", 0.14), ("lockers", "Lockers, showers & restrooms", 0.13),
              ("reception", "Reception", 0.08), ("office", "Office & storage", 0.07)]


def _zone(zid: str, label: str, sqft: float, basis: str, kind: str = "assumption") -> dict[str, Any]:
    return {"id": zid, "label": label, "sqft": max(0.0, float(sqft)), "basis": basis, "kind": kind}


def program_zones(store: Store, program: Program, total: float) -> tuple[list[dict[str, Any]], list[list[str]], dict[str, Any]]:
    """Zones for a space of `total` sq ft, the rows they are drawn in (front → back), and capacity facts."""
    biz, state = program.business, MARKETS[program.market]["state"]
    rule = rules_for(store, biz, state)["capacity"]
    per, cap = rule["sqft_per_person"], program.capacity
    unit = BUSINESSES[biz]["unit"]
    supported = max_capacity(store, biz, state, total)
    zones: list[dict[str, Any]] = []

    if biz in ("cafe", "restaurant", "daycare"):
        ntg = net_to_gross(store, biz)["value"]
        net = total * ntg
        needed = min(cap * per, net)
        main_id, main_label, extra_label = (("classrooms", "Classrooms & activity rooms", "Extra activity space") if biz == "daycare"
                                            else ("seating", "Seating", "Extra seating"))
        zones.append(_zone(main_id, main_label, needed, f"{cap:,} {unit} × {per} sq ft ({rule['code']})", "rule"))
        extra = net - needed
        if extra >= 40:
            zones.append(_zone("extra", extra_label, extra, f"+{int(extra // per):,} {unit} at {per} sq ft each", "rule"))
        elif extra > 0:
            zones[0]["sqft"] += extra
        back = total - net
        n_rest = (max(2, math.ceil(cap / 15)) if biz == "daycare" else 2 if total >= 700 else 1)
        rest = min(n_rest * RESTROOM_SQFT, back * 0.45)
        zones.append(_zone("restrooms", "Restrooms", rest,
                           f"{n_rest} × ~{RESTROOM_SQFT} sq ft" + (" (about 1 per 15 children)" if biz == "daycare" else " accessible restrooms")))
        for zid, label, share in BACK_OF_HOUSE[biz]:
            zones.append(_zone(zid, label, (back - rest) * share, f"{share:.0%} of the non-{'activity' if biz == 'daycare' else 'dining'} area"))
        rows = ([[main_id, "extra"], ["office", "circulation"], ["kitchen", "restrooms"]] if biz == "daycare"
                else [[main_id, "extra"], ["counter", "circulation"], ["kitchen", "restrooms"]])
    elif biz == "gym":
        for zid, label, share in GYM_SHARES:
            zones.append(_zone(zid, label, total * share, f"{share:.0%} of the space"))
        rows = [["reception", "office"], ["workout"], ["studio", "lockers"]]
    else:  # clinic
        people_per_room = store.assumptions["clinic_people_per_exam_room"]["value"]
        n_rooms = max(1, math.ceil(cap / people_per_room))
        exam = min(n_rooms * EXAM_ROOM_SQFT, total * 0.45)
        n_rooms = max(1, int(exam // EXAM_ROOM_SQFT))
        rest = min(2 * RESTROOM_SQFT, total * 0.1)
        zones += [
            _zone("waiting", "Waiting & reception", total * 0.16, "16% of the space"),
            _zone("exam", f"{n_rooms} exam rooms", exam, f"{n_rooms} × ~{EXAM_ROOM_SQFT} sq ft, one per {people_per_room} people"),
            _zone("staff", "Offices & staff", total * 0.12, "12% of the space"),
            _zone("lab", "Lab, supplies & storage", total * 0.08, "8% of the space"),
            _zone("restrooms", "Restrooms", rest, f"2 × ~{RESTROOM_SQFT} sq ft accessible restrooms"),
        ]
        zones.append(_zone("circulation", "Corridors", total - sum(z["sqft"] for z in zones), "the remainder"))
        rows = [["waiting", "restrooms"], ["exam"], ["circulation"], ["staff", "lab"]]

    zones = [z for z in zones if z["sqft"] >= 1]
    capacity = {"requested": cap, "supported": supported, "unit": unit, "fits": supported >= cap,
                "headroom": max(0, supported - cap)}
    return zones, rows, capacity


def pack(zones: list[dict[str, Any]], rows: list[list[str]], total: float) -> dict[str, Any]:
    """Lay the zones out as full-width bands from the storefront (y = 0) to the back wall."""
    width = math.sqrt(total / ASPECT)
    depth = total / width
    by_id = {z["id"]: z for z in zones}
    y = 0.0
    for row in rows:
        members = [by_id[i] for i in row if i in by_id]
        area = sum(z["sqft"] for z in members)
        if area <= 0:
            continue
        band = area / width
        x = 0.0
        for z in members:
            w = width * z["sqft"] / area
            z.update(x=round(x, 2), y=round(y, 2), w=round(w, 2), h=round(band, 2))
            x += w
        y += band
    return {"width_ft": round(width, 1), "depth_ft": round(depth, 1), "sqft": round(total), "approximate": True,
            "note": "Approximate shape. The listing gives the size, not the outline, so the plan assumes a 1:2 rectangle with the storefront on the short side."}


def build_layout(store: Store, program: Program, space: dict[str, Any], take: float) -> dict[str, Any]:
    zones, rows, capacity = program_zones(store, program, take)
    shape = pack(zones, rows, take)
    for z in zones:
        z["sqft"] = round(z["sqft"])
        z["share"] = round(z["sqft"] / take, 3)

    biz, state = program.business, MARKETS[program.market]["state"]
    rules = rules_for(store, biz, state)
    outdoor = None
    if rules["outdoor"]:
        need = program.capacity * rules["outdoor"]["sqft_per_person"]
        open_lot = space.get("open_lot_sqft")
        outdoor = {
            "label": "Outdoor play area", "sqft": need, "code": rules["outdoor"]["code"],
            "basis": f"{program.capacity:,} children × {rules['outdoor']['sqft_per_person']} sq ft",
            "source_url": rules["outdoor"]["source_url"],
            "open_lot_sqft": open_lot,
            "status": ("unknown" if not open_lot else "likely" if open_lot >= need else "short"),
            "status_text": ("The kit has no lot size for this building — check the aerial view." if not open_lot else
                            f"About {open_lot:,.0f} sq ft of the lot is not under the building — enough on paper; confirm a usable, fenceable yard on the aerial view."
                            if open_lot >= need else
                            f"Only about {open_lot:,.0f} sq ft of the lot is not under the building — less than the {need:,} sq ft needed."),
        }

    assumptions = []
    if rules["capacity"]["basis"] == "net":
        ntg = net_to_gross(store, biz)
        assumptions.append(f"{ntg['value']:.0%} of the space counts toward capacity. {ntg['why']}")
    if biz == "clinic":
        a = store.assumptions["clinic_people_per_exam_room"]
        assumptions.append(f"{a['value']} people per exam room. {a['why']}")
    assumptions.append("Zone shares other than the code-driven ones are planning rules of thumb, not requirements.")
    return {"shape": shape, "zones": zones, "capacity": capacity, "outdoor": outdoor, "assumptions": assumptions,
            "rule": rules["capacity"], "take_sqft": round(take)}


# ---------------------------------------------------------------------------
# v2 — place the zones in the rooms a Matterport scan measured.
# ---------------------------------------------------------------------------
_ROOM_HINTS = {
    "restrooms": ("bath", "restroom", "toilet", "wc"),
    "kitchen": ("kitchen", "break", "pantry", "prep"),
    "lockers": ("bath", "locker", "shower", "restroom"),
    "office": ("office",), "staff": ("office", "conference"),
    "waiting": ("lobby", "reception", "waiting", "entry"), "reception": ("lobby", "reception", "entry"),
    "circulation": ("hall", "corridor"),
    "lab": ("storage", "closet", "utility"),
}


def assign_to_rooms(zones: list[dict[str, Any]], rooms: list[dict[str, Any]]) -> dict[str, Any]:
    """Suggest which scanned room hosts each zone: name hints first, then closest area. Largest zones choose first."""
    usable = [r for r in rooms if (r.get("area_sqft") or 0) >= 25]
    free = {r["id"]: r for r in usable}
    out: list[dict[str, Any]] = []

    def name_of(r: dict[str, Any]) -> str:
        return f"{r.get('label') or ''} {' '.join(r.get('tags') or [])}".lower()

    def area_gap(z: dict[str, Any], r: dict[str, Any]) -> float:
        return abs(math.log(max(r["area_sqft"], 1) / max(z["sqft"], 1)))

    def place(z: dict[str, Any], room: dict[str, Any]) -> None:
        del free[room["id"]]
        out.append({"zone_id": z["id"], "zone_label": z["label"], "zone_sqft": z["sqft"], "room_id": room["id"],
                    "room_label": room.get("label") or None, "room_sqft": round(room["area_sqft"]),
                    "fit": round(room["area_sqft"] / max(z["sqft"], 1), 2)})

    by_size = sorted(zones, key=lambda z: -z["sqft"])
    # Pass 1: a room the scan already names "Kitchen" or "Bathroom" goes to the zone that wants it.
    for z in by_size:
        named = [r for r in free.values() if any(h in name_of(r) for h in _ROOM_HINTS.get(z["id"], ()))]
        if named:
            place(z, min(named, key=lambda r: area_gap(z, r)))
    # Pass 2: everything else by closest area, keeping people-zones out of corridors.
    placed = {a["zone_id"] for a in out}
    for z in by_size:
        if z["id"] in placed or not free:
            continue
        place(z, min(free.values(), key=lambda r: area_gap(z, r) + (
            1.5 if z["id"] != "circulation" and any(t in name_of(r) for t in ("hall", "corridor")) else 0.0)))
    order = {z["id"]: i for i, z in enumerate(by_size)}
    out.sort(key=lambda a: order[a["zone_id"]])
    return {"assignments": out, "unassigned_zones": [z["label"] for z in zones if z["id"] not in {a["zone_id"] for a in out}],
            "note": "Suggested use of the rooms the scan measured. Walls can move; treat it as a starting point."}
