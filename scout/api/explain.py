"""'Why this space?' — every reason is a path through the knowledge graph, with its evidence and its caveat."""
from __future__ import annotations

import re
from typing import Any

from .parse import Program
from .sizing import max_capacity, net_to_gross, rules_for
from .store import BUSINESSES, MARKETS, Store

BIZ_WORD = {"cafe": "café", "restaurant": "restaurant", "gym": "gym", "clinic": "medical practice", "daycare": "childcare centre"}
HISTORY_TYPES = {"cafe": ("cafe", "restaurant", "food"), "restaurant": ("cafe", "restaurant", "food"),
                 "gym": ("gym",), "clinic": ("clinic",), "daycare": ("daycare",)}
BUILDOUT_KIND = {"cafe": "food", "restaurant": "food", "clinic": "clinic"}
BUILDOUT_LABEL = {"RestaurantsAndCafes": "restaurant / café", "FastFood": "fast food", "QuickService": "quick-service restaurant",
                  "BarOrNightclub": "bar", "StandardMedical": "medical", "Dental": "dental", "PhysicalTherapy": "physical therapy",
                  "Healthcare": "healthcare"}

NOTE_EVIDENCE = {
    "cafe": r"second[- ]gen|2nd[- ]gen|restaurant|caf[eé]|coffee|kitchen|hood|grease|patio|dining|bakery|food|drive[- ]?thr",
    "restaurant": r"second[- ]gen|2nd[- ]gen|restaurant|caf[eé]|kitchen|hood|grease|patio|dining|bar\b|food|drive[- ]?thr",
    "gym": r"fitness|gym|studio|ceiling|open (floor|layout|concept)|clear height|shower|locker",
    "clinic": r"medical|dental|exam|operator|x-?ray|lab\b|nurse|procedure|clinic|physician|plumb",
    "daycare": r"day ?care|child ?care|preschool|school|playground|play area|outdoor|fenced|yard",
}


def _n(node: str, graph, kind: str | None = None) -> dict[str, str]:
    d = graph.nodes[node]
    return {"id": node, "label": str(d.get("label") or node), "type": kind or d.get("type", "")}


def _path(*steps: Any) -> list[dict[str, str]]:
    """Alternating nodes and edge names → a flat list the UI renders as chips and arrows."""
    out = []
    for s in steps:
        out.append({"edge": s} if isinstance(s, str) else s)
    return out


def _sentences(notes: str, pattern: str, limit: int = 2) -> list[str]:
    hits = []
    for sent in re.split(r"(?<=[.!?])\s+|\s{2,}|\s•\s", notes):
        sent = sent.strip()
        if 12 <= len(sent) and re.search(pattern, sent, re.I):
            hits.append(sent if len(sent) <= 220 else sent[:217].rsplit(" ", 1)[0] + "…")
        if len(hits) >= limit:
            break
    return hits


def explain(store: Store, program: Program, space: dict[str, Any], take: float) -> dict[str, Any]:
    g = store.graph
    biz, market = program.business, MARKETS[program.market]
    word, unit = BIZ_WORD[biz], BUSINESSES[biz]["unit"]
    snode, bnode = f"space:{space['space_id']}", f"building:{space['property_id']}"
    feat = store.features.get(int(space["property_id"]), {})
    S, B = _n(snode, g), _n(bnode, g)
    BIZ = _n(f"biz:{biz}", g)
    reasons: list[dict[str, Any]] = []
    sub_nodes: dict[str, dict[str, str]] = {S["id"]: S, B["id"]: B, BIZ["id"]: BIZ}
    sub_edges: list[dict[str, str]] = [{"source": S["id"], "target": B["id"], "label": "IN"}]

    def link(a: dict[str, str], b: dict[str, str], label: str) -> None:
        sub_nodes[a["id"]], sub_nodes[b["id"]] = a, b
        sub_edges.append({"source": a["id"], "target": b["id"], "label": label})

    # ---- 1. legal fit
    rules = rules_for(store, biz, market["state"])
    rule = rules["capacity"]
    supported = max_capacity(store, biz, market["state"], take)
    M, ST, R = _n(f"market:{program.market}", g), _n(f"state:{market['state']}", g), _n(f"rule:{rule['id']}", g)
    link(B, M, "IN_MARKET"); link(M, ST, "FOLLOWS"); link(ST, R, "HAS_RULE"); link(BIZ, R, "REQUIRES")
    ntg = net_to_gross(store, biz)
    if rule["basis"] == "net":
        calc = f"{take:,.0f} sq ft × {ntg['value']:.2f} usable ÷ {rule['sqft_per_person']} sq ft per {rule['per']} = {supported:,}"
    else:
        calc = f"{take:,.0f} sq ft ÷ {rule['sqft_per_person']} sq ft per {rule['per']} = {supported:,}"
    fits = supported >= program.capacity
    reasons.append({
        "id": "legal", "tone": "good" if fits else "warn",
        "title": (f"Holds {supported:,} {unit} under the code's space rule — you need {program.capacity:,}" if fits
                  else f"Holds only {supported:,} {unit} under the code's space rule — you need {program.capacity:,}"),
        "detail": f"{calc}. {rule['plain']}",
        "evidence": [],
        "path": _path(S, "IN", B, "IN_MARKET", M, "FOLLOWS", ST, "HAS_RULE", R),
        "source": {"label": rule["code"], "url": rule["source_url"]},
        "caveat": "First screen, not legal approval. Confirm the occupant load with an architect or the city.",
    })

    # ---- 2. what the broker says about this very suite
    if space.get("notes"):
        quotes = _sentences(space["notes"], NOTE_EVIDENCE[biz])
        if quotes:
            reasons.append({
                "id": "broker_note", "tone": "good",
                "title": "The broker's note describes a fit-out you can use",
                "detail": "This is about the suite itself, not just the building.",
                "evidence": [{"quote": q} for q in quotes],
                "path": _path(S, "DESCRIBED_BY", {"id": "note", "label": "Broker's space note", "type": "Note"}),
                "source": {"label": "CoStar kit · listing space note", "url": None},
                "caveat": "Marketing text from the listing. Check the condition on a visit or in the 3D tour.",
            })

    # ---- 3. tenant history in the building
    wanted = HISTORY_TYPES[biz]
    tenants = []
    for _, cnode, d in g.out_edges(bnode, data=True):
        if d.get("rel") == "HAD_TENANT" and g.nodes[cnode].get("business") in wanted:
            tenants.append({"node": cnode, "name": g.nodes[cnode]["label"], "business": g.nodes[cnode]["business"],
                            "current": d.get("current"), "from_year": d.get("from_year"), "to_year": d.get("to_year"),
                            "sqft": d.get("sqft")})
    seen, uniq = set(), []
    for t in sorted(tenants, key=lambda t: (not t["current"], -(t["to_year"] or 9999), -(t["from_year"] or 0))):
        if t["name"] not in seen:
            seen.add(t["name"])
            uniq.append(t)
    buildouts = sorted({(d["buildout"], d.get("tenant")) for _, t, d in g.out_edges(bnode, data=True)
                        if d.get("rel") == "HAD_BUILDOUT" and t == f"biz:{BUILDOUT_KIND.get(biz, '-')}"}, key=str)
    if uniq or buildouts:
        ev = []
        for t in uniq[:5]:
            when = ("there now" if t["current"] else
                    f"{t['from_year'] or '?'}–{t['to_year']}" if t["to_year"] else "past tenant")
            size = f", {t['sqft']:,.0f} sq ft" if t.get("sqft") and t["sqft"] != 500 else ""
            ev.append({"name": t["name"], "meta": f"{when}{size}"})
            link(B, _n(t["node"], g), "HAD_TENANT")
            link(_n(t["node"], g), _n(f"biz:{t['business']}", g) if t["business"] != "food" else _n("biz:food", g), "IS_A")
        for bo, tenant in buildouts[:3]:
            ev.append({"name": f"{BUILDOUT_LABEL.get(bo, bo).capitalize()} build-out on record",
                       "meta": f"tenancy of {tenant}" if tenant else "past tenancy"})
        kind = "food business" if biz in ("cafe", "restaurant") else word
        n = len(uniq)
        title = (f"{n} {kind}{'es' if kind.endswith('s') and n != 1 else 's' if n != 1 else ''} operated in this building"
                 if n else f"A {BUILDOUT_LABEL.get(buildouts[0][0], 'matching')} build-out was recorded in this building")
        first = uniq[0] if uniq else None
        reasons.append({
            "id": "history", "tone": "good",
            "title": title,
            "detail": ("Plumbing, venting, grease and power for food service may already exist somewhere in the building."
                       if biz in ("cafe", "restaurant") else
                       "Other practices here mean patients already come to this address, and medical plumbing may exist."
                       if biz == "clinic" else f"The building has hosted a {word} before."),
            "evidence": ev,
            "path": (_path(S, "IN", B, "HAD_TENANT", _n(first["node"], g), "IS_A",
                           _n("biz:food" if first["business"] == "food" else f"biz:{first['business']}", g)) if first
                     else _path(S, "IN", B, "HAD_BUILDOUT", BIZ)),
            "source": {"label": f"CoStar kit · location-occupancy + company-detail ({len(tenants) or len(buildouts)} tenancies)", "url": None},
            "caveat": "Building-level, not suite-level: the kit does not say which suite these tenants used.",
        })

    # ---- 4. customers nearby
    apts, offices = [], []
    for _, other, d in g.out_edges(bnode, data=True):
        if d.get("rel") != "NEAR":
            continue
        if other.startswith("apt:"):
            apts.append({"node": other, "name": g.nodes[other]["label"], "units": d["units"], "miles": d["miles"],
                         "same": d.get("same_building")})
        elif d.get("employees"):
            offices.append({"node": other, "name": g.nodes[other]["label"], "employees": d["employees"], "miles": d["miles"]})
    units, workers = int(feat.get("apt_units_nearby") or 0), int(feat.get("workers_nearby") or 0)
    if units or workers:
        ev = []
        for a in sorted(apts, key=lambda a: (not a["same"], -a["units"]))[:4]:
            where = "this building" if a["same"] else f"{a['miles']:.2f} mi"
            ev.append({"name": a["name"], "meta": f"{a['units']:,} apartments · {where}"})
            link(B, _n(a["node"], g), "NEAR")
        for o in sorted(offices, key=lambda o: -o["employees"])[:3]:
            ev.append({"name": o["name"], "meta": f"{o['employees']:,} office workers · {o['miles']:.2f} mi"})
            link(B, _n(o["node"], g), "NEAR")
        in_bldg = int(feat.get("workers_in_building") or 0)
        bits = []
        if units:
            bits.append(f"{units:,} apartments in {int(feat.get('apt_communities_nearby') or 0)} communities")
        if workers:
            bits.append(f"{workers:,} office workers" + (f" ({in_bldg:,} in this building)" if in_bldg else ""))
        pct = feat.get("apt_units_pct") or 0
        rank = (f" More residents nearby than {pct:.0%} of {market['name']} buildings with space for lease." if units and pct >= 0.5 else "")
        top = sorted(apts, key=lambda a: -a["units"])[:1]
        reasons.append({
            "id": "demand", "tone": "good" if max(pct, feat.get("workers_pct") or 0) >= 0.5 else "neutral",
            "title": "Customers within half a mile: " + " and ".join(bits),
            "detail": f"Counted from kit properties within 0.5 mi of the building.{rank}",
            "evidence": ev,
            "path": (_path(S, "IN", B, "NEAR ≤0.5 mi", _n(top[0]["node"], g)) if top else _path(S, "IN", B, "NEAR ≤0.5 mi", {"id": "o", "label": "Office tenants", "type": "Building"})),
            "source": {"label": "CoStar kit · commercial-property, apartment-listing, company-detail (numEmployees)", "url": None},
            "caveat": "The kit covers only buildings on CoStar's Matterport list, so real totals are higher. Employee counts are snapshots.",
        })

    # ---- 5. competition
    if biz != "clinic":
        comps = []
        for _, cnode, d in g.out_edges(bnode, data=True):
            if d.get("rel") == "COMPETITOR_NEARBY" and g.nodes[cnode].get("business") == biz:
                comps.append({"node": cnode, "name": g.nodes[cnode]["label"], "miles": d["miles"], "same": d.get("same_building")})
        names, uniq_c = set(), []
        for c in sorted(comps, key=lambda c: c["miles"]):
            if c["name"] not in names:
                names.add(c["name"])
                uniq_c.append(c)
        if uniq_c:
            for c in uniq_c[:3]:
                link(B, _n(c["node"], g), "COMPETITOR")
            reasons.append({
                "id": "competition", "tone": "warn" if len(uniq_c) > 2 else "neutral",
                "title": f"{len(uniq_c)} {word}{'s' if len(uniq_c) != 1 else ''} already trading within a quarter mile",
                "detail": ("Proof people come here for this — and people you will share them with."),
                "evidence": [{"name": c["name"], "meta": "in this building" if c["same"] else f"{c['miles']:.2f} mi"} for c in uniq_c[:5]],
                "path": _path(S, "IN", B, "COMPETITOR ≤0.25 mi", _n(uniq_c[0]["node"], g), "IS_A", BIZ),
                "source": {"label": "CoStar kit · current tenancies, matched by tenant name", "url": None},
                "caveat": "Only tenants of kit buildings are counted; name matching can miss or mislabel a business.",
            })
        elif not feat or not space.get("in_kit"):
            reasons.append({
                "id": "competition", "tone": "neutral",
                "title": "Competition unknown",
                "detail": "CoStar has no tenant records for this building or its block, so nearby competitors can't be counted.",
                "evidence": [], "path": _path(S, "IN", B, "COMPETITOR ≤0.25 mi", {"id": "none", "label": "no data", "type": "Company"}),
                "source": {"label": "CoStar kit · current tenancies", "url": None},
                "caveat": "Missing data, not missing competitors.",
            })
        else:
            reasons.append({
                "id": "competition", "tone": "good",
                "title": f"No other {word} in CoStar tenant records within a quarter mile",
                "detail": "No current tenant of that type in kit buildings within 0.25 mi.",
                "evidence": [], "path": _path(S, "IN", B, "COMPETITOR ≤0.25 mi", {"id": "none", "label": "none found", "type": "Company"}),
                "source": {"label": "CoStar kit · current tenancies, matched by tenant name", "url": None},
                "caveat": "Absence in the kit is not absence on the street — the kit is not a full market sample.",
            })

    # ---- 6. tour
    if space.get("tour_model_id"):
        T = _n(f"tour:{space['tour_model_id']}", g)
        link(S, T, "HAS_TOUR")
        if space["tour_level"] == "suite":
            reasons.append({
                "id": "tour", "tone": "good",
                "title": "You can walk this exact suite in 3D",
                "detail": f"Matterport tour “{space.get('tour_caption') or 'Suite tour'}”, matched to the space by {space.get('tour_matched_by')}.",
                "evidence": [], "path": _path(S, "HAS_TOUR", T),
                "source": {"label": "CoStar kit · Matterport attachment", "url": None}, "caveat": None,
            })

    return {"reasons": reasons, "rent_check": rent_check(store, program, space, take),
            "graph": {"nodes": list(sub_nodes.values()), "edges": sub_edges},
            "graph_size": {"nodes": g.number_of_nodes(), "edges": g.number_of_edges()}}


def rent_check(store: Store, program: Program, space: dict[str, Any], take: float) -> dict[str, Any]:
    """Asking rent against what similar space asks, and what was actually signed, in the same market."""
    use = space["space_use"]
    asking = (store.benchmarks["rent_asking"].get(program.market) or {}).get(use)
    signed = (store.benchmarks["rent_signed"].get(program.market) or {}).get(use)
    low, high = space.get("rate_low_yr"), space.get("rate_high_yr")
    out: dict[str, Any] = {
        "known": low is not None, "low": low, "high": high, "service_type": space.get("service_type"),
        "quoted_monthly": bool(space.get("rate_quoted_monthly")), "space_use": use, "market_name": MARKETS[program.market]["name"],
        "asking": asking, "signed": signed,
        "asking_method": store.benchmarks["rent_asking_method"], "signed_method": store.benchmarks["rent_signed_method"],
        "caveat": "Rents mix service types (full service, triple net…), so compare with care. Asking is not what gets signed.",
    }
    if low is None:
        out["verdict"] = "Rent on request — the listing gives no asking rate."
        out["tone"] = "neutral"
        return out
    mid = (low + (high or low)) / 2
    out["monthly_est"] = round(mid * take / 12)
    out["annual_est"] = round(mid * take)
    ref = signed or asking
    if ref:
        pct = round((mid / ref["median"] - 1) * 100)
        kind = "signed deals" if signed else "asking rents"
        out["vs_pct"] = pct
        out["tone"] = "good" if pct <= -5 else "warn" if pct >= 15 else "neutral"
        out["verdict"] = (f"Asking ${mid:,.2f}/sq ft/yr — {abs(pct)}% {'below' if pct < 0 else 'above'} the median of "
                          f"{ref['n']} {use.lower()} {kind} in {out['market_name']} (${ref['median']:,.2f})."
                          if pct else f"Asking ${mid:,.2f}/sq ft/yr — in line with {ref['n']} {use.lower()} {kind} in {out['market_name']}.")
    else:
        out["tone"] = "neutral"
        out["verdict"] = f"Asking ${mid:,.2f}/sq ft/yr. Too few comparable {use.lower()} rents in the kit to benchmark."
    if program.budget_psf_yr:
        out["budget_psf_yr"] = program.budget_psf_yr
    return out
