"""Loads the pipeline outputs once and holds them in memory for the API handlers."""
from __future__ import annotations

import json
import math
import pickle
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import networkx as nx
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
BUILT = ROOT / "data" / "built"
CACHE = ROOT / "data" / "cache"

MARKETS: dict[str, dict[str, str]] = {
    "houston": {"key": "houston", "name": "Houston", "state": "TX", "state_name": "Texas"},
    "los_angeles": {"key": "los_angeles", "name": "Los Angeles", "state": "CA", "state_name": "California"},
}

BUSINESSES: dict[str, dict[str, Any]] = {
    "cafe": {"label": "Café", "unit": "seats", "unit_one": "seat", "default_capacity": 30, "icon": "cafe"},
    "restaurant": {"label": "Restaurant", "unit": "seats", "unit_one": "seat", "default_capacity": 60, "icon": "restaurant"},
    "gym": {"label": "Gym", "unit": "people working out at once", "unit_one": "person", "default_capacity": 40, "icon": "gym"},
    "clinic": {"label": "Clinic", "unit": "people inside at once", "unit_one": "person", "default_capacity": 12, "icon": "clinic"},
    "daycare": {"label": "Daycare", "unit": "children", "unit_one": "child", "default_capacity": 40, "icon": "daycare"},
}


def _clean(value: Any) -> Any:
    """pandas/numpy scalars → plain Python, NaN/NA → None."""
    if value is None:
        return None
    if isinstance(value, (list, dict, str, bool)):
        return value
    if hasattr(value, "tolist") and not isinstance(value, (int, float)):
        value = value.tolist()
        if isinstance(value, list):
            return [_clean(v) for v in value]
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _records(df: pd.DataFrame) -> list[dict[str, Any]]:
    return [{k: _clean(v) for k, v in row.items()} for row in df.to_dict("records")]


@dataclass(frozen=True)
class Store:
    spaces: list[dict[str, Any]]
    space_by_id: dict[int, dict[str, Any]]
    features: dict[int, dict[str, Any]]
    benchmarks: dict[str, Any]
    rules: list[dict[str, Any]]
    assumptions: dict[str, Any]
    disclaimer: str
    ibc_note: str
    graph: nx.MultiDiGraph


@lru_cache(maxsize=1)
def get_store() -> Store:
    missing = [p.name for p in (BUILT / "spaces.parquet", BUILT / "building_features.parquet",
                                BUILT / "benchmarks.json", BUILT / "graph.pkl") if not p.exists()]
    if missing:
        raise RuntimeError(f"Pipeline outputs missing: {missing}. Run `python pipeline/build_all.py` first.")
    spaces = _records(pd.read_parquet(BUILT / "spaces.parquet"))
    for s in spaces:
        s["features"] = list(s.get("features") or [])
        s["building_tours"] = json.loads(s.get("building_tours") or "[]")
    features = {int(r["property_id"]): r for r in _records(pd.read_parquet(BUILT / "building_features.parquet"))}
    rules_doc = json.loads((ROOT / "rules" / "rules.json").read_text(encoding="utf-8"))
    with open(BUILT / "graph.pkl", "rb") as f:
        graph = pickle.load(f)
    return Store(
        spaces=spaces,
        space_by_id={int(s["space_id"]): s for s in spaces},
        features=features,
        benchmarks=json.loads((BUILT / "benchmarks.json").read_text(encoding="utf-8")),
        rules=rules_doc["rules"],
        assumptions=rules_doc["assumptions"],
        disclaimer=rules_doc["disclaimer"],
        ibc_note=rules_doc["ibc_note"],
        graph=graph,
    )
