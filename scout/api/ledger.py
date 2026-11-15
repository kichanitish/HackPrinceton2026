"""One investigation: the locked program, the filter's candidates, every judgement the agent made, and its ranking.

The fixed filter (screening) only proposes candidates. Nothing reaches the user's results unless the agent judged
it (reviewed its evidence or checked it on a scan) and then ranked it. Every space the agent judged is either
ranked or rejected with a reason; the server never pads the list. Every layout attempt is kept and keyed to the
full program; attempts at a different capacity are alternatives and never become a space's status. Statuses come
only from this ledger, and a ranking that contradicts them is sent back so the agent can fix it.
"""
from __future__ import annotations

import re
import threading
import uuid
from typing import Any

from .match import card_for, search
from .parse import Program
from .sizing import size_program
from .store import BUSINESSES, Store

TOP_N = 10            # most spaces the agent may rank
POOL = 12             # candidates the filter hands the agent first
COLLECTION_SIZE = 40
LIMITS = {"reject": 10, "reason": 14, "recommendation": 25, "key_reason": 12, "warning": 14, "summary": 60}
VERIFY_RANK = {"feasible": 0, "feasible_with_caveats": 1, "conflict": 2, "unverified": 3}
STATUS_FROM_VERIFY = {"feasible": "verified", "feasible_with_caveats": "verified_with_caveats", "conflict": "conflict",
                      "unverified": "not_verifiable"}
TIER = {"verified": 0, "verified_with_caveats": 1, "reviewed": 2, "not_verifiable": 2, "screened_only": 3, "conflict": 4}
STATUS_TEXT = {"verified": "Space checks pass on the scan", "verified_with_caveats": "Space checks pass on the scan, with caveats",
               "conflict": "Fails a space check on the scan", "not_verifiable": "Reviewed; the scan couldn't be checked",
               "reviewed": "Reviewed by the agent; no scan of this suite",
               "screened_only": "Passed the filter; not reviewed"}


def words(text: str) -> int:
    return len(re.findall(r"\S+", text or ""))


def clip(text: str, n: int) -> str:
    parts = re.findall(r"\S+", text or "")
    return " ".join(parts[:n]).rstrip(",;:") + ("…" if len(parts) > n else "")


class Ledger:
    def __init__(self, store: Store, program: Program):
        self.store = store
        self.program = program.model_copy(deep=True)          # locked for the whole run
        self.sizing = size_program(store, self.program)
        found = search(store, self.program, self.sizing, limit=COLLECTION_SIZE)
        self.funnel = found["funnel"]
        self.total_matches = found["total_matches"]
        self.collection: dict[int, dict[str, Any]] = {c["space_id"]: c for c in found["results"]}
        self.order: list[int] = [c["space_id"] for c in found["results"]]   # the filter's order
        self.sent: set[int] = set(self.order[:POOL])            # cards the page already has
        self.seen_by_agent: set[int] = set()                     # handed to the agent by the filter
        self.reviewed: set[int] = set()                          # the agent read the evidence
        self.attempts: list[dict[str, Any]] = []
        self.evidence: dict[int, dict[str, Any]] = {}
        self.exterior: dict[int, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.result: dict[str, Any] | None = None
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- candidates
    def initial(self) -> dict[str, Any]:
        """The filter's candidates, for the agent to judge. The page shows them as 'under review', never as results."""
        return {"type": "collection", "program": self.program.model_dump(), "funnel": self.funnel, "total_matches": self.total_matches,
                "cards": [self.collection[i] for i in self.order[:POOL]]}

    def judged(self) -> set[int]:
        return self.reviewed | {a["space_id"] for a in self.attempts if not a["alternative"]}

    def card(self, space_id: int) -> dict[str, Any] | None:
        sid = int(space_id)
        if sid not in self.collection:
            c = card_for(self.store, self.program, self.sizing, sid)
            if c is None:
                return None
            c["discovered"] = True                              # came in after screening, with its full data
            self.collection[sid] = c
        return self.collection[sid]

    def ensure_sent(self, space_id: int) -> None:
        sid = int(space_id)
        if sid not in self.sent and self.card(sid):
            self.sent.add(sid)
            self._emit({"type": "candidate", "card": self.collection[sid]})

    def _emit(self, ev: dict[str, Any]) -> None:
        with self._lock:
            self.events.append(ev)

    def drain(self) -> list[dict[str, Any]]:
        with self._lock:
            out, self.events = self.events, []
        return out

    def program_text(self) -> str:
        p, biz = self.program, BUSINESSES[self.program.business]
        bits = [f"{p.display_name()} for {p.capacity:,} {biz['unit']} in {'Houston' if p.market == 'houston' else 'Los Angeles'}"]
        if p.budget_psf_yr:
            bits.append(f"budget up to ${p.budget_psf_yr:g}/sq ft/yr")
        if p.budget_monthly:
            bits.append(f"budget up to ${p.budget_monthly:,.0f}/month")
        if p.wants:
            bits.append("wants " + ", ".join(p.wants))
        return "; ".join(bits)

    # ---------------------------------------------------------------- recording
    def saw(self, ids: list[int]) -> None:
        for i in ids:
            self.seen_by_agent.add(int(i))
            self.card(i)

    def add_attempt(self, space_id: int, capacity: int, pins: dict | None, avoid: list | None, result: dict[str, Any]) -> None:
        sid = int(space_id)
        self.card(sid)
        self.seen_by_agent.add(sid)
        self.attempts.append({"space_id": sid, "program": {**self.program.model_dump(), "capacity": capacity},
                              "alternative": capacity != self.program.capacity, "pins": pins or {}, "avoid": avoid or [],
                              "result": result})
        self.ensure_sent(sid)
        self._emit({"type": "card", "space_id": sid, **self.status_of(sid)})

    def add_evidence(self, space_id: int, result: dict[str, Any]) -> None:
        sid = int(space_id)
        self.evidence[sid] = result
        self.seen_by_agent.add(sid)
        self.reviewed.add(sid)
        self.ensure_sent(sid)
        self._emit({"type": "card", "space_id": sid, **self.status_of(sid)})

    def add_exterior(self, space_id: int, result: dict[str, Any]) -> None:
        self.exterior[int(space_id)] = result
        self.seen_by_agent.add(int(space_id))
        self._emit({"type": "exterior", "space_id": int(space_id),
                    "observed": bool(result.get("vexcel_observation")), "image_url": result.get("image_url")})

    # ---------------------------------------------------------------- what the evidence says about one space
    def status_of(self, space_id: int) -> dict[str, Any]:
        sid = int(space_id)
        mine = [a for a in self.attempts if a["space_id"] == sid]
        main = [a for a in mine if not a["alternative"]]
        alts = [a for a in mine if a["alternative"] and a["result"].get("status") in ("feasible", "feasible_with_caveats")]
        out: dict[str, Any] = {"status": "reviewed" if sid in self.reviewed else "screened_only", "attempts": len(mine)}
        if main:
            best = min(main, key=lambda a: VERIFY_RANK.get(a["result"].get("status"), 9))["result"]
            out["status"] = STATUS_FROM_VERIFY.get(best.get("status"), "not_verifiable")
            if best.get("conflicts"):
                c = best["conflicts"][0]
                out["conflict"] = f"{c['zone']}: needs {c['required']}, measured {c['measured'].split(';')[0]}"
            if best.get("checks_total"):
                out["checks"] = f"{best.get('checks_passed', 0)}/{best['checks_total']}"
            open_items = (best.get("caveats") or []) + (best.get("unverified") or [])
            if open_items:
                out["open_items"] = open_items
            if best.get("max_capacity_verified") is not None:
                out["max_capacity_verified"] = best["max_capacity_verified"]
            if best.get("configuration_option"):
                out["option"] = best["configuration_option"]["note"]
        if alts:
            a = max(alts, key=lambda a: a["program"]["capacity"])
            out["option"] = (f"Alternative, not your request: passes at {a['program']['capacity']:,} "
                             f"{BUSINESSES[self.program.business]['unit']} instead of {self.program.capacity:,}. Your call.")
        out["status_text"] = STATUS_TEXT[out["status"]]
        return out

    # ---------------------------------------------------------------- the ranking
    def submit(self, entries: list[dict[str, Any]], recommended: int | None, recommendation: str, key_reasons: list[str],
               warnings: list[str], rejected: list[dict[str, Any]] | None = None, source: str = "agent") -> dict[str, Any]:
        problems: list[str] = []
        rejected = rejected or []
        ids = [int(e["space_id"]) for e in entries]
        rej_ids = [int(r["space_id"]) for r in rejected]
        judged = self.judged()
        if len(ids) > TOP_N:
            problems.append(f"Rank at most {TOP_N} spaces; reject the rest.")
        if len(set(ids)) != len(ids) or len(set(rej_ids)) != len(rej_ids):
            problems.append("Each space may appear only once.")
        both = sorted(set(ids) & set(rej_ids))
        if both:
            problems.append(f"These spaces are both ranked and rejected: {both}.")
        unjudged = [i for i in ids + rej_ids if i not in judged]
        if unjudged:
            problems.append(f"You haven't reviewed these spaces: {unjudged}. Call review_candidates or verify_layout on them first.")
        missing = sorted(judged - set(ids) - set(rej_ids))
        if missing:
            problems.append(f"Rank or reject every space you reviewed; missing {missing}.")
        long_reasons = [i for i, e in zip(ids, entries) if not str(e.get("reason", "")).strip() or words(e["reason"]) > LIMITS["reason"]]
        if long_reasons:
            problems.append(f"Each reason needs 1–{LIMITS['reason']} words; fix {long_reasons}.")
        long_rej = [i for i, r in zip(rej_ids, rejected) if not str(r.get("reason", "")).strip() or words(r["reason"]) > LIMITS["reject"]]
        if long_rej:
            problems.append(f"Each rejection reason needs 1–{LIMITS['reject']} words; fix {long_rej}.")
        key_reasons = [k for k in key_reasons if str(k).strip()]
        warnings = [w for w in warnings if str(w).strip()]
        if not recommendation.strip() or words(recommendation) > LIMITS["recommendation"]:
            problems.append(f"The recommendation needs 1–{LIMITS['recommendation']} words.")
        if len(key_reasons) > 3 or (ids and not key_reasons) or any(words(k) > LIMITS["key_reason"] for k in key_reasons):
            problems.append(f"Give 1–3 key reasons of at most {LIMITS['key_reason']} words each.")
        if len(warnings) > 2 or any(words(w) > LIMITS["warning"] for w in warnings):
            problems.append(f"Give at most 2 warnings of at most {LIMITS['warning']} words each.")
        total = words(recommendation) + sum(map(words, key_reasons)) + sum(map(words, warnings))
        if total > LIMITS["summary"]:
            problems.append(f"The summary is {total} words; keep recommendation + reasons + warnings to {LIMITS['summary']}.")
        statuses = [self.status_of(i)["status"] for i in ids]
        for pos, st in enumerate(statuses):
            if st == "conflict" and any(s != "conflict" for s in statuses[pos + 1:]):
                problems.append(f"Space {ids[pos]} fails a space check but is ranked above a space that doesn't. Failed spaces go last.")
                break
        if not ids or statuses[0] == "conflict":
            if recommended is not None:
                problems.append("Nothing you ranked passes; set recommended_space_id to null.")
        elif recommended != ids[0]:
            problems.append("recommended_space_id must be your first space.")
        if problems:
            return {"accepted": False, "problems": problems, "statuses_from_evidence": dict(zip(ids, statuses))}

        def row(sid: int, reason: str, rank: int | None) -> dict[str, Any]:
            self.ensure_sent(sid)
            c = self.collection[sid]
            return {"rank": rank, "space_id": sid, "reason": reason.strip(), "ranked_by": source, "match_pct": c["match_pct"],
                    "address": c["address"], "suite": c["suite"], **self.status_of(sid)}

        rows = [row(i, str(e["reason"]), k) for k, (i, e) in enumerate(zip(ids, entries), 1)]
        rej_rows = [row(i, str(r["reason"]), None) for i, r in zip(rej_ids, rejected)]
        self.result = {"accepted": True, "source": source, "recommended_space_id": recommended, "entries": rows, "rejected": rej_rows,
                       "summary": {"recommendation": recommendation.strip(), "key_reasons": key_reasons, "warnings": warnings},
                       "reviewed": len(judged), "checked": sorted({a["space_id"] for a in self.attempts if not a["alternative"]}),
                       "program": self.program.model_dump()}
        return self.result

    def assemble(self, source: str) -> dict[str, Any]:
        """A ranking by fixed rules over the spaces judged in this run (used when no agent ranking was accepted).
        Conflicts are rejected with their failed check; the rest rank by evidence tier, then filter order."""
        def pos(i: int) -> int:
            return self.order.index(i) if i in self.order else 999

        judged = sorted(self.judged(), key=lambda i: (TIER[self.status_of(i)["status"]], pos(i)))
        if not judged:
            return self._empty(source)
        passing = [i for i in judged if self.status_of(i)["status"] != "conflict"]
        ranked, extra = passing[:TOP_N], passing[TOP_N:]
        rejected = [{"space_id": i, "reason": clip(self.status_of(i).get("conflict") or "Fails a space check on its scan.", LIMITS["reject"])}
                    for i in judged if self.status_of(i)["status"] == "conflict"]
        rejected += [{"space_id": i, "reason": "Below the top ten on evidence."} for i in extra]
        if not ranked:
            return self.submit([], None, "None of the reviewed spaces holds up for this request.", [], [], rejected, source=source)
        first = ranked[0]
        st, c = self.status_of(first), self.card(first)
        recommendation = clip(f"{c['address']}{' Suite ' + c['suite'] if c.get('suite') else ''} — {st['status_text'].lower()}.",
                              LIMITS["recommendation"])
        reasons = [clip(ch["text"], LIMITS["key_reason"]) for ch in c["chips"][:3]] or ["Strongest evidence of the reviewed spaces."]
        warnings = [clip(w, LIMITS["warning"]) for w in (st.get("open_items") or [])[:1]]
        if st["status"] in ("reviewed", "not_verifiable"):
            warnings = [clip("Layout not checked against a scan of this suite.", LIMITS["warning"])] + warnings[:1]
        while words(recommendation) + sum(map(words, reasons)) + sum(map(words, warnings)) > LIMITS["summary"] and len(reasons) > 1:
            reasons.pop()
        entries = [{"space_id": i, "reason": clip("; ".join(ch["text"] for ch in self.card(i)["chips"][:2]) or "Reviewed evidence.",
                                                  LIMITS["reason"])} for i in ranked]
        return self.submit(entries, first, recommendation, reasons, warnings[:2], rejected, source=source)

    def _empty(self, source: str) -> dict[str, Any]:
        self.result = {"accepted": True, "source": source, "recommended_space_id": None, "entries": [], "rejected": [],
                       "summary": {"recommendation": "Nothing in the data passes the filter for this request.", "key_reasons": [], "warnings": []},
                       "reviewed": 0, "checked": [], "program": self.program.model_dump()}
        return self.result


# ------------------------------------------------------------------ one ledger per run, found through the run config
_ledgers: dict[str, Ledger] = {}
_registry_lock = threading.Lock()


def open_ledger(store: Store, program: Program) -> tuple[str, Ledger]:
    lid = uuid.uuid4().hex
    ledger = Ledger(store, program)
    with _registry_lock:
        _ledgers[lid] = ledger
    return lid, ledger


def get_ledger(config: dict[str, Any] | None) -> Ledger | None:
    lid = ((config or {}).get("configurable") or {}).get("ledger_id")
    with _registry_lock:
        return _ledgers.get(lid) if lid else None


def close_ledger(lid: str) -> None:
    with _registry_lock:
        _ledgers.pop(lid, None)
