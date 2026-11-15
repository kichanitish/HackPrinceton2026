"""Layout checker: test the program's zones against the rooms a Matterport scan actually measured.

Nothing here is estimated. A check passes or fails on a measured number, or it is reported as unverified
(no scan of this suite, a room without measured width, an outdoor requirement an interior scan cannot see).

The checker searches room assignments: every way of giving each required zone its own room (best few
candidates per zone, bounded), then gives the main zone (dining room, classrooms, workout floor) the rooms
left over. It keeps the assignment with the fewest legal failures, then functional, then advisory, then the
most main-zone area. Requirements are never relaxed; a smaller capacity is only ever offered as an option.
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable

from . import matterport
from .parse import Program
from .requirements import business_requirements
from .store import BUSINESSES, Store

NOT_ROOMS = re.compile(r"hall|corridor|stair|elevator|closet|shaft|garage|balcony|exterior|outdoor|patio|deck|porch", re.I)
MIN_ROOM_SQFT = 25
MAIN_MIN_ROOM_SQFT = 80   # closets and small offices don't count as dining floor, classrooms or workout space
CANDIDATES_PER_SLOT = 4
MAX_ASSIGNMENTS = 20_000
MANDATORY = ("legal", "functional")


def _name(room: dict[str, Any]) -> str:
    return f"{room.get('label') or ''} {' '.join(room.get('tags') or [])}".strip()


def _room_ref(room: dict[str, Any]) -> str:
    dims = f", {room['width_ft']:.1f} × {room['depth_ft']:.1f} ft" if room.get("width_ft") and room.get("depth_ft") else ""
    how = f" (from {room['measured_by']})" if room.get("measured_by") and room["measured_by"] != "scan dimensions" else ""
    return f"room {room['id'][:8]}{' (' + room['label'] + ')' if room.get('label') else ''}: {room['area_sqft']:,.0f} sq ft{dims}{how}"


def _check(zone: str, kind: str, severity: str, status: str, required: str, measured: str, room: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"zone": zone, "check": kind, "severity": severity, "status": status, "required": required, "measured": measured,
            "room_id": room["id"] if room else None, "evidence": _room_ref(room) if room else None}


def _sqft(value: float, against: float) -> str:
    """Whole square feet, or one decimal when rounding would hide a near miss (99.96 vs 100)."""
    return f"{value:,.1f} sq ft" if value < against and round(value) >= against else f"{value:,.0f} sq ft"


def room_checks(zone: dict[str, Any], room: dict[str, Any]) -> list[dict[str, Any]]:
    """Area, width and height checks of one room against one zone requirement."""
    out = [_check(zone["label"], "area", zone["severity"],
                  "pass" if room["area_sqft"] >= zone["min_sqft_each"] else "fail",
                  f"≥ {zone['min_sqft_each']:,} sq ft", _sqft(room["area_sqft"], zone["min_sqft_each"]), room)]
    if zone.get("min_width_ft"):
        w, d = room.get("width_ft"), room.get("depth_ft")
        need = f"≥ {zone['min_width_ft']} ft room width"
        if w and d:
            # The scan gives a room's overall dimensions. For an L-shaped or irregular room (floor area well under
            # width × depth) the overall width is not a usable width, so the check can't be settled either way.
            if room["area_sqft"] < 0.85 * w * d:
                out.append(_check(zone["label"], "width", zone["width_severity"], "unverified", need,
                                  f"{min(w, d):.1f} ft overall, but the room is irregular, so that is not a usable width", room))
            else:
                out.append(_check(zone["label"], "width", zone["width_severity"],
                                  "pass" if min(w, d) >= zone["min_width_ft"] else "fail", need, f"{min(w, d):.1f} ft", room))
        else:
            out.append(_check(zone["label"], "width", zone["width_severity"], "unverified", need,
                              "the scan did not measure this room's width", room))
    return out


def _fails(checks: list[dict[str, Any]]) -> tuple[int, int, int]:
    count = {"legal": 0, "functional": 0, "advisory": 0}
    for c in checks:
        if c["status"] == "fail":
            count[c["severity"]] += 1
    return count["legal"], count["functional"], count["advisory"]


def _unverified(space: dict[str, Any], reason: str, reqs: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
    return {"space_id": int(space["space_id"]), "status": "unverified", "source": "Matterport scan (Model API)",
            "summary": f"Not verified: {reason}", "checks": [], "conflicts": [], "advisories": [],
            "unverified": [reason], "assignment": [], "alternatives_evaluated": 0, "max_capacity_verified": None,
            "requirements": reqs, **extra}


def verify_layout(store: Store, program: Program, space: dict[str, Any], *,
                  pin_rooms: dict[str, str] | None = None, avoid_rooms: list[str] | None = None,
                  fetch_scan: Callable[[str], dict[str, Any]] = matterport.get_scan) -> dict[str, Any]:
    reqs = business_requirements(store, program.business, program.capacity, program.market)
    unit = BUSINESSES[program.business]["unit"]
    if not space.get("tour_model_id"):
        return _unverified(space, "no Matterport tour is attached to this building, so room sizes are unknown.", reqs)
    if space.get("tour_level") != "suite":
        return _unverified(space, f"the building's tour (“{space.get('tour_caption') or 'untitled'}”) shows another part of the "
                                  "building, not this suite, so its rooms cannot stand in for this space.", reqs,
                           model_id=space["tour_model_id"])
    try:
        scan = fetch_scan(space["tour_model_id"])
    except matterport.MatterportError as e:
        return _unverified(space, f"the Matterport API did not return the scan ({e}).", reqs, model_id=space["tour_model_id"])

    avoid = set(avoid_rooms or [])
    measured = [r for r in scan["rooms"] if (r.get("area_sqft") or 0) >= MIN_ROOM_SQFT and r["id"] not in avoid]
    usable = [r for r in measured if not NOT_ROOMS.search(_name(r))]
    if not usable:
        return _unverified(space, "the scan has no measured rooms large enough to hold a zone.", reqs, model_id=scan["model_id"])

    interior = [z for z in reqs["zones"] if not z["exterior"]]
    main = next((z for z in interior if z["main"]), None)
    slots = [{"zone": z, "key": f"{z['id']}#{i + 1}"} for z in interior if not z["main"] for i in range(z["count"])]
    slots.sort(key=lambda s: (s["zone"]["severity"] not in MANDATORY, -s["zone"]["min_sqft_each"]))
    by_id = {r["id"]: r for r in usable}
    notes: list[str] = []

    # pinned rooms (the agent can ask for an alternative assignment)
    pins: dict[str, str] = {}
    reserved_for_main: set[str] = set()
    for zone_id, room_id in (pin_rooms or {}).items():
        if room_id not in by_id:
            notes.append(f"Pinned room {room_id[:8]} is not a usable measured room; pin ignored.")
            continue
        if main and zone_id == main["id"]:
            reserved_for_main.add(room_id)
            continue
        key = zone_id if "#" in zone_id else f"{zone_id}#1"
        if any(s["key"] == key for s in slots):
            pins[key] = room_id
        else:
            notes.append(f"No zone called “{zone_id}” for this business; pin ignored.")

    def candidates(slot: dict[str, Any]) -> list[dict[str, Any] | None]:
        if slot["key"] in pins:
            return [by_id[pins[slot["key"]]]]
        z = slot["zone"]
        pool = [r for r in usable if r["id"] not in reserved_for_main and r["id"] not in pins.values()]

        def rank(r: dict[str, Any]) -> tuple:
            legal, functional, advisory = _fails(room_checks(z, r))
            slack = r["area_sqft"] - z["min_sqft_each"]
            return (legal, functional, advisory, slack if slack >= 0 else 1e9 - slack)   # smallest room that fits
        # A zone needed n times (exam rooms, restrooms) gets n extra candidates, so its copies don't compete for the
        # same few rooms. "No room" is always an option, so a restroom never starves the dining room.
        return sorted(pool, key=rank)[:CANDIDATES_PER_SLOT + z["count"] - 1] + [None]

    cand = [candidates(s) for s in slots]
    # Copies of the same zone are interchangeable: only try their rooms in increasing candidate order.
    same_as_prev = [i > 0 and slots[i]["zone"]["id"] == slots[i - 1]["zone"]["id"] and slots[i]["key"] not in pins
                    and slots[i - 1]["key"] not in pins for i in range(len(slots))]
    best: dict[str, Any] = {"cost": None}
    evaluated = 0

    def evaluate(choice: list[dict[str, Any] | None]) -> None:
        nonlocal evaluated
        evaluated += 1
        used = {r["id"] for r in choice if r}
        remaining = [r for r in usable if r["id"] not in used]
        checks: list[dict[str, Any]] = []
        without_room = []
        for slot, room in zip(slots, choice):
            if room:
                checks += room_checks(slot["zone"], room)
            elif slot["zone"]["severity"] in MANDATORY:
                without_room.append(slot["zone"])
        main_area = sum(r["area_sqft"] for r in remaining if r["area_sqft"] >= MAIN_MIN_ROOM_SQFT)
        legal, functional, advisory = _fails(checks)
        if main and main_area < main["min_sqft_each"]:
            legal += main["severity"] == "legal"
            functional += main["severity"] == "functional"
        # A zone without a room is fine if the main zone's spare floor can be partitioned for it (a build-out).
        spare = main_area - main["min_sqft_each"] if main and main["sqft_per_person"] else 0.0
        missing_count = buildouts = 0
        for z in sorted(without_room, key=lambda z: z["min_sqft_each"]):
            if spare >= z["min_sqft_each"]:
                spare -= z["min_sqft_each"]
                buildouts += 1
            else:
                missing_count += 1
                legal += z["severity"] == "legal"
                functional += z["severity"] == "functional"
        # fewest mandatory failures; legal zones get rooms before planning-rule zones; then no unplaced zones;
        # then existing rooms before build-outs; then fewest advisory failures; then most main floor
        cost = (legal + functional, legal, missing_count, buildouts, advisory, -main_area)
        if best["cost"] is None or cost < best["cost"]:
            best.update(cost=cost, choice=list(choice), remaining=remaining)

    def dfs(i: int, choice: list[dict[str, Any] | None], idx: list[int], used: set[str]) -> None:
        if evaluated >= MAX_ASSIGNMENTS:
            return
        if i == len(slots):
            evaluate(choice)
            return
        floor = idx[-1] + 1 if same_as_prev[i] else 0
        if same_as_prev[i] and choice[-1] is None:
            floor = len(cand[i]) - 1                      # after one copy went without a room, the rest do too
        tried = False
        for j in range(floor, len(cand[i])):
            r = cand[i][j]
            if r is not None and r["id"] in used:
                continue
            tried = True
            dfs(i + 1, choice + [r], idx + [j], used | ({r["id"]} if r else set()))
        if not tried:
            dfs(i + 1, choice + [None], idx + [len(cand[i]) - 1], used)

    dfs(0, [], [], set())
    choice, remaining = best["choice"], best["remaining"]
    unmeasured = sum(1 for r in scan["rooms"] if not r.get("area_sqft") and r.get("walls"))

    # ---- final checks for the chosen assignment
    checks: list[dict[str, Any]] = []
    assignment: list[dict[str, Any]] = []
    missing: list[tuple[dict[str, Any], str]] = []
    for slot, room in zip(slots, choice):
        z = slot["zone"]
        label = z["label"] if z["count"] == 1 else f"{z['label']} {slot['key'].split('#')[1]}"
        if room:
            rc = room_checks({**z, "label": label}, room)
            checks += rc
            assignment.append({"zone": label, "zone_id": z["id"], "severity": z["severity"], "room_id": room["id"],
                               "room_label": room.get("label"), "room_sqft": round(room["area_sqft"]),
                               "ok": all(c["status"] != "fail" for c in rc)})
        else:
            missing.append((z, label))

    # ---- the main zone takes what is left; whatever it doesn't need is open floor a missing zone could be built in
    max_capacity = None
    spare = 0.0
    main_rooms: list[dict[str, Any]] = []
    exam = next((z for z in interior if z["id"] == "exam"), None)
    ok_spare_exams = 0
    if main and main["sqft_per_person"]:                  # seating / classrooms / workout floor: fewest large rooms that suffice
        big_rooms = sorted([r for r in remaining if r["area_sqft"] >= MAIN_MIN_ROOM_SQFT], key=lambda r: -r["area_sqft"])
        main_area = sum(r["area_sqft"] for r in big_rooms)      # everything that could become main floor
        acc = 0.0
        for r in big_rooms:
            if acc >= main["min_sqft_each"]:
                break
            main_rooms.append(r)
            acc += r["area_sqft"]
        spare = max(0.0, main_area - main["min_sqft_each"])
    elif main:                                            # clinic waiting area: one room; spare rooms may become exam rooms
        fits = sorted([r for r in remaining if r["area_sqft"] >= main["min_sqft_each"]], key=lambda r: r["area_sqft"])
        pinned = [r for r in remaining if r["id"] in reserved_for_main]
        room = pinned[0] if pinned else fits[0] if fits else max(remaining, key=lambda r: r["area_sqft"], default=None)
        if room:
            checks += room_checks(main, room)
            assignment.append({"zone": main["label"], "zone_id": main["id"], "severity": main["severity"], "room_id": room["id"],
                               "room_label": room.get("label"), "room_sqft": round(room["area_sqft"]),
                               "ok": room["area_sqft"] >= main["min_sqft_each"]})
            remaining = [r for r in remaining if r["id"] != room["id"]]
            spare = max(0.0, room["area_sqft"] - main["min_sqft_each"])
        else:
            checks.append(_check(main["label"], "presence", main["severity"], "fail", "a room of its own", "no room left"))
        if exam:   # spare rooms that already pass as exam rooms count toward capacity; narrow ones can't be carved into one
            ok_spare_exams = sum(1 for r in remaining if all(c["status"] == "pass" for c in room_checks(exam, r)))

    used_ids = {a["room_id"] for a in assignment} | {r["id"] for r in main_rooms}

    def closest_rejected(z: dict[str, Any]) -> str:
        """Why the nearest existing room was not used for this zone, so a missing zone is never unexplained."""
        pool = [r for r in usable if r["id"] not in used_ids]
        failing = []
        for r in sorted(pool, key=lambda r: abs(r["area_sqft"] - z["min_sqft_each"])):
            bad = [c for c in room_checks(z, r) if c["status"] == "fail"]
            if bad:
                failing.append(f"the closest existing room ({_room_ref(r)}) fails {bad[0]['check']}: "
                               f"{bad[0]['measured']} against {bad[0]['required']}")
                break
        return failing[0] if failing else ""

    carved, buildout, unplaced = 0.0, [], []
    for z, label in missing:
        need = z["min_sqft_each"]
        why_not = closest_rejected(z)
        if why_not:
            notes.append(f"{label}: {why_not}.")
        if z["severity"] in MANDATORY and spare - carved >= need:
            carved += need
            buildout.append(z["id"])
            checks.append(_check(label, "presence", z["severity"], "buildout", "a room of its own",
                                 f"no separate room today; {spare - carved + need:,.0f} sq ft of open floor beyond the "
                                 f"{main['label'].lower() if main else 'main'} need is enough to partition {need:,} sq ft for it"))
        elif z["severity"] in MANDATORY and unmeasured:
            checks.append(_check(label, "presence", z["severity"], "unverified", "a room of its own",
                                 f"no measured room left; the scan also shows {unmeasured} room{'s' if unmeasured != 1 else ''} "
                                 "it did not measure, which could serve"))
        else:
            if z["severity"] in MANDATORY:
                unplaced.append((label, need))
            checks.append(_check(label, "presence", z["severity"], "fail" if z["severity"] in MANDATORY else "unverified",
                                 "a room of its own", "no suitable room or spare open floor left in the scan"
                                 + (f"; {why_not}" if why_not else "")))

    fits_if_smaller = None
    if main and main["sqft_per_person"]:
        usable_area = main_area - carved
        max_capacity = int(usable_area // main["sqft_per_person"])
        if unplaced:   # zones with no room: they could come out of the main floor if the user accepted fewer people
            fits_if_smaller = max(0, int((usable_area - sum(n for _, n in unplaced)) // main["sqft_per_person"]))
            max_capacity = min(max_capacity, fits_if_smaller)
        used_area = sum(r["area_sqft"] for r in main_rooms)
        if carved and used_area - carved < main["min_sqft_each"]:
            used_area = min(main_area, used_area + carved)    # the build-out comes out of the main rooms, so more are needed
        rooms_txt = (f"{used_area:,.0f} sq ft in the {len(main_rooms)} largest room{'s' if len(main_rooms) != 1 else ''}"
                     if max_capacity >= program.capacity else
                     f"only {main_area:,.0f} sq ft across every measured room of {MAIN_MIN_ROOM_SQFT}+ sq ft")
        if carved:
            rooms_txt += f", less {carved:,.0f} sq ft partitioned for the build-out"
        checks.append(_check(main["label"], "capacity", main["severity"], "pass" if max_capacity >= program.capacity else "fail",
                             f"{program.capacity:,} {unit} × {main['sqft_per_person']:g} sq ft = {main['min_sqft_each']:,} sq ft",
                             f"{rooms_txt}; all large rooms together support up to {max_capacity:,} {unit}"))
        if len(main_rooms) > 1:
            notes.append(f"The {main['label'].lower()} uses {len(main_rooms)} measured rooms; this assumes they connect or "
                         "can be opened up into one area.")
        if main.get("min_height_ft"):
            heights = [r["height_ft"] for r in main_rooms if r.get("height_ft")]
            checks.append(_check(main["label"], "height", main["height_severity"],
                                 ("pass" if min(heights) >= main["min_height_ft"] else "fail") if heights else "unverified",
                                 f"≥ {main['min_height_ft']} ft ceiling", f"{min(heights):.1f} ft" if heights else "ceiling not measured"))
        for r in main_rooms:
            assignment.append({"zone": main["label"], "zone_id": main["id"], "severity": main["severity"], "room_id": r["id"],
                               "room_label": r.get("label"), "room_sqft": round(r["area_sqft"]), "ok": True})
    elif exam:
        ppr = store.assumptions["clinic_people_per_exam_room"]["value"]
        ok_assigned = sum(1 for a in assignment if a["zone_id"] == "exam" and a["ok"])
        built = buildout.count("exam")
        max_capacity = (ok_assigned + ok_spare_exams + built) * ppr
        checks.append(_check("Exam rooms", "capacity", exam["severity"], "pass" if ok_assigned + built >= exam["count"] else "fail",
                             f"{exam['count']} exam rooms for {program.capacity} people ({ppr} per room)",
                             f"{ok_assigned} measured rooms pass the exam-room checks"
                             + (f", {built} more can be partitioned from open floor" if built else "")
                             + (f" (+{ok_spare_exams} spare rooms would also pass)" if ok_spare_exams else "")))

    unverified = [f"{c['zone']}: {c['measured']}" for c in checks if c["status"] == "unverified" and c["severity"] in MANDATORY]
    for z in reqs["zones"]:
        if z["exterior"]:
            unverified.append(f"{z['label']} ({z['min_sqft_each']:,} sq ft, {z['severity']}): an interior scan cannot verify it — "
                              "use the exterior observation and the lot record.")
    caveats = [f"Build-out needed: {c['zone']} has no separate room today; {c['measured'].split('; ', 1)[1]}."
               for c in checks if c["status"] == "buildout"]
    if scan.get("area_sqft") and space.get("sqft_max"):
        ratio = scan["area_sqft"] / space["sqft_max"]
        if ratio > 1.1:
            caveats.append(f"The scan measures {scan['area_sqft']:,} sq ft against {space['sqft_max']:,.0f} listed, so it probably takes in "
                           "neighbouring or shared space; some rooms used here may not be part of this lease.")
        elif ratio < 0.75:
            caveats.append(f"The scan covers {scan['area_sqft']:,} sq ft of the {space['sqft_max']:,.0f} listed, so part of the suite was not scanned.")

    conflicts = [c for c in checks if c["status"] == "fail" and c["severity"] in MANDATORY]
    advisories = [c for c in checks if c["status"] == "fail" and c["severity"] == "advisory"]
    status = "conflict" if conflicts else ("feasible_with_caveats" if unverified or caveats or notes else "feasible")
    if conflicts:
        first = conflicts[0]
        summary = f"Conflict ({first['severity']}): {first['zone']} — needs {first['required']}, measured {first['measured']}."
    else:
        summary = ("Every required zone passes the space checks on measured rooms (a screen, not legal approval)." if status == "feasible"
                   else "Required zones pass the space checks on measured rooms, with caveats (a screen, not legal approval).")
    option = None
    if fits_if_smaller is not None and 0 < fits_if_smaller < program.capacity:
        zones_txt = " and ".join(label.lower() for label, _ in unplaced)
        option = {"capacity": fits_if_smaller,
                  "note": f"With {fits_if_smaller:,} {unit} instead of {program.capacity:,}, the {zones_txt} could be built out of the "
                          "spare floor. Reducing capacity is a change only the user can approve."}
    elif max_capacity is not None and 0 < max_capacity < program.capacity:
        option = {"capacity": max_capacity,
                  "note": f"The measured rooms support {max_capacity:,} {unit}, not {program.capacity:,}. Reducing capacity is a change "
                          "only the user can approve."}
    return {
        "space_id": int(space["space_id"]), "status": status, "summary": summary,
        "source": "Matterport scan (Model API)", "model_id": scan["model_id"], "scan_area_sqft": scan.get("area_sqft"),
        "rooms_measured": len(measured), "rooms_used_as_candidates": len(usable),
        "rooms_skipped": [f"{_name(r) or r['id'][:8]} ({r['area_sqft']:,.0f} sq ft)" for r in measured if NOT_ROOMS.search(_name(r))],
        "checks": checks, "conflicts": conflicts, "advisories": advisories, "unverified": unverified, "caveats": caveats, "notes": notes,
        "assignment": assignment, "alternatives_evaluated": evaluated,
        "max_capacity_verified": max_capacity, "configuration_option": option, "requirements": reqs,
    }
