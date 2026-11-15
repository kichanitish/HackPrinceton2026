# Scout

*Tell us what you need. An agent finds the place.*

Two modes over CoStar data for Houston and Los Angeles:

- **Homes** (apartments for rent, from the HomeFit catalog: 789 communities, 1,700 floor plans with 3D tours):
  *"2-bed with parking within 3 miles of an elementary school in Houston, under $2,200"*
- **Commercial** (3,955 spaces for lease): *"Coffee shop downtown Houston, near offices, under $4,000 a month"*

What happens:

1. **The agent writes your brief**: city, beds/baths/budget/pets/parking for homes; business, size, budget, space
   type and musts for commercial; and **places to be near**, each with a radius ("≤ 3 mi of an elementary school",
   "≤ 15 mi of IAH", "≤ 2 mi of downtown"). Unstated details are decided from market data (typical rents, how much
   space similar businesses occupy). The brief is editable; fields you change are locked against the agent.
2. **Commercial only: best areas.** Where the business's customers are (apartment units, office workers, students,
   visitors) and competitors are fewest.
3. **Search.** Every listing that matches the brief exactly. If fewer than ten match, the agent widens one thing and
   the page shows the change ("near IAH 10 → 16 mi"); a must you stated is never dropped.
4. **Top 10, picked by the agent.** It chooses and orders all ten from its own searches; the server never pads.
   A deterministic **comparison** puts the same measures side by side and marks the best value in each column; it
   compares, it doesn't rank. Sort any column, or pick three for a side-by-side view.
5. **Deep dives on the top 3**, by three sub-agents running in parallel.
   Commercial: who will visit, competitors (counts and nearest, on the map), what the space offers (fit-out from the
   listing, same-type tenants in the building, parking, transit, nearby draws) and rent against signed deals.
   Homes: distance to your places and what's around (schools, parks, grocery, transit), plans that fit.

The page shows results, never the agent's reasoning: brief, a progress line, picks, deep dives, comparison.
Details open the 3D tour (Matterport), the aerial (Vexcel) and Street View.

## The agents (LangChain DeepAgents)

`scout/agent.py` builds one `create_deep_agent` orchestrator with its own tools and one sub-agent:

| Agent | Tools | Job |
|---|---|---|
| Orchestrator | `find_places`, `market_snapshot`, `set_brief`, `scan_areas`, `search_listings`, `submit_top10`, `task` | Brief → areas → search (widen explicitly) → top 10 → launch the deep dives |
| `deep-dive` sub-agent ×3, in parallel | `listing_context`, `nearby`, `submit_deep_dive` | One top-3 listing: up to 3 highlights and 2 watch-outs, facts only |

DeepAgents' built-in file tools and general-purpose sub-agent are switched off through a harness profile. Bounded:
16 model calls and 28 tool calls for the orchestrator, 5 model calls per sub-agent, 180 s. If no model key is set,
or the agent stops early, fixed rules finish only the missing steps and the page labels them "fixed rules".
`scout/run.py` enforces the rules the page relies on (exactly ten from the agent's own searches, deep dives only for
the top three, ≤ 12 words a line, locked user fields, visible adjustments).

## Data

- CoStar kit: listings, buildings, tenants (with years), apartments, signed-deal rents (`pipeline/`, `data/built/`).
- HomeFit apartment catalog, copied from the teammate repo to `data/homes/catalog.json`.
- OpenStreetMap snapshot of places (schools, universities, airports, hospitals, parks, transit, grocery, malls,
  hotels, neighbourhoods) and businesses (competitors), downloaded once by `pipeline/fetch_places.py` into
  `data/places/`. Nothing about the user is sent anywhere at query time.
- Vexcel aerials and Matterport tours as before.

Distances are straight-line miles, not drive time. Competitor counts come from OpenStreetMap, which misses some
small businesses: read them as "at least". Where the map has no places of a kind at all, the count is shown as
unknown, not zero.

## Run

In the team repo this app lives in `scout/`, next to HomeFit, and reuses HomeFit's `data/catalog.json`.
What you need locally (never committed): `.env` (copy `env.example`; OpenAI or Anthropic key, Vexcel, Matterport,
`KIT_ZIP_PASSWORD`) and the CoStar kit zip `costar-hackathon-kit.zip` in this folder. The first run builds
`data/built/` from the kit and downloads the OpenStreetMap places snapshot.

```powershell
cd scout
.\run.ps1             # Scout at http://localhost:8000 (downloads the places snapshot the first time)
.\run.ps1 -Floorproof # the earlier Floorproof app
python -m pytest -q   # 91 tests, including the DeepAgents graph driven by a scripted model
```

Code: `scout/` (backend: `brief`, `places`, `search`, `insights`, `compare`, `run`, `tools`, `agent`, `main`) and
`scout_web/` (page, in HomeFit's design language).

---

# Earlier version: Floorproof
*Name the business. We'll prove the space.*

One system, three beats, all on one screen:

1. **Screen (instant).** Your sentence becomes a locked program. Every listing in the city is screened against the
   building code; the top ten appear at once with a deterministic **screening match %**.
2. **Prove (live).** An AI agent inspects the strongest candidates against their Matterport scans (and the Vexcel aerial
   for daycares). The survey field shows each check as it happens: a reticle on the space, the measured floor plan
   drawing itself, failing rooms in red. Cards update one by one: proved, fails a check, or no scan to check.
3. **Rank.** The agent re-ranks the same ten cards with evidence. A space that fails a check never outranks one that
   passed. The recommendation is at most 60 words: one line, three reasons, the critical warnings.

Click any card for the full evidence: why, layout (planned and measured), the 3D tour, the aerial, and the rent check.

Type a sentence like **"Coffee shop, 40 seats, Houston, under $30/sq ft"** and Fit-to-Space:

1. **Reads the request** into a program: business, capacity, city, budget. Anything it had to assume is flagged.
2. **Sizes it three ways, each with its source:** the legal minimum (IBC Table 1004.5, plus Texas and California
   child-care licensing for daycares), the market norm (what real tenants of that type lease in the kit, with n),
   and a recommended search range.
3. **Ranks the 3,955 spaces for lease** in Houston and Los Angeles. A visible funnel shows what got filtered and why.
4. **Explains each match ("Why this space?")** with paths through a knowledge graph of about 9,400 nodes:
   past food or medical tenants in the building, the broker's own note on the suite, apartments and office workers
   within half a mile, competitors within a quarter mile, and a rent check against signed deals.
5. **Draws the layout:** zones sized to the program in an approximate plan; the rooms the **Matterport** scan
   measured, with each zone suggested for a room; the **3D tour** itself, with zones tagged in it; and the
   **Vexcel** aerial view for what the inside can't show (yard, parking, frontage), with the outdoor play area drawn
   to scale for daycares.

## The agent

**Run investigation** (between the sizing and the results) starts one tool-calling agent: LangChain's `create_agent`,
using Claude when `ANTHROPIC_API_KEY` is set and OpenAI otherwise. It has five tools over the deterministic code:

| Tool | Evidence tier | What it returns |
|---|---|---|
| `get_business_requirements` | Knowledge graph | Zones the business needs (`BusinessType ─REQUIRES_ZONE→ ZoneRequirement ─SIZED_BY→ Rule`, filtered by state), each legal / functional / advisory, with sources |
| `screen_spaces` | CoStar screening | Ranked candidates; flags which have a scan of their own suite. Can exclude ruled-out spaces |
| `verify_layout` | Matterport verification | Zones tested against measured rooms: every failed check with its measurement, build-outs, what's unverified, and the capacity the rooms really hold. Accepts `pin_rooms` / `avoid_rooms` to try other room assignments |
| `observe_exterior` | Vexcel observation | CoStar site record plus a vision-model reading of the aerial image, labelled as an observation |
| `get_space_evidence` | CoStar screening | Tenant history, broker's note, nearby demand, competitors, rent check |
| `submit_shortlist` | Agent decision | The agent's ranked shortlist (best first, with reasons). The server fills in each status from the run's own checks and rejects contradictions |

**The agent's shortlist is the result.** The fixed formula only screens (thousands → a candidate pool). The agent decides
which candidates to check, then submits a ranked shortlist. Each entry's status (verified, verified with caveats,
conflict, no scan, screened only) comes from the run's ledger (`api/ledger.py`), never from the model. The server
rejects a shortlist that includes a space the agent never looked at, ranks a failed space above one that passed, or
recommends anything but the first entry. The agent then has to fix it. The formula's order is still on the page, under
"Other matches — screening order, not investigated".

When a check fails, the agent decides what to do: try another room assignment, move to the next candidate, or test a smaller
configuration. A smaller configuration is only ever offered as "needs your decision", never as meeting the request.
Every tool call and result streams to the page as it happens (`POST /api/agent`, server-sent events).

**Bounds and fallback:** at most 14 model calls, 12 tool calls and 170 seconds per run, with 60-second model timeouts and
cached tool results. With no key, or on any error, timeout or budget stop, the same tools run in a fixed order and
the page says so ("Deterministic investigation").

**The layout checker** (`api/verify.py`) never estimates. A check passes or fails on a measured number, or it is
reported as unverified (no scan of this suite, an unmeasured room width, outdoor space an interior scan can't see).
Room areas Matterport didn't report are computed from the scanned wall outline and labelled as such.

## Run it

```powershell
.\run.ps1            # first run builds the data (about 2 minutes), then opens http://localhost:8000
.\run.ps1 -Rebuild   # re-run the pipeline after changing it
```

Or step by step:

```bash
pip install -r requirements.txt
python pipeline/build_all.py                  # unzip kit → spaces → benchmarks → graph
python -m uvicorn api.main:app --port 8000    # open http://localhost:8000
python -m pytest -q                           # 72 tests (no network, no API cost)
```

Open the app at **http://localhost**, not 127.0.0.1 or an IP address: the Matterport SDK key only works on localhost.

## Secrets

All keys live in `.env` (copy `env.example`). The server reads them; the browser only receives the Matterport
SDK key, which Matterport locks to localhost. `.gitignore` keeps `.env`, the kit zip and `data/` out of git.

| Variable | Used for |
|---|---|
| `KIT_ZIP_PASSWORD` | unzipping the CoStar kit |
| `MATTERPORT_API_KEY` / `MATTERPORT_API_TOKEN` | scan geometry: floor area, rooms, wall outlines |
| `MATTERPORT_SDK_KEY` | placing zone tags in the 3D tour |
| `VEXCEL_API_KEY` | aerial images (v2 `ortho/extract`, `urban` layer) |
| `ANTHROPIC_API_KEY` | preferred model for the agent (Claude Opus 5.5) and the request parser |
| `OPENAI_API_KEY` | agent model when no Anthropic key is set (default `gpt-5.5`; override with `AGENT_MODEL_OPENAI`) |

## Layout

```
pipeline/   extract_kit, build_spaces, build_benchmarks, build_graph, build_all
rules/      rules.json (legal factors, sources) · zones.json (business-zone requirements → knowledge graph)
api/        main (routes), parse, sizing, match, explain, layout, matterport, vexcel, store,
            requirements, verify, exterior, llm, agent_tools, agent
            ledger (the run: locked program, shared candidate collection, every attempt, the ranking)
web/        index.html, app.js (flow), stage.js (survey field), sheet.js (property drawer), fmt.js,
            charts.js, plan.js, tour.js, util.js, styles.css (no build step)
tests/      test_core.py, test_agent.py, test_shortlist.py
data/       costar-kit/ (unzipped), built/ (pipeline outputs), cache/ (scans, aerials) — all gitignored
```

## Honest limits

- A **first screen, not legal approval.** Houston and LA amend the model codes; confirm with an architect and the city.
- The kit gives a space's **size, not its shape**, so the 2D plan is an assumed 1:2 rectangle and says so. Real room
  geometry appears only where a Matterport scan of the suite exists (about 130 spaces).
- Tenant history is **building-level**: the kit doesn't say which suite a past café used.
- The kit covers buildings on CoStar's Matterport list, **not the full market**, so nearby counts are floors, not totals.
- 44% of spaces quote no rent; they show "rent on request", never $0.
- CoStar's image CDN refuses requests from localhost, so listing photos fall back to the Vexcel aerial view.
