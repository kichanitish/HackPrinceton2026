"""What a business needs, read from the knowledge graph.

    BusinessType ─REQUIRES_ZONE→ ZoneRequirement ─SIZED_BY→ Rule ←HAS_RULE─ State

Per-person zone sizes come from the Rule node the graph links to *in the user's state* (Texas and California
daycare rules differ), so the numbers the checker tests against are a graph traversal, not a constant.
"""
from __future__ import annotations

import json
import math
from typing import Any

from .store import BUSINESSES, MARKETS, Store

SEVERITY_ORDER = {"legal": 0, "functional": 1, "advisory": 2}


def _rule_for(store: Store, znode: str, state: str) -> dict[str, Any] | None:
    """The Rule this zone is SIZED_BY that applies in `state` (a State ─HAS_RULE→ Rule edge must exist)."""
    g = store.graph
    for _, rnode, d in g.out_edges(znode, data=True):
        if d.get("rel") == "SIZED_BY" and g.has_edge(f"state:{state}", rnode):
            return {"node": rnode, **g.nodes[rnode]}
    return None


def _count(spec: dict[str, Any], capacity: int, store: Store) -> int:
    c = spec.get("count", 1)
    if c == "exam_rooms":
        return max(1, math.ceil(capacity / store.assumptions["clinic_people_per_exam_room"]["value"]))
    if c == "per_15":
        return max(1, math.ceil(capacity / 15))
    return int(c)


def business_requirements(store: Store, business: str, capacity: int, market: str) -> dict[str, Any]:
    """Zones the business needs at this capacity, each with its size rule, severity and source."""
    g = store.graph
    state = MARKETS[market]["state"]
    bnode = f"biz:{business}"
    zones: list[dict[str, Any]] = []
    for _, znode, d in g.out_edges(bnode, data=True):
        if d.get("rel") != "REQUIRES_ZONE":
            continue
        node = g.nodes[znode]
        spec = json.loads(node["spec"])
        rule = _rule_for(store, znode, state) if spec["area"].get("per_person") else None
        zones.append({"node": znode, "spec": spec, "rule": rule, "order": node["order"],
                      "source": {"label": rule["label"] + " · " + rule["title"] if rule else node["source_label"],
                                 "url": rule["source_url"] if rule else node["source_url"]}})
    zones.sort(key=lambda z: z["order"])

    main_sqft = 0.0
    out = []
    for z in zones:
        spec, rule = z["spec"], z["rule"]
        if rule:
            min_sqft = capacity * float(rule["sqft_per_person"])
            basis = f"{capacity:,} × {rule['sqft_per_person']} sq ft per {rule['per']} ({rule['label']})"
        else:
            area = spec["area"]
            min_sqft = float(area.get("min", 0))
            basis = f"at least {min_sqft:,.0f} sq ft"
            if area.get("share_of_main") and main_sqft:
                share = area["share_of_main"] * main_sqft
                if share > min_sqft:
                    min_sqft = share
                    basis = f"{area['share_of_main']:.0%} of the {main_sqft:,.0f} sq ft main area"
            basis += " (planning rule)" if spec["source"] == "planning" else ""
        if spec.get("main"):
            main_sqft = min_sqft
        count = _count(spec, capacity, store)
        out.append({
            "id": spec["id"], "label": spec["label"], "severity": spec["severity"],
            "main": bool(spec.get("main")), "exterior": bool(spec.get("exterior")),
            "count": count, "min_sqft_each": round(min_sqft),
            "sqft_per_person": float(rule["sqft_per_person"]) if rule else None,
            "min_width_ft": spec.get("min_width_ft"), "width_severity": spec.get("width_severity", spec["severity"]),
            "min_height_ft": spec.get("min_height_ft"), "height_severity": spec.get("height_severity", spec["severity"]),
            "basis": basis, "why": spec["why"], "source": z["source"],
            "rule_code": rule["label"] if rule else None,
            "graph_path": [bnode, "REQUIRES_ZONE", z["node"]] + (["SIZED_BY", rule["node"], "◀HAS_RULE", f"state:{state}"] if rule else []),
        })
    out.sort(key=lambda z: (not z["main"], SEVERITY_ORDER[z["severity"]]))
    return {
        "business": business, "business_label": BUSINESSES[business]["label"], "capacity": capacity,
        "unit": BUSINESSES[business]["unit"], "market": market, "state": state,
        "zones": out,
        "source": "Knowledge graph (rules/zones.json + rules.json)",
        "note": "Legal = cited code or licensing rule. Functional = the business can't run without it; sizes are planning rules. "
                "Advisory = good practice, never blocking.",
    }
