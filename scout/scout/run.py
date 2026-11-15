"""One search run: the brief, everything the agent searched, its top 10 and the three deep dives.

The run enforces the rules the page relies on: the agent picks all ten itself from what it searched (the server
never fills slots), deep dives exist only for the top three, every change to the brief after the first version is
an adjustment the page shows, and fields the user set by hand can't be changed by the agent.
"""
from __future__ import annotations

import re
import threading
import uuid
from typing import Any

from . import compare
from .brief import Anchor, Brief, resolve_anchor
from .profiles import PROFILES, match_profile

TOP_N = 10
DEEP_N = 3
WORD_LIMIT = 12


def words(s: str) -> int:
    return len(re.findall(r"\S+", s or ""))


class Run:
    def __init__(self, mode: str | None, query: str, brief: Brief | None = None, city: str = "houston"):
        self.id = uuid.uuid4().hex
        self.mode = brief.mode if brief else mode          # None: the agent decides from the request
        self.mode_locked = self.mode is not None             # the user chose it (or edited the brief)
        self.query = query
        self.query_city = brief.city if brief else city
        self.brief: Brief | None = brief
        self.locked: set[str] = set(brief.locked) if brief else set()
        self.first: dict | None = brief.model_dump() if brief else None
        self.candidates: dict[int, dict] = {}
        self.last_total: int | None = None
        self.zones: list[dict] = []
        self.top: list[int] = []
        self.deep: dict[int, dict] = {}
        self.events: list[dict] = []
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- events
    def emit(self, ev: dict) -> None:
        with self._lock:
            self.events.append(ev)

    def drain(self) -> list[dict]:
        with self._lock:
            out, self.events = self.events, []
        return out

    # ---------------------------------------------------------------- the brief
    def set_brief(self, fields: dict[str, Any], places_in: list[dict] | None, by: str = "agent") -> dict[str, Any]:
        """Create or change the brief. Returns what was applied, any problems and the resulting brief."""
        problems, refused = [], []
        fields = dict(fields)
        mode = fields.pop("mode", None)
        if mode and mode != self.mode:
            if self.mode_locked and by != "user":
                refused.append("mode")
            else:                                  # the search is a home or a business space: start that brief afresh
                self.mode, self.brief, self.first = mode, None, None
                self.emit({"type": "mode", "mode": mode})
        if self.mode is None:
            return {"accepted": False, "problems": ["Decide first: mode='home' (a place to live) or mode='commercial' (space for a business)."]}
        cur = self.brief.model_dump() if self.brief else {"mode": self.mode, "city": fields.get("city") or self.query_city}
        if fields.get("business"):
            words_given = str(fields["business"]).strip()
            key = fields.get("business_key") or match_profile(words_given)
            fields = {**fields, "business": key, "business_label": fields.get("business_label") or words_given.lower()}
            if not fields.get("space_uses") and "space_uses" not in self.locked:
                fields["space_uses"] = list(PROFILES[key]["uses"])
        for k, v in fields.items():
            if v is None or k in ("business_key",):
                continue
            if by != "user" and k in self.locked and cur.get(k) != v:
                refused.append(k)
                continue
            cur[k] = v
        if places_in is not None:
            if by != "user" and "anchors" in self.locked:
                refused.append("places")
            else:
                anchors = []
                for p in places_in:
                    a = resolve_anchor(cur["city"], str(p.get("place", "")), float(p.get("radius_mi") or 3))
                    if isinstance(a, dict):
                        problems.append(a["error"])
                    else:
                        anchors.append(a.model_dump())
                cur["anchors"] = anchors
        cur["mode"] = self.mode
        cur["locked"] = sorted(self.locked)
        prev = self.brief
        try:
            new = Brief(**{k: v for k, v in cur.items() if k != "adjustments"}, adjustments=prev.adjustments if prev else [])
        except Exception as e:   # pydantic validation: tell the agent exactly what's wrong
            return {"accepted": False, "problems": [str(e)[:400]]}
        if prev is not None and by != "user":
            new.adjustments = prev.adjustments + self._diff(prev, new)
        self.brief = new
        if self.first is None:
            self.first = new.model_dump()
        self.emit({"type": "brief", "brief": new.model_dump(), "chips": new.chips(), "adjustments": new.adjustments})
        return {"accepted": True, "problems": problems, "refused_locked": refused, "brief": self.brief_text(),
                "places": [{"label": a.label, "kind": a.kind, "count": a.count, "radius_mi": a.radius_mi} for a in new.anchors]}

    @staticmethod
    def _diff(a: Brief, b: Brief) -> list[dict]:
        out = []
        for k in ("budget_max", "sqft_min", "sqft_max", "beds", "baths_min", "zips", "space_uses", "ground_floor", "parking", "pets"):
            if getattr(a, k) != getattr(b, k):
                out.append({"field": k, "from": getattr(a, k), "to": getattr(b, k)})
        ra = {x.label: x.radius_mi for x in a.anchors}
        rb = {x.label: x.radius_mi for x in b.anchors}
        for lbl in set(ra) | set(rb):
            if ra.get(lbl) != rb.get(lbl):
                out.append({"field": f"near {lbl}", "from": ra.get(lbl), "to": rb.get(lbl)})
        return out

    def brief_text(self) -> str:
        b = self.brief
        if not b:
            return "(no brief yet)"
        return "; ".join(f"{c['label']}: {c['value']}" for c in b.chips())

    # ---------------------------------------------------------------- search results
    def add_candidates(self, cards: list[dict], total: int) -> None:
        for c in cards:
            self.candidates[c["id"]] = c
        self.last_total = total
        self.emit({"type": "search", "total": total, "shown": len(cards),
                   "points": [[c["id"], c["lat"], c["lon"]] for c in cards]})

    def set_zones(self, zones: list[dict]) -> None:
        self.zones = zones
        self.emit({"type": "zones", "zones": zones})

    # ---------------------------------------------------------------- the decision
    def submit_top(self, ids: list[int], by: str = "agent") -> dict[str, Any]:
        ids = [int(i) for i in ids]
        problems = []
        if len(set(ids)) != len(ids):
            problems.append("Each listing may appear once.")
        unknown = [i for i in ids if i not in self.candidates]
        if unknown:
            problems.append(f"These ids didn't come from your searches: {unknown}. Pick from search_listings results.")
        available = len(self.candidates)
        need = min(TOP_N, available)
        if len(ids) != need and not problems:
            problems.append(f"Pick exactly {need} listings (you have {available} candidates from your searches)."
                            if available >= TOP_N else f"Only {available} candidates exist; pick all {available}.")
        if problems:
            return {"accepted": False, "problems": problems}
        self.top = ids
        cards = [self.candidates[i] for i in ids]
        self.emit({"type": "top", "cards": cards, "comparison": compare.build(cards, self.brief), "by": by})
        return {"accepted": True, "picked": len(ids), "deep_dive_next": ids[:DEEP_N]}

    def add_deep(self, listing_id: int, context: dict, highlights: list[str], watch_outs: list[str], by: str = "agent") -> dict[str, Any]:
        lid = int(listing_id)
        if lid not in self.top[:DEEP_N]:
            return {"accepted": False, "problems": [f"Deep dives are for the top 3 picks only: {self.top[:DEEP_N]}."]}
        highlights = [h.strip() for h in highlights if h and h.strip()][:3]
        watch_outs = [w.strip() for w in watch_outs if w and w.strip()][:2]
        long = [h for h in highlights + watch_outs if words(h) > WORD_LIMIT]
        if long:
            return {"accepted": False, "problems": [f"Keep each line to {WORD_LIMIT} words: {long[:2]}"]}
        self.deep[lid] = {"id": lid, "rank": self.top.index(lid) + 1, "context": context, "highlights": highlights,
                          "watch_outs": watch_outs, "by": by}
        self.emit({"type": "deep", **self.deep[lid]})
        return {"accepted": True}


# ------------------------------------------------------------------ registry, found through the run config
_runs: dict[str, Run] = {}
_reg = threading.Lock()


def open_run(mode: str | None, query: str, brief: Brief | None = None, city: str = "houston") -> Run:
    r = Run(mode, query, brief, city)
    with _reg:
        _runs[r.id] = r
    return r


def get_run(config: dict | None) -> Run | None:
    rid = ((config or {}).get("configurable") or {}).get("run_id")
    with _reg:
        return _runs.get(rid) if rid else None


def close_run(rid: str) -> None:
    with _reg:
        _runs.pop(rid, None)
