"""Sentence → program.

"coffee shop, 40 seats, Houston, under $30/sq ft"  →  business, capacity, market, budget.

A deterministic parser always runs, so the demo never depends on a network call. When an LLM key is
configured (ANTHROPIC_API_KEY, or LLM_API_KEY holding an Anthropic key) Claude reads the sentence too and
its answer wins field by field; any failure falls back silently to the deterministic result.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Literal, Optional

from pydantic import BaseModel, Field

from .store import BUSINESSES, MARKETS

log = logging.getLogger("fit.parse")

Business = Literal["cafe", "restaurant", "gym", "clinic", "daycare"]
Market = Literal["houston", "los_angeles"]

WANTS = {
    "patio": r"\b(patio|outdoor (seating|dining)|terrace)\b",
    "drive_thru": r"drive[- ]?thr(u|ough)",
    "kitchen": r"\b(existing|built[- ]?out|second[- ]gen\w*|2nd[- ]gen\w*) (kitchen|restaurant)|\bwith (a )?(kitchen|hood)\b",
    "parking": r"\bparking\b",
    "tour": r"\b(3d|matterport|virtual) ?(tour|walk\w*)?\b",
    "ground_floor": r"\b(ground|first|street)[- ]?(floor|level)\b|\bstorefront\b",
}


class Program(BaseModel):
    """What the user wants to open, in structured form."""
    business: Business = "cafe"
    capacity: int = Field(default=30, ge=1, le=2000)
    market: Market = "houston"
    budget_psf_yr: Optional[float] = Field(default=None, gt=0)
    budget_monthly: Optional[float] = Field(default=None, gt=0)
    target_sqft: Optional[int] = Field(default=None, ge=100)
    wants: list[str] = Field(default_factory=list)
    business_name: Optional[str] = Field(default=None, max_length=40)   # the user's own words: "coffee shop"

    def display_name(self) -> str:
        """What to call the business on screen: the user's words when we have them, else the category."""
        return self.business_name or BUSINESSES[self.business]["label"].lower()


class ParseResult(BaseModel):
    program: Program
    understood: list[str]      # what we read from the sentence
    assumed: list[str]         # what we filled in, shown to the user
    parser: str                # "rules" or "claude"


class _LLMProgram(BaseModel):
    """Schema Claude fills in. Null means 'the sentence does not say'."""
    business: Optional[Business] = None
    capacity: Optional[int] = None
    capacity_is_exam_rooms: bool = False
    market: Optional[Market] = None
    budget_usd_per_sqft_per_year: Optional[float] = None
    budget_usd_per_month_total: Optional[float] = None
    target_sqft: Optional[int] = None
    business_name: Optional[str] = None


# Words that end a business name ("coffee shop | , 40 seats", "dental clinic | with 4 exam rooms").
_NAME_STOP = {"for", "with", "in", "near", "under", "at", "around", "that", "which", "and", "seating", "seats", "budget",
              "houston", "la", "los", "angeles", "texas", "california", "tx", "ca", "about", "of", "on", "to", "up"}
# Words that come before it ("I want to open a | sushi bar").
_NAME_LEAD = {"i", "we", "want", "wants", "would", "like", "to", "open", "opening", "start", "starting", "launch", "launching",
              "a", "an", "the", "my", "our", "new", "small", "looking", "look", "for", "space", "need", "needs", "planning",
              "plan", "run", "running", "lease", "leasing", "find", "me", "us", "build", "set", "up", "please", "hi", "hello"}


def business_name(text: str, match: re.Match[str]) -> str | None:
    """The business as the user named it: the phrase around the matched keyword, e.g. 'coffee shop', 'dental clinic'."""
    words = list(re.finditer(r"[A-Za-zÀ-ÿ'&-]+|\d|[$,;.!?]", text))
    hit = next((i for i, w in enumerate(words) if w.start() <= match.start() < w.end() or w.start() >= match.start()), None)
    if hit is None:
        return None
    start = hit
    while start > 0 and words[start - 1].group(0).isalpha() and words[start - 1].group(0).lower() not in _NAME_LEAD | _NAME_STOP:
        start -= 1
    end = hit
    while end + 1 < len(words) and words[end + 1].group(0)[0].isalpha() and words[end + 1].group(0).lower() not in _NAME_STOP:
        end += 1
    phrase = [w.group(0) for w in words[start:end + 1]][-4:]
    name = " ".join(phrase).strip(" -&")
    return name.lower() if 2 <= len(name) <= 40 else None


_BUSINESS_WORDS: list[tuple[Business, str]] = [
    ("daycare", r"\b(day ?care|child ?care|pre-?school|nursery|montessori|kindergarten|early learning|creche)\b"),
    ("clinic", r"\b(clinic|dental|dentist\w*|orthodont\w*|medical|doctor'?s?|physician|urgent care|physio\w*|"
               r"physical therap\w*|chiropract\w*|pediatric\w*|optometr\w*|dermatolog\w*|med ?spa|therapy practice|"
               r"(family|medical|dental|private) practice)\b"),
    ("gym", r"\b(gym|fitness|yoga|pilates|crossfit|boxing|martial arts|jiu[- ]?jitsu|spin|barre|climbing|"
            r"training studio|workout|dance studio|health club)\b"),
    ("cafe", r"\b(coffee|caf[eé]|espresso|bakery|tea ?(house|shop|room)|boba|bubble tea|juice bar|donut|bagel|"
             r"ice cream|gelato|patisserie|dessert)\b"),
    ("restaurant", r"\b(restaurant|bistro|diner|pizz\w+|taquer\w+|taco\w*|burger\w*|sushi|ramen|bbq|barbecue|steakhouse|"
                   r"grill|eatery|brewpub|brewery|gastropub|wine bar|cocktail bar|bar|pub|deli|noodle\w*|kitchen|food hall)\b"),
]

_NUM = r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?"
_CAPACITY_UNITS = (r"seats?|seater|covers|guests?|diners?|people|persons?|pax|members?|clients?|patients?|"
                   r"kids?|children|child|students?|toddlers?|infants?|chairs?|capacity|occupan\w+")


def _num(text: str, k: str | None = None) -> float:
    return float(text.replace(",", "")) * (1000 if k else 1)


def parse_rules(text: str) -> ParseResult:
    """Deterministic parser. Never raises; missing pieces become labelled assumptions."""
    raw = text.strip()
    t = raw.lower()
    understood: list[str] = []
    assumed: list[str] = []
    fields: dict = {}

    # ---- business
    for key, pattern in _BUSINESS_WORDS:
        m = re.search(pattern, t)
        if m:
            fields["business"] = key
            fields["business_name"] = business_name(t, m)
            understood.append((fields["business_name"] or BUSINESSES[key]["label"]).capitalize())
            break
    else:
        fields["business"] = "cafe"
        assumed.append("No business type recognised — assumed a café. Pick another type above.")
    biz = BUSINESSES[fields["business"]]

    # ---- market
    if re.search(r"\b(los angeles|l\.a\.|california|socal|hollywood|santa monica|dtla)\b", t) or re.search(r"\b(LA|CA)\b", raw):
        fields["market"] = "los_angeles"
        understood.append("Los Angeles")
    elif re.search(r"\b(houston|htx|texas)\b", t) or re.search(r"\bTX\b", raw):
        fields["market"] = "houston"
        understood.append("Houston")
    else:
        fields["market"] = "houston"
        assumed.append("No city given — assumed Houston. The kit covers Houston and Los Angeles.")

    # ---- budget (strip it out before reading capacity so "$30" is never taken as 30 seats)
    rest = t
    m = re.search(r"\$\s*" + _NUM + r"(?P<tail>[^,;]{0,34})", t) or re.search(
        _NUM + r"\s*(?:dollars|usd|bucks)(?P<tail>[^,;]{0,34})", t)
    if m:
        amount, tail = _num(m.group(1), m.group(2)), m.group("tail")
        per_sqft = bool(re.search(r"(/|per|a)\s*(sq\.?\s*f(ee|oo)?t\.?|sf|psf|square f(oo|ee)t)|psf", tail))
        monthly = bool(re.search(r"(/|per|a|each)\s*(mo\b|month)|monthly|\bpm\b", tail))
        yearly = bool(re.search(r"(/|per|a)\s*(yr|year)|annual|yearly", tail))
        if per_sqft or (amount < 200 and not monthly):
            if monthly or (amount < 8 and not yearly):
                fields["budget_psf_yr"] = round(amount * 12, 2)
                understood.append(f"Up to ${amount:g}/sq ft a month (${amount * 12:,.0f}/sq ft/yr)")
            else:
                fields["budget_psf_yr"] = amount
                understood.append(f"Up to ${amount:g}/sq ft/yr")
        else:
            fields["budget_monthly"] = round(amount / 12, 2) if yearly else amount
            understood.append(f"Up to ${fields['budget_monthly']:,.0f} a month")
        rest = t[:m.start()] + " " + t[m.end():]

    # ---- explicit floor area
    m = re.search(_NUM + r"\s*(sq\.?\s*f(ee|oo)?t\.?|sf\b|square f(oo|ee)t|sqft)", rest)
    if m and _num(m.group(1), m.group(2)) >= 150:
        fields["target_sqft"] = int(_num(m.group(1), m.group(2)))
        understood.append(f"About {fields['target_sqft']:,} sq ft")
        rest = rest[:m.start()] + " " + rest[m.end():]

    # ---- capacity
    capacity = None
    m = re.search(_NUM + r"\s*[- ]?\s*(exam(ination)? rooms?|treatment rooms?|operator(y|ies)|(dental |treatment )?chairs?)", rest)
    if m and fields["business"] == "clinic":
        rooms = int(_num(m.group(1)))
        capacity = rooms * 3
        understood.append(f"{rooms} {'treatment chairs' if 'chair' in m.group(3) else 'exam rooms'} ({capacity} people at once)")
    if capacity is None:
        m = re.search(_NUM + r"\s*[- ]?\s*(" + _CAPACITY_UNITS + r")\b", rest)
        if m:
            capacity = int(_num(m.group(1), m.group(2)))
            understood.append(f"{capacity:,} {m.group(3)}")
    if capacity is None:
        m = re.search(r"\b(?:for|seat(?:s|ing)?|fit(?:s|ting)?|hold(?:s|ing)?|capacity(?: of)?|serv(?:e|es|ing)|up to)\s+(?:about |around |up to |~)?"
                      + _NUM + r"(?!\s*(%|years?|yrs?|months?|days?|am|pm|k\b))", rest)
        if m:
            capacity = int(_num(m.group(1), m.group(2)))
            understood.append(f"{capacity:,} {biz['unit']}")
    if capacity is None:
        m = re.search(_NUM + r"\s*[- ]?\s*tables?\b", rest)
        if m:
            tables = int(_num(m.group(1)))
            capacity = tables * 4
            understood.append(f"{tables} tables ({capacity} seats)")
    if capacity is None:
        capacity = biz["default_capacity"]
        assumed.append(f"No capacity given — assumed {capacity} {biz['unit']}. Change it above.")
    fields["capacity"] = max(1, min(int(capacity), 2000))

    fields["wants"] = [k for k, rx in WANTS.items() if re.search(rx, t)]
    return ParseResult(program=Program(**fields), understood=understood, assumed=assumed, parser="rules")


# ---------------------------------------------------------------------------
# Optional: Claude reads the sentence too.
# ---------------------------------------------------------------------------
_SYSTEM = """You read one sentence from a small-business owner looking for commercial space to lease, and fill in a form.

business: cafe (coffee, bakery, tea, juice, dessert), restaurant (any full kitchen or bar), gym (fitness, yoga, pilates,
martial arts, dance), clinic (medical, dental, therapy, urgent care), or daycare (childcare, preschool).
capacity: seats for a cafe or restaurant, people working out at one time for a gym, children for a daycare, and for a
clinic the number of people inside at once. If a clinic sentence gives exam rooms instead, put the room count in capacity
and set capacity_is_exam_rooms.
market: houston or los_angeles; these are the only two cities covered.
Budgets: a per-square-foot figure goes in budget_usd_per_sqft_per_year (multiply a monthly per-square-foot figure by 12);
a total monthly rent goes in budget_usd_per_month_total.
business_name: the business as the user named it, in their words and lower case (for example "coffee shop", "dental clinic", "sushi bar").
Leave a field null when the sentence does not state it. Do not guess."""


def _llm_key() -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("LLM_API_KEY") or ""
    return key if key.startswith("sk-ant-") else None


def parse_llm(text: str, base: ParseResult) -> ParseResult | None:
    """Ask Claude; merge its answer over the deterministic one. Returns None on any problem."""
    key = _llm_key()
    if not key:
        return None
    try:
        import anthropic
    except ImportError:
        log.info("LLM key set but the `anthropic` package is not installed; using the rules parser")
        return None
    try:
        client = anthropic.Anthropic(api_key=key, timeout=12.0, max_retries=1)
        response = client.messages.parse(
            model="claude-opus-5-5",
            max_tokens=2000,
            system=_SYSTEM,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": text}],
            output_format=_LLMProgram,
        )
        if response.stop_reason == "refusal" or response.parsed_output is None:
            return None
        out: _LLMProgram = response.parsed_output
    except anthropic.APIConnectionError:
        log.warning("Claude unreachable; using the rules parser")
        return None
    except anthropic.APIStatusError as e:
        log.warning("Claude returned %s; using the rules parser", e.status_code)
        return None
    except Exception:  # schema or validation trouble must never break search
        log.exception("Claude parse failed; using the rules parser")
        return None

    fields = base.program.model_dump()
    understood, assumed = [], []
    if out.business_name and out.business_name.strip():
        fields["business_name"] = out.business_name.strip().lower()[:40]
    if out.business:
        fields["business"] = out.business
        understood.append((out.business_name or BUSINESSES[out.business]["label"]).capitalize())
    biz = BUSINESSES[fields["business"]]
    if out.market:
        fields["market"] = out.market
        understood.append(MARKETS[out.market]["name"])
    elif not any("city" in a for a in base.assumed):
        understood.append(MARKETS[fields["market"]]["name"])
    if out.capacity:
        cap = out.capacity * 3 if out.capacity_is_exam_rooms else out.capacity
        fields["capacity"] = max(1, min(cap, 2000))
        understood.append(f"{out.capacity} exam rooms ({cap} people at once)" if out.capacity_is_exam_rooms
                          else f"{cap:,} {biz['unit']}")
    if out.budget_usd_per_sqft_per_year:
        fields["budget_psf_yr"], fields["budget_monthly"] = out.budget_usd_per_sqft_per_year, None
        understood.append(f"Up to ${out.budget_usd_per_sqft_per_year:g}/sq ft/yr")
    if out.budget_usd_per_month_total:
        fields["budget_monthly"], fields["budget_psf_yr"] = out.budget_usd_per_month_total, None
        understood.append(f"Up to ${out.budget_usd_per_month_total:,.0f} a month")
    if out.target_sqft and out.target_sqft >= 150:
        fields["target_sqft"] = out.target_sqft
        understood.append(f"About {out.target_sqft:,} sq ft")
    if not out.business and any("business type" in a for a in base.assumed):
        assumed.append("No business type recognised — assumed a café. Pick another type above.")
    if not out.market and any("city" in a for a in base.assumed):
        assumed.append("No city given — assumed Houston. The kit covers Houston and Los Angeles.")
    if not out.capacity and any("capacity" in a for a in base.assumed):
        assumed.append(f"No capacity given — assumed {fields['capacity']} {biz['unit']}. Change it above.")
    try:
        return ParseResult(program=Program(**fields), understood=understood, assumed=assumed, parser="claude")
    except ValueError:
        return None


def parse_request(text: str) -> ParseResult:
    base = parse_rules(text)
    return parse_llm(text, base) or base
