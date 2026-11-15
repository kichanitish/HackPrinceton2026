"""Build the knowledge graph that powers "Why this space?".

    Space ─IN→ Building ─IN_MARKET→ Market ─FOLLOWS→ State ─HAS_RULE→ Rule ←REQUIRES─ BusinessType
    Building ─HAD_TENANT→ Company ─IS_A→ BusinessType
    Building ─HAD_BUILDOUT→ BusinessType            (build-out recorded on a past tenancy)
    Building ─NEAR(≤0.5 mi)→ ApartmentCommunity     (units)
    Building ─NEAR(≤0.5 mi)→ Building               (office workers)
    Building ─COMPETITOR_NEARBY(≤0.25 mi)→ Company  (same business type, trading now)
    Space ─HAS_TOUR→ MatterportModel

Outputs (data/built/):
    graph.pkl                   the networkx graph
    building_features.parquet   per-building aggregates read from the graph, for fast ranking

Usage: python pipeline/build_graph.py
"""
from __future__ import annotations

import json
import pickle

import networkx as nx
import numpy as np
import pandas as pd

from common import BUILT, BUILDOUT_TO_BUSINESS, EARTH_RADIUS_MI, MARKETS, ROOT

NEAR_MI = 0.5
COMPETITOR_MI = 0.25
BUSINESSES = ["cafe", "restaurant", "gym", "clinic", "daycare"]
BIZ_LABEL = {"cafe": "Café", "restaurant": "Restaurant", "gym": "Gym", "clinic": "Clinic", "daycare": "Daycare",
             "food": "Food & drink"}


def nn(value):
    """pandas NA/NaN → None, so `or` fallbacks behave."""
    return None if value is None or (not isinstance(value, (list, dict)) and pd.isna(value)) else value


def pairwise_miles(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    """Haversine distance matrix, shape (len(lat1), len(lat2)), in miles."""
    p1, p2 = np.radians(lat1)[:, None], np.radians(lat2)[None, :]
    dp = p2 - p1
    dl = np.radians(lon2)[None, :] - np.radians(lon1)[:, None]
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * np.arcsin(np.sqrt(a))


def build() -> None:
    spaces = pd.read_parquet(BUILT / "spaces.parquet")
    props = pd.read_parquet(BUILT / "properties.parquet")
    tenants = pd.read_parquet(BUILT / "tenants.parquet")
    rules = json.loads((ROOT / "rules" / "rules.json").read_text(encoding="utf-8"))["rules"]

    g = nx.MultiDiGraph()

    # ---- fixed scaffolding: markets, states, rules, business types
    for m in MARKETS.values():
        g.add_node(f"market:{m['key']}", type="Market", label=m["name"])
        g.add_node(f"state:{m['state']}", type="State", label=m["state_name"])
        g.add_edge(f"market:{m['key']}", f"state:{m['state']}", key="FOLLOWS", rel="FOLLOWS")
    for b in BUSINESSES + ["food"]:
        g.add_node(f"biz:{b}", type="BusinessType", label=BIZ_LABEL[b])
    for r in rules:
        g.add_node(f"rule:{r['id']}", type="Rule", label=r["code"], **{k: r[k] for k in ("title", "sqft_per_person", "basis", "source_url", "jurisdiction", "role", "per", "plain")})
        for b in r["business"]:
            g.add_edge(f"biz:{b}", f"rule:{r['id']}", key="REQUIRES", rel="REQUIRES")
        for st in r["states"]:
            g.add_edge(f"state:{st}", f"rule:{r['id']}", key="HAS_RULE", rel="HAS_RULE")

    # ---- business-zone requirements: BusinessType ─REQUIRES_ZONE→ ZoneRequirement ─SIZED_BY→ Rule
    zones_doc = json.loads((ROOT / "rules" / "zones.json").read_text(encoding="utf-8"))
    for biz, zones in zones_doc["zones"].items():
        for order, z in enumerate(zones):
            znode = f"zone:{biz}:{z['id']}"
            src = zones_doc["sources"].get(z["source"], {"label": "State licensing rule", "url": None})
            g.add_node(znode, type="ZoneRequirement", label=z["label"], business=biz, order=order,
                       severity=z["severity"], spec=json.dumps(z), source_label=src["label"], source_url=src["url"])
            g.add_edge(f"biz:{biz}", znode, key="REQUIRES_ZONE", rel="REQUIRES_ZONE")
            per_person = z["area"].get("per_person")
            if per_person:
                role = "outdoor" if per_person == "outdoor_rule" else "capacity"
                for r in rules:
                    if biz in r["business"] and r["role"] == role:
                        g.add_edge(znode, f"rule:{r['id']}", key="SIZED_BY", rel="SIZED_BY")

    # ---- buildings that have space for lease (kit buildings plus the few known only from a listing)
    bld = (spaces.sort_values("in_kit", ascending=False)
           .groupby("property_id", as_index=False)
           .agg(lat=("lat", "first"), lon=("lon", "first"), market=("market", "first"), address=("address", "first"),
                building_name=("building_name", "first"), in_kit=("in_kit", "first"), n_spaces=("space_id", "count")))
    bld = bld[bld.lat.notna() & bld.lon.notna()].reset_index(drop=True)
    for r in bld.itertuples():
        g.add_node(f"building:{r.property_id}", type="Building", label=nn(r.building_name) or nn(r.address), address=nn(r.address),
                   in_kit=bool(r.in_kit), lat=r.lat, lon=r.lon)
        if nn(r.market):
            g.add_edge(f"building:{r.property_id}", f"market:{r.market}", key="IN_MARKET", rel="IN_MARKET")
    for s in spaces.itertuples():
        g.add_node(f"space:{s.space_id}", type="Space", label=f"Suite {s.suite}" if nn(s.suite) else "Space", sqft=s.sqft_max)
        g.add_edge(f"space:{s.space_id}", f"building:{s.property_id}", key="IN", rel="IN")
        if nn(s.tour_model_id):
            g.add_node(f"tour:{s.tour_model_id}", type="MatterportModel", label=nn(s.tour_caption) or "3D tour")
            g.add_edge(f"space:{s.space_id}", f"tour:{s.tour_model_id}", key="HAS_TOUR", rel="HAS_TOUR", level=s.tour_level)

    # ---- tenants: who operated in each building, and what they were
    space_buildings = set(bld.property_id)
    classified = tenants[(tenants.business.notna() | tenants.food_by_industry) & tenants.company_id.notna()]
    for t in classified.itertuples():
        cid = f"company:{int(t.company_id)}"
        business = t.business if isinstance(t.business, str) else "food"  # NaN → found by industry code only
        if cid not in g:
            g.add_node(cid, type="Company", label=t.name, business=business)
            g.add_edge(cid, f"biz:{business}", key="IS_A", rel="IS_A")
            if business in ("cafe", "restaurant"):
                g.add_edge(cid, "biz:food", key="IS_A_FOOD", rel="IS_A")
        if t.property_id in space_buildings:
            g.add_edge(f"building:{t.property_id}", cid, rel="HAD_TENANT", current=bool(t.current),
                       from_year=None if pd.isna(t.from_year) else int(t.from_year),
                       to_year=None if pd.isna(t.to_year) else int(t.to_year),
                       sqft=None if pd.isna(t.sqft) else float(t.sqft))
    for t in tenants[tenants.buildouts.notna() & tenants.property_id.isin(space_buildings)].itertuples():
        for bo in t.buildouts.split(","):
            g.add_edge(f"building:{t.property_id}", f"biz:{BUILDOUT_TO_BUSINESS[bo]}", rel="HAD_BUILDOUT", buildout=bo,
                       year=None if pd.isna(t.from_year) else int(t.from_year), tenant=t.name)

    # ---- what is near each building
    kit = props[props.lat.notna() & props.lon.notna()].reset_index(drop=True)
    dist = pairwise_miles(bld.lat.to_numpy(), bld.lon.to_numpy(), kit.lat.to_numpy(), kit.lon.to_numpy())

    # office workers: employees of current tenants, per kit property (capped to tame head-office outliers)
    cur = tenants[tenants.current & tenants.employees.notna()].copy()
    cap = float(cur.employees.quantile(0.99))
    cur["employees"] = cur.employees.clip(upper=cap)
    workers_by_prop = cur.groupby("property_id").employees.sum().to_dict()
    kit_workers = kit.property_id.map(workers_by_prop).fillna(0).to_numpy()
    kit_units = kit.apt_units.fillna(0).to_numpy()
    kit_ids = kit.property_id.to_numpy()

    # trading competitors by building
    comp_by_prop: dict[int, list] = {}
    for t in tenants[tenants.current & tenants.business.notna() & tenants.company_id.notna()].itertuples():
        comp_by_prop.setdefault(t.property_id, []).append((int(t.company_id), t.business, t.name))

    feats = []
    for i, r in enumerate(bld.itertuples()):
        bnode = f"building:{r.property_id}"
        near = np.where(dist[i] <= NEAR_MI)[0]
        apt_units = apt_n = workers = 0
        for j in near:
            pid = int(kit_ids[j])
            miles = round(float(dist[i, j]), 3)
            if kit_units[j] > 0:
                anode = f"apt:{pid}"
                if anode not in g:
                    g.add_node(anode, type="ApartmentCommunity", label=nn(kit.building_name[j]) or nn(kit.address[j]), units=int(kit_units[j]))
                g.add_edge(bnode, anode, rel="NEAR", miles=miles, units=int(kit_units[j]), same_building=pid == r.property_id)
                apt_units += int(kit_units[j])
                apt_n += 1
            if kit_workers[j] > 0:
                workers += kit_workers[j]
                if pid != r.property_id:
                    onode = f"building:{pid}"
                    if onode not in g:
                        g.add_node(onode, type="Building", label=nn(kit.building_name[j]) or nn(kit.address[j]), address=nn(kit.address[j]),
                                   in_kit=True, lat=float(kit.lat[j]), lon=float(kit.lon[j]))
                    g.add_edge(bnode, onode, rel="NEAR", miles=miles, employees=int(kit_workers[j]))
        row = {"property_id": r.property_id, "market": nn(r.market), "in_kit": bool(r.in_kit),
               "apt_units_nearby": apt_units, "apt_communities_nearby": apt_n,
               "workers_nearby": int(workers), "workers_in_building": int(workers_by_prop.get(r.property_id, 0))}
        competitors = {b: 0 for b in BUSINESSES}
        for j in np.where(dist[i] <= COMPETITOR_MI)[0]:
            pid = int(kit_ids[j])
            for cid, business, name in comp_by_prop.get(pid, []):
                competitors[business] += 1
                g.add_edge(bnode, f"company:{cid}", rel="COMPETITOR_NEARBY", miles=round(float(dist[i, j]), 3),
                           same_building=pid == r.property_id)
        for b in BUSINESSES:
            row[f"competitors_{b}"] = competitors[b]
        # tenant history, straight from the graph
        past = {b: set() for b in BUSINESSES + ["food"]}
        for _, cnode, d in g.out_edges(bnode, data=True):
            if d.get("rel") == "HAD_TENANT":
                business = g.nodes[cnode]["business"]
                past[business].add(g.nodes[cnode]["label"])
                if business in ("cafe", "restaurant", "food"):
                    past["food"].add(g.nodes[cnode]["label"])
        for b in BUSINESSES + ["food"]:
            row[f"tenants_{b}"] = len(past[b])
        buildouts = {d["buildout"] for _, _, d in g.out_edges(bnode, data=True) if d.get("rel") == "HAD_BUILDOUT"}
        row["buildout_food"] = any(BUILDOUT_TO_BUSINESS[b] == "food" for b in buildouts)
        row["buildout_clinic"] = any(BUILDOUT_TO_BUSINESS[b] == "clinic" for b in buildouts)
        feats.append(row)

    feat = pd.DataFrame(feats)
    # demand percentiles within each market, so "busy for Houston" and "busy for LA" are both visible
    for col in ("apt_units_nearby", "workers_nearby"):
        feat[col.replace("_nearby", "_pct")] = feat.groupby("market")[col].rank(pct=True).round(3)
    feat.to_parquet(BUILT / "building_features.parquet", index=False)
    with open(BUILT / "graph.pkl", "wb") as f:
        pickle.dump(g, f, protocol=pickle.HIGHEST_PROTOCOL)

    # ---- report
    kinds = pd.Series([d["type"] for _, d in g.nodes(data=True)]).value_counts().to_dict()
    rels = pd.Series([d["rel"] for _, _, d in g.edges(data=True)]).value_counts().to_dict()
    print(f"graph: {g.number_of_nodes():,} nodes, {g.number_of_edges():,} edges")
    print(" nodes:", kinds)
    print(" edges:", rels)
    food_b = feat[feat.tenants_food > 0]
    retail = spaces[spaces.space_use.isin(["Retail", "OfficeRetail"])]
    print(f"buildings with a past/current food tenant: {len(food_b)} of {len(feat)}")
    print(f"retail / office-retail spaces in such buildings: {int(retail.property_id.isin(food_b.property_id).sum())} of {len(retail)}")
    print(f"buildings with a recorded food build-out: {int(feat.buildout_food.sum())}, clinic build-out: {int(feat.buildout_clinic.sum())}")
    print("median nearby (0.5 mi):", feat.groupby("market")[["apt_units_nearby", "workers_nearby"]].median().to_dict())
    print("buildings with a nearby café competitor:", int((feat.competitors_cafe > 0).sum()))
    print(f"employee cap (99th pct): {cap:,.0f}")


if __name__ == "__main__":
    build()
