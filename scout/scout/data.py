"""Everything Scout searches, loaded once: apartment floor plans (HomeFit catalog), commercial spaces for lease,
the buildings around them, their tenants, and the demand points (apartment units, office workers)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from api.store import get_store
from .geo import CITIES

ROOT = Path(__file__).resolve().parent.parent
BUILT = ROOT / "data" / "built"
HOMES = ROOT / "data" / "homes" / "catalog.json"
CITY_KEY = {"Houston": "houston", "Los Angeles": "los_angeles"}


@dataclass(frozen=True)
class Data:
    homes: list[dict[str, Any]]                  # one row per apartment community, plans inside
    home_by_id: dict[int, dict[str, Any]]
    spaces: list[dict[str, Any]]                 # commercial spaces for lease with coordinates
    space_by_id: dict[int, dict[str, Any]]
    tenants: pd.DataFrame                        # who occupied which building, when
    props: pd.DataFrame                          # every building in the kit
    benchmarks: dict[str, Any]
    snapshot: str
    # demand points per city: apartment units and office workers, as arrays for fast radius sums
    demand: dict[str, dict[str, np.ndarray]]


def _demand(props: pd.DataFrame, tenants: pd.DataFrame, homes: list[dict]) -> dict[str, dict[str, np.ndarray]]:
    out: dict[str, dict[str, np.ndarray]] = {}
    units = props[props["apt_units"].fillna(0) > 0][["property_id", "lat", "lon", "apt_units"]]
    seen = set(units["property_id"].astype(int))
    extra = [(h["id"], h["lat"], h["lng"], h.get("units") or 0) for h in homes if h["id"] not in seen and (h.get("units") or 0) > 0]
    u = pd.concat([units.rename(columns={"apt_units": "n"}),
                   pd.DataFrame(extra, columns=["property_id", "lat", "lon", "n"])], ignore_index=True)
    workers = tenants[tenants["current"] & tenants["employees"].notna()].merge(props[["property_id", "lat", "lon"]], on="property_id")
    w = workers.groupby(["property_id", "lat", "lon"], as_index=False)["employees"].sum()
    for key, c in CITIES.items():
        s, wb, n, e = c["bbox"]
        inside = lambda d: d[(d.lat >= s) & (d.lat <= n) & (d.lon >= wb) & (d.lon <= e)]
        uu, ww = inside(u), inside(w)
        out[key] = {"units_lat": uu.lat.to_numpy(float), "units_lon": uu.lon.to_numpy(float), "units": uu.n.to_numpy(float),
                    "work_lat": ww.lat.to_numpy(float), "work_lon": ww.lon.to_numpy(float), "workers": ww.employees.to_numpy(float)}
    return out


@lru_cache(maxsize=1)
def get_data() -> Data:
    doc = json.loads(HOMES.read_text(encoding="utf-8"))
    homes = []
    for h in doc["properties"]:
        if h.get("lat") is None or h.get("city") not in CITY_KEY:
            continue
        h = dict(h)
        h["city_key"] = CITY_KEY[h["city"]]
        homes.append(h)
    store = get_store()
    spaces = [s for s in store.spaces if s.get("lat") is not None and s.get("market") in CITIES]
    tenants = pd.read_parquet(BUILT / "tenants.parquet")
    props = pd.read_parquet(BUILT / "properties.parquet")
    return Data(homes=homes, home_by_id={int(h["id"]): h for h in homes}, spaces=spaces,
                space_by_id={int(s["space_id"]): s for s in spaces}, tenants=tenants, props=props,
                benchmarks=store.benchmarks, snapshot=doc.get("snapshotDate", "2026-11-12"),
                demand=_demand(props, tenants, homes))
