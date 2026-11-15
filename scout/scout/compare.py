"""The comparison: the same measures for every pick, with the best value in each column marked.

It compares; it doesn't rank. The order of the picks stays the agent's, and the user can sort by any column.
"""
from __future__ import annotations

from typing import Any

from .brief import Brief


def _col(key: str, label: str, better: str | None = None, fmt: str = "num") -> dict[str, Any]:
    return {"key": key, "label": label, "better": better, "fmt": fmt}


def columns(b: Brief) -> list[dict[str, Any]]:
    if b.mode == "home":
        cols = [_col("rent", "Rent from", "low", "money"), _col("beds", "Beds", None), _col("baths", "Baths", "high"),
                _col("sqft", "Sq ft", "high"), _col("available", "Units available", "high")]
    else:
        cols = [_col("monthly", "Rent / month", "low", "money"), _col("rate_yr", "$ / sq ft / yr", "low", "money2"),
                _col("sqft", "Sq ft", None), _col("residents", "Apartment units ½ mi", "high"),
                _col("workers", "Office workers ½ mi", "high"), _col("competitors", "Competitors ½ mi", "low")]
    cols += [_col(f"d:{a.label}", f"To {a.label}", "low", "miles") for a in b.anchors]
    if b.mode == "home":
        cols += [_col("pets", "Pets", None, "text"), _col("parking", "Parking", "yes", "bool"), _col("tours", "3D tours", "high")]
    else:
        cols += [_col("ground", "Ground floor", "yes", "bool"), _col("fitout", "Fit-out match", "yes", "bool"),
                 _col("parking", "Parking spaces", "high"), _col("tour", "3D tour", "yes", "bool")]
    return cols


def values(card: dict[str, Any], b: Brief) -> dict[str, Any]:
    v: dict[str, Any] = {}
    if b.mode == "home":
        p = card["plan"]
        v.update(rent=p.get("rentMin"), beds=p.get("beds"), baths=p.get("baths"), sqft=p.get("sqftMax") or p.get("sqftMin"),
                 available=p.get("available"), pets=" & ".join(x for x in ("Cats", "Dogs") if x[:-1] in (card.get("pets") or [])) or "None listed",
                 parking=bool(card.get("parking")), tours=len(card.get("tours") or []))
    else:
        q = card.get("quick") or {}
        v.update(monthly=card.get("monthly"), rate_yr=card.get("rate_yr"), sqft=card.get("sqft"), residents=q.get("residents_units"),
                 workers=q.get("office_workers"), competitors=q.get("competitors"), ground=card.get("ground"),
                 fitout=bool(card.get("fitout")), parking=card.get("parking_spaces"), tour=bool(card.get("tour")))
    for a in b.anchors:
        v[f"d:{a.label}"] = (card.get("distances") or {}).get(a.label, {}).get("miles")
    return v


def build(cards: list[dict[str, Any]], b: Brief) -> dict[str, Any]:
    cols = columns(b)
    rows = [{"id": c["id"], "values": values(c, b), "best": []} for c in cards]
    for col in cols:
        if not col["better"] or len(rows) < 2:
            continue
        vals = [r["values"].get(col["key"]) for r in rows]
        known = [x for x in vals if x is not None]
        if not known:
            continue
        if col["better"] == "yes":
            target = True if any(known) and not all(known) else None
        elif col["better"] == "low":
            target = min(known)
        else:
            target = max(known)
        if target is None or (col["better"] != "yes" and len(set(known)) == 1):
            continue
        for r, x in zip(rows, vals):
            if x is not None and x == target:
                r["best"].append(col["key"])
    return {"columns": cols, "rows": rows}
