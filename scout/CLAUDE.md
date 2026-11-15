# CLAUDE.md — Fit-to-Space (CoStar hackathon)

## What we are building

A user describes a business in plain English ("coffee shop, 40 seats, Houston").
The app:

1. **Understands the request**: turns the sentence into a structured *program*: business type, capacity, city, budget.
2. **Calculates required space** from two sources:
   - **Legal minimum**: building code + state licensing rules (see "Rules table").
   - **Market norm**: what similar businesses actually occupy in the kit data (see "Benchmarks").
3. **Finds matching spaces**: from 3,955 commercial spaces for lease in Houston and Los Angeles.
4. **Explains why**: a "Why this space?" panel driven by a knowledge graph (past food tenant in building,
   nearby apartments/office workers, competitors, rent vs signed deals).
5. **Draws the layout**: a 2D floor plan of zones (seating, counter, kitchen, restroom) sized to the program,
   then placed inside the property's Matterport 3D tour where available.

Pitch line: *"Tell us your business. We find spaces where it legally fits, where customers already are, and
where the kitchen may already be built — and show it in 3D."*

Scope for the hackathon: **commercial spaces for lease only.** Business types: **café/restaurant, gym, clinic,
daycare.** Houses, apartments, investors and landlord reverse-matching are future scope (pitch slide only).

## Repo layout (target)

```
data/costar-kit/          # unzipped kit (gitignored — do not commit the data)
  index.md, models/, concepts/, schemas/, data/*.jsonl
rules/rules.json          # legal rules table, one row per (business, jurisdiction), with source URLs
pipeline/                 # Python: load → clean → build tables/graph
  build_spaces.py         # flatten lease-listing spaces into spaces.parquet
  build_benchmarks.py     # sq ft by business type from tenancies
  build_graph.py          # networkx graph → graph.pkl
api/                      # FastAPI backend
  main.py                 # /search, /space/{id}, /layout/{id}
  parse.py                # LLM: sentence → program JSON
  sizing.py               # program → required sq ft range
  match.py                # filter + rank spaces
  explain.py              # graph paths → "why this space" reasons
  layout.py               # program + space → zone rectangles (2D)
web/                      # frontend (form, results list, map, 2D plan, Matterport embed)
.env                      # secrets — NEVER commit
```

## Commands

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install pandas pyarrow duckdb networkx fastapi uvicorn scikit-learn python-dotenv
python pipeline/build_spaces.py && python pipeline/build_benchmarks.py && python pipeline/build_graph.py
uvicorn api.main:app --reload
```

## Secrets — read this

- All keys live in `.env` only (copy `.env.example` → `.env` and fill in). Load with `python-dotenv`;
  frontend gets only what it must (the SDK key) via the backend or a build-time env var.
- Variables:

  | Variable | What it is |
  |---|---|
  | `KIT_ZIP_PASSWORD` | password for the CoStar data kit zip |
  | `MATTERPORT_API_KEY` | Matterport Model API (GraphQL) key — Basic-auth username |
  | `MATTERPORT_API_TOKEN` | Matterport Model API token — Basic-auth password |
  | `MATTERPORT_SDK_KEY` | Matterport Showcase SDK key — 3D embed. **Allowed domain: `localhost` only** (http/https), so demo from localhost |
  | `VEXCEL_API_KEY` | Vexcel aerial imagery API (see "Vexcel" section) |
  | `LLM_API_KEY` | LLM for request parsing (provider TBD) |

- Matterport Model API: `POST https://api.matterport.com/api/models/graph`, HTTP Basic auth
  (`MATTERPORT_API_KEY:MATTERPORT_API_TOKEN`). Try queries first in the Model Playground (link from CoStarSupportBot).
  `test_matterport.py <modelId>` prints what a scan returns (rooms, dimensions, floor plans).

- Read keys with `os.environ["MATTERPORT_SDK_KEY"]`; never hard-code or print them.
- `.env`, the credentials document, and `data/costar-kit/` go in `.gitignore` (provided).
- Never paste keys into code, prompts, commits, screenshots, or demo slides. Use placeholders like
  `MATTERPORT_SDK_KEY=<your-key>` in examples.
- The provider for each key in the credentials doc is **not verified**; confirm against sponsor docs.
- Matterport connection details are in a **separate zip** from the organizers; check what the API returns
  for one model before building the 3D layer.

## The data (kit facts you need)

- JSON Lines, one record per line: `pandas.read_json(path, lines=True)` or DuckDB `read_json_auto`.
- **Enums are integers.** Decode with `schemas/enums.json` (`PropertyType`, `SpaceUse`, `IndustryType`, …).
- Markets: Houston research market id **14**, Los Angeles **20**.
- Contact emails/phones are fake; don't present them as real.

| File | Records | Use it for |
|---|---|---|
| `commercial-listing-summary.jsonl` | 1,022 listings | `forLeaseSummary.spaces[]` → **the 3,955 spaces** |
| `commercial-property.jsonl` | 3,339 | address + lat/long, type, floors, Matterport `attachments[].videoKey` |
| `location-occupancy.jsonl` | 74,093 | who occupied which building; `spaces[].squareFeetOccupied`; `leaseDeal` rents |
| `company-detail.jsonl` | 49,575 | tenant name, `numEmployees`, industry |
| `apartment-listing.jsonl` | 1,747 | nearby residents (units) for demand |
| `commercial-sale-comp.jsonl` | 6,120 | not needed for v1 |

### Spaces for lease (3,955, all on the 615 Active lease listings)

| SpaceUse | Count | Median sq ft | Good for |
|---|---|---|---|
| Office | 2,801 | 2,029 | offices, tutoring; daycare only if ground floor + outdoor space |
| Retail | 411 | 2,000 | cafés, restaurants, salons, gyms |
| OfficeMedical + Medical | 310 | ~2,000 | clinics, dentists, PT |
| Industrial | 198 | 3,282 | large gyms (flag "check zoning") |
| Flex | 133 | 2,903 | gyms, studios |
| OfficeRetail | 102 | 2,432 | mixed |

Space fields: `propertyId`, `suite`, `floorName`, `squareFeetMin/Max/MaxContiguous`, `spaceUse`, `spaceType`
(Relet/Sublet), `rateLow/rateHigh`, `rateBasis`, `serviceType`, `availableOnDate`, `isLeasePending`.

### Matterport coverage

- 309 of the 327 non-apartment properties with available space have a **building** tour.
- Only **123 individual suites** match a suite-level tour (caption like "Suite 320"). Pick demo examples from these.
- A Matterport item has `videoExternalReferenceType` 36 (MatterportScan) or 234 (MatterportStreamingKey).
  Join on property id **and** `videoKey`.

## Rules table (`rules/rules.json`)

One row per business × jurisdiction. Every row must carry a `source_url`. These are a **first screen, not legal
approval** — UI must say "confirm with an architect or the city". Houston and LA adopt these codes with local
amendments.

| Business | Rule | Value | Source |
|---|---|---|---|
| Café / restaurant | IBC 1004.5 assembly, unconcentrated (tables & chairs) | 15 sq ft **net** per occupant | IBC Table 1004.5 |
| Gym | IBC 1004.5 exercise rooms | 50 sq ft **gross** per occupant | IBC Table 1004.5 |
| Classroom / tutoring | IBC 1004.5 educational classroom | 20 sq ft net per occupant | IBC Table 1004.5 |
| Daycare (building code) | IBC 1004.5 day care | 35 sq ft net per occupant | IBC Table 1004.5 |
| Office / clinic | IBC 1004.5 business areas | 150 sq ft gross per occupant | IBC Table 1004.5 |
| Daycare — **Texas** | 26 TAC §746.4201 indoor | 30 sq ft per licensed child | regulations.justia.com/states/texas/title-26/part-1/chapter-746/subchapter-t/division-1/section-746-4201 |
| Daycare — **Texas** | 26 TAC §746.4301 outdoor | 80 sq ft per child outdoors at one time | regulations.justia.com/states/texas/title-26/part-1/chapter-746/subchapter-t/division-2/section-746-4301 |
| Daycare — **California** | 22 CCR §101238.3 indoor | 35 sq ft per child (excl. bathrooms, halls, offices, kitchen) | regulations.justia.com/states/california/title-22/division-12/chapter-1/article-7/section-101238-3 |
| Daycare — **California** | 22 CCR §101238.2 outdoor | 75 sq ft per child | cdss.ca.gov/ord/entres/getinfo/pdf/ccc6.pdf |

IBC source used: learnarchitecture.net occupant-load summary and Washington WAC 51-50-1004 (state adoption
of IBC Table 1004.5). Swap to the Houston/LA adopted editions if time allows.

Net vs gross: **net** excludes corridors, restrooms, mechanical rooms, closets — so the net seating area is
smaller than the space's total sq ft. Apply a net-to-gross factor (start with ~0.65 for food service, label as an
assumption) when comparing to a listing's sq ft.

Demo hook: same 1,500 sq ft of usable play space = **50 children in Houston (30/child) vs 42 in LA (35/child)**.

Later: plumbing fixture counts (restrooms per occupants), ADA clearances, health-department kitchen rules.

## Benchmarks (`pipeline/build_benchmarks.py`)

Real space occupied by businesses in the kit, found by keyword on `company-detail.name`, joined via
`location-occupancy.tenantLocationId`, summing `spaces[].squareFeetOccupied`:

| Business | n | Median sq ft | Middle half |
|---|---|---|---|
| Café / coffee | 186 | 1,200 | 500–2,000 |
| Restaurant | 164 | 1,786 | 500–3,000 |
| Gym / fitness | 98 | 2,084 | 600–4,000 |
| Clinic / medical | 1,330 | 1,000 | 500–2,147 |
| Salon | 296 | 505 | 490–1,200 |
| Daycare | 39 | too few — use the law | |

**Gotcha:** many tenancies record exactly 500 sq ft (looks like a default). Exclude values == 500 and re-check
before showing. Keyword matching is fuzzy ("kitchen", "health", "kids" over-match) — tighten the regex and
spot-check 20 names per group.

`IndustryType` on occupancies is almost never `AccommodationAndFoodServices` (only 4 rows) — **use name keywords,
not industry codes, to find food tenants.**

## Sizing logic (`api/sizing.py`)

```
legal_min_net  = capacity × rule.sqft_per_person            (from rules.json)
legal_min_gross = legal_min_net / net_to_gross              (assumption, shown in UI)
market_range   = benchmark p25..p75 for the business type
recommended    = [max(legal_min_gross, market_p25), max(legal_min_gross × 1.5, market_median × 1.5)]
```

Show all three numbers to the user, each with its source. Example: café, 40 seats → legal ≥ 600 sq ft net seating;
market median 1,200; recommend ~1,000–1,800 sq ft.

## Knowledge graph (`pipeline/build_graph.py`)

networkx is enough (Neo4j optional). Nodes and edges:

```
Space ─IN→ Building ─IN_MARKET→ Houston|LA ─FOLLOWS→ Texas|California rules
Building ─HAD_TENANT→ Company ─IS_A→ BusinessType (café, gym, clinic, …)
Building ─NEAR(≤0.5 mi)→ ApartmentCommunity (units)
Building ─NEAR(≤0.5 mi)→ Building with office tenants (employees)
Space ─HAS_TOUR→ MatterportModel
BusinessType ─REQUIRES→ Rule
```

Key reasons the explainer produces (each = a graph path):

- **"Food business operated in this building before"**: 610 food-name tenancies in 273 buildings;
  **183 of 513 retail/office-retail spaces** are in such buildings. Building-level, not suite-level: word it carefully.
- **Demand nearby**: apartment units and office employees within 0.5 mi (haversine on lat/long).
- **Competition**: same business type already in the building / within 0.25 mi (212 café-type tenant locations).
- **Rent check**: asking rent vs signed `leaseDeal` rents for same use/market (normalize to $/SF/year and same
  service type first — see `concepts/metrics-and-formulas.md`).

## Layout drawing (`api/layout.py`)

Program → zones → rectangles. Example café, 40 seats:

| Zone | Size rule (start values, label as assumptions) |
|---|---|
| Seating | 40 × 15 sq ft net = 600 |
| Counter / bar | ~10–15% of total |
| Kitchen / back of house | ~25–35% of total |
| Restrooms | 1–2 ADA restrooms (~60 sq ft each) |
| Circulation | remainder |

- **v1 (always works):** draw a rectangle with the space's sq ft (assume a ~1:2 aspect ratio, labelled
  "approximate shape") and pack zones into it. Render as SVG in the frontend.
- **v2 (if Matterport API allows):** use the model's floor-plan asset or room `dimensions` (width/depth; needs the
  Property Insights extension) to get the real outline, then place zones with the Showcase SDK (Tags at zone
  centers, or 3D objects via the Scene API in the SDK Bundle).
- The kit gives **size, not shape**. Never claim a fit is exact without real dimensions.

## Vexcel aerial imagery (outside view)

CoStar is acquiring Vexcel ($730M, closing Q1 2027) to extract property data from aerial imagery — using it is
on-strategy for the pitch: **Matterport = inside, Vexcel = outside.** Docs: Getting started PDF + Python quickstart
(from CoStarSupportBot). Use it for checks the interior scan can't answer:

- **Daycare outdoor space**: TX needs 80 sq ft/child outdoors, CA 75 — is there a yard/lot next to the building?
- **Parking**: lot size / visible spaces for cafés, gyms, clinics.
- **Street frontage & visibility** for retail: corner lot, facing a main road.
- Show the aerial tile in the space detail view next to the 3D tour.

Confirm endpoints and what the key allows in the PDF before building on it.

## Data-quality rules

- 44% of spaces have no asking rent (`rateLow`/`rateHigh` 0 = not given) → show "rent on request", never $0.
- 1,149 rates are monthly; normalize to $/SF/year before comparing. Normalize service type too.
- 3,036 `availableOnDate` values are in the past → treat as "available now".
- 236 spaces belong to properties outside the kit (no property record) → drop or show without building info.
- `numEmployees` is a snapshot (no history); outliers exist (e.g., brokerages counting agents).
- The kit covers only CoStar's Matterport list — it is not a full market sample. Say so if asked.

## Conventions

- Python 3.11, type hints, small pure functions; keep data loading in `pipeline/`, not in API handlers.
- Every number shown in the UI must trace to a rule (with source URL) or a kit computation (with n).
- Keep LLM use to parsing the request and phrasing explanations; all sizing and matching is deterministic code.

## Demo script (3 minutes)

1. Type "coffee shop, 40 seats, Houston, under $30/sq ft".
2. Show: legal min, market norm, recommended range — each with source.
3. Results: 5 spaces, top one flagged "café operated in this building before", demand + competition chips.
4. Open it: 2D layout of zones → 3D tour with zones placed.
5. Switch to "daycare, 40 kids" in Houston vs LA → different legal capacity from state law.
6. Close: future scope — landlord reverse-match ("which business fits this empty space?"), gyms/clinics, homes.

## Team split

- P1: `pipeline/` (spaces, benchmarks, graph)
- P2: `api/` sizing, matching, explanations, rules.json
- P3: Matterport embed + layout overlay
- P4: frontend + pitch deck
