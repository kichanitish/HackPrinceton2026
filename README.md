# Scout

A minimal home and business-space comparison app using the supplied CoStar snapshot.

## Open immediately

Open **Scout.html** in a browser. This standalone version needs no installation or server. Browsing, filters, the comparison shortlist, floor-plan selection, CSV export and ordinary Matterport embeds work from that file. Photos and Matterport playback still need internet access and a publicly playable scan. SDK controls and server API checks require the server version.

## Run the server version

Requires Node.js 22.6+ and Python 3 only if regenerating the dataset. Install npm dependencies for the LangChain recommendation harness.

```sh
cd /Users/nitishks/Downloads/homefit
cp .env.example .env
# Fill in .env locally with your keys. Never commit it.
npm install
npm run dev
```

Open http://localhost:4317. The development server binds only to loopback. Configure PORT to change the port. Source changes rebuild automatically. Refresh Chrome after a successful rebuild. Restart after changing environment values.

The SDK key is a browser application key and must allow the serving domain, including localhost and the production hostname. It is delivered to the browser by /api/config. GraphQL and Vexcel credentials stay on the server and are never returned to the client. Hosted credentials have been configured as Sites secrets; no credentials are saved in this source tree.

## Features

- 789 communities in Houston and Los Angeles; 1,700 available, positive-rent, whole-unit-priced floor plans with a plan/unit-linked scan.
- Search by property, street or ZIP. Filter city, bedrooms, minimum asking rent, recorded dog policies and parking policies.
- Change floor plans on property cards, in details and in comparison.
- Review one shortlisted property or compare up to three properties, with rent ranges, bedrooms, bathrooms, size, availability, pet and parking information, manager and tour provenance.
- Deterministic observations about starting-rent and area differences. These are data calculations, not AI property judgments.
- A local-storage shortlist and comparison URLs; CSV download.
- Property details and full Matterport viewers, with native toolbar/menu tools retained and an external tour link. Plans with multiple linked scans expose a scan selector (294 plans in this catalog).
- Per-scan capability discovery from SDK feature flags, published views, publisher display settings and measurement state. Direct manual-measurement and defurnish/original-view controls appear when supported. Alternate published views are selectable. Unknown and unavailable capabilities remain distinct; no publisher settings or model data are modified.
- Live Matterport SDK connection, camera panning, inside/floor-plan/dollhouse modes, room navigation from SDK room and sweep data, automatic room walkthrough, and JPEG screenshot download. Native saved-tour playback remains conditional on successful tour discovery and saved stops.
- Live GraphQL room labels and dimensions in details, tours and comparisons. Missing measurements remain explicitly unavailable, and scan dimensions are separate from listing floor area.
- Vexcel aerial imagery in property details and comparison: the most recent returned collection, shown as property and wider-surroundings tiles in a horizontal gallery. Buttons and scrolling switch between the two framings. Capture windows, resolution and attribution stay visible; both tiles use the same collection. Keys remain on the server.
- Catalog coverage audit using collection footprints. All 789 app-catalog coordinates were covered: 550 Houston and 239 Los Angeles. Actual imagery was displayed for three test properties across both cities, including historical imagery for Los Angeles. This is geographic coverage verification, not a claim that every image at every address was downloaded.
- Server-side read-only API checks for account model queries, one sample kit model, dimensional data and Vexcel MCP initialization. Check results are cached for five minutes.

## Shortlist and aerial imagery

The Compare page supports one, two or three properties. With one property it shows the selected plan, live measurements and imagery, tour/staging actions and CSV export, plus a link to add another. Only an empty shortlist shows the empty state. Price winners and cross-property observations appear only with multiple properties.

The catalog-wide coverage audit remains a server diagnostic at `/api/coverage-audit`; it is not displayed or automatically run in the browsing UI.

Aerial galleries choose the most recent returned Vexcel collection by capture-end date (capture-start date is the fallback); urban imagery wins date ties only. The Property tile uses an 85-meter buffer and Wider surroundings a 200-meter buffer. Scroll sideways or use the Property / Wider area buttons. Both images retain attribution and use the same collection. The historical collection picker and wider-view checkbox have been removed. Comparison-video generation is not included in the interface.

## Scan tools

Each opened scan discovers its own published views and feature flags. API room dimensions are listed separately from manual ruler measurements; API dimensions do not imply saved measurement lines or room labels inside the viewer. **Measure manually** opens Matterport's manual measurement mode; **Remove scanned furniture** switches to an existing published defurnished view, with a return to the original. A published-view selector exposes alternate views when returned. Publisher-disabled Dollhouse, Floor plan and measurement controls are respected. View-mode navigation is provided only by Matterport’s native controls; Scout does not duplicate Inside, Floor plan or Dollhouse buttons. Native toolbar/menu features remain present for tags, floor selection, sharing, search, fullscreen and other tools supported by the scan. Scout does not process new defurnished versions or enable owner-disabled features.

The collapsed **Tools available in this scan** panel explains confirmed, unavailable and unverified capabilities. A failed optional SDK lookup does not disable a connected viewer or prove a feature absent. Guided-tour discovery waits for the viewer's playing phase; unverified playback can be attempted without claiming saved stops exist. Switching a linked scan clears old capability state and subscriptions. Capabilities are checked on opening each scan; the full catalog has not been exhaustively audited.

## 3D furniture studio

Open **3D tour**, **Explore in 3D**, or **Step inside**. Tours open with the furniture studio available by default, using a locally hosted Matterport Bundle SDK viewer with a compact studio beside the scan on desktop. Add a detailed Scandinavian sofa, black or burgundy armchair, or one of three coffee tables from Matterport’s examples. A simple bed, desk and dining table remain available; saved legacy shapes still restore. Use the colored transform handles to move and rotate, turn 90 degrees, edit dimensions in feet, or use precise movement and height controls. Detailed models load through the Bundle SDK GLTF loader from Matterport’s versioned public sample-asset CDN, including their textures. Scout centers and grounds them, and scales them to editable staging dimensions. The six selected models are listed as CC BY 4.0 in Matterport’s attribution table. Credits are included in the studio and THIRD_PARTY_ASSETS.md. The model-fit component preserves movement, rotation, resizing and browser-local arrangements. Network loading failures are shown explicitly rather than silently substituting a box. No LLM key is required.

Arrangements save automatically per scan in browser storage, with an explicit Save button as well. Reopening a scan restores its pieces. No Matterport model mutations or uploads are performed. The default 3D studio uses Bundle SDK release `26.10.4_webgl-1728-g1cd7e0997a`. Room bounds provide an initial floor height; the current-view fallback estimates floor level from camera height. Walls, doors and circulation are not automatically validated. Existing scanned furniture remains visible. This is visual staging, not a clearance guarantee.

The personal matching form and the 2D rectangular planner have been removed.

The official Bundle SDK is installed locally under `public/bundle/` and excluded from Git. On a fresh checkout, run:

```sh
npm run sdk:install
npm run dev
```

The installer downloads the pinned official archive and verifies its SHA-256 checksum. An existing downloaded archive can also be installed with `npm run sdk:install -- /absolute/path/showcase-bundle.zip`. Restart the development server after the server script changes; ordinary source edits still rebuild automatically. The Node server serves the installed files at `/bundle/`. Builds also copy them to `dist/client/bundle/`. A future hosted Worker needs an `ASSETS` binding serving that directory; a Worker-only deployment cannot serve furniture tools. No hosted deployment is claimed here.

## Access checks and current limits

The current environment cannot resolve api.matterport.com, api.vexcelgroup.com, or the Sites Git host. Direct agent-side requests failed before an authentication response. Those earlier failures are recorded in data/api-access.json. Subsequent browser inspection of the user-started server confirmed working GraphQL credentials, sample-model access, dimensions and Vexcel MCP authentication; see data/browser-verification.json. Vexcel image retrieval has since been verified in both catalog cities; structure/roof-product entitlements remain unverified.

The agent execution environment refused a loopback server (listen EPERM). Chrome access subsequently became available: the standalone comparison and a linked Matterport tour were visually verified. A user-started server at localhost:4317 was also inspected; its Connections panel confirms GraphQL authentication, sample kit-model access, room dimensions and Vexcel MCP authentication. SDK camera connection works. Room navigation, automatic walkthrough, floor-plan switching and screenshot download were exercised in Chrome. Native saved-tour discovery still failed on the inspected models, without downgrading the working camera connection. Automated checks cover provider access, catalog integrity, comparison, 3D furniture geometry and scene lifecycle. The development server watches source files and reloads builds automatically; refresh Chrome after changes.

A private Sites project was created and runtime secrets configured, but source synchronization failed at DNS resolution. **No live site was deployed.** .openai/hosting.json retains the exact project ID for resuming publication; do not create another Site.

Narrated video rendering, roof-condition assessments and a live CoStar feed are not implemented. The supplied CoStar snapshot remains the source of listing facts; no live CoStar credential was supplied. Room names and dimensions vary by scan. Automatic walkthrough visits available room scan positions; it is separate from Matterport’s publisher-authored guided tours. Vexcel imagery access is now verified on test addresses, while structure/roof-product entitlements remain unverified.

## Checks and data

```sh
npm run build
npm test
npm run validate
node scripts/check-access.mjs
```

check-access.mjs reads optional .env and writes a sanitized result to data/api-access.json. It makes only read queries and MCP initialization requests; it does not buy assets or mutate models.

To regenerate the catalog from the original adjacent kit:

```sh
npm run data
npm run build
```

The kit is a November 12, 2026 snapshot selected around Matterport captures, not complete market inventory. Budget filters match a floor plan's minimum asking rent. Some units can cost more. Reported available units are not physical vacancy. Fees are incomplete, and a representative-unit tour need not show the exact available unit. The app excludes per-bed pricing and does not infer amenity names from unmapped IDs.

## Source layout

- src/index.html, src/style.css, src/app.js: responsive interface.
- src/domain.mjs: filtering, shortlist validation and comparison calculations.
- src/capabilities.js, src/capabilities.mjs: per-scan feature discovery, display settings, published views and manual measurement controls.
- src/furniture.js, src/furniture.mjs: Bundle scene components, staging controls, placement and saved arrangements.
- src/live.js, src/tour.mjs: live room measurements, SDK navigation, imagery display and coverage status.
- worker/index.js, worker/api.mjs, worker/vexcel.mjs: Worker routes, server-only integrations, geometry checks and image proxying.
- scripts/prepare-data.py: minimal catalog extraction from the original kit.
- scripts/build.mjs: dependency-free Worker build and standalone preview export.
- scripts/dev.mjs: Node development server.
- tests/: filtering, data integrity, provider failure handling and built-route checks.

For hosted publication, use the existing Sites project, build with node scripts/build.mjs, validate with node scripts/validate-artifact.mjs, push the exact source, and package dist/ through the Sites workflow. The source and generated output contain no server credentials.

When a floor plan links multiple Matterport scans, Scout checks their live model data on demand and exposes one preferred scan. Scans with room measurements rank first, followed by measured-room count, captured total area, dimension detail and room metadata. Tours, furniture staging, comparison details and CSV exports use that selection. If no scan exposes measurements, a scan with accessible metadata remains available. This does not remove other floor plans or alter the original catalog links. Saved furniture remains associated with its original model.

Street View setup: enable **Maps Embed API** in a Google Cloud project with billing enabled. Create a browser API key restricted to Maps Embed API and the app's website referrers (`http://localhost:4317/*`, plus your deployed HTTPS domain). Add `GOOGLE_MAPS_EMBED_KEY=your_key` to the ignored local `.env` and restart `npm run dev`. This browser key is intentionally returned by `/api/config`; do not reuse a server credential. See https://developers.google.com/maps/documentation/embed/get-api-key.

The Site & surroundings section in property details and comparison has keyboard-accessible Street view / Aerial tabs. With the embed key configured, Google Street View is primary and searches for outdoor panoramas within 100 m of the listing coordinate. It may show a nearby street rather than the exact entrance. Aerial imagery loads when selected. Without the key, aerial remains primary and Street view provides a key-free Google Maps link. Google's cross-origin iframe does not expose imagery availability reliably; users can switch to aerial with the link below the viewer. No Street View coverage or successful authentication is claimed until checked live with a valid key.

The Street View panel keeps the listing name and full address visible above the panorama. **Locate property** switches the same viewer to Maps Embed place mode using the complete listing address, showing Google’s matched property pin. **Back to street view** restores the nearby panorama. This uses the same Maps Embed API key, without additional API enablement. The locator is a map pin, not a marker inside the panorama, and does not identify an individual apartment. Verified live for 2125 Yale St, Houston.

Browsing uses the **My shortlist** label throughout navigation, detail actions and downloads. Bathroom filtering applies to available floor plans alongside bedroom and budget criteria, with exact counts (including half baths) and a 3+ option. Listing images in Explore and the shortlist open property details. All plan selectors are labeled **Available floor plans**; these are layouts, not unit-level live inventory. Open dialogs lock background scrolling while remaining scrollable themselves. The repetitive Still to verify row has been removed from the shortlist. Existing saved lists and shared comparison URLs remain compatible.


**Find my top 3** adds one optional, bounded LangChain agent to the local Node app. It searches up to 24 eligible layouts (up to two per property, ordered by rent or space priority), inspects scan data for up to three candidates, and submits up to three distinct properties. Code validates every selection and constructs visible fit/tradeoff bullets from catalog and scan facts, rather than displaying model-authored factual claims. Explicit city, rent budget, minimum beds/baths and dog requirements are never relaxed to fill slots. Parking can also be required through the needs text. Recommendations refer to available data and starting asking rent, not an exhaustive assessment or live unit quote. Furniture fit remains unverified.

Setup in your own Terminal:

```sh
cd ~/Downloads/homefit
npm run ai:install
```

Add `OPENAI_API_KEY` to the ignored `.env` for the primary LangChain ChatOpenAI integration. Set `OPENAI_MODEL` (default `gpt-5.5`); Scout's `AGENT_MODEL_OPENAI` setting is also accepted. Keep `OPENROUTER_API_KEY` and optionally `OPENROUTER_MODEL` (default `openrouter/free`) for automatic fallback on provider errors, timeouts, or invalid structured output. With only an OpenRouter key, it remains the primary available provider. Restart `npm run dev` after changing environment values. No model key is returned to the browser. LangSmith tracing is off unless separately configured. Free-model availability and tool reliability depend on OpenRouter.

A successful search updates and opens **My shortlist** directly. The needs dialog explains that an existing list will be replaced; **Undo shortlist update** restores it. Manual and agent selections use the same page and controls. Recommended layouts add only a concise **Agent summary** with supporting facts and a tradeoff; there are no separate result cards or best-match badges. A summary disappears when its particular layout changes, while unchanged recommended layouts retain theirs. Matches are saved in the same browser; shared shortlist URLs contain selections but do not include personalized needs or recommendations. Closing the dialog cancels a pending request. Empty results and errors preserve the current shortlist.

The API accepts same-origin JSON POSTs, limits body size, bounds model calls/tool use, permits two concurrent requests and six requests per minute per server process, and applies a 65-second request timeout. The optional agent packages are loaded lazily so catalog browsing/building/testing still works before installation. This integration runs on the local Node server; a future hosted Worker deployment must bundle the npm dependencies before enabling the AI route.


Agent debugging is **server-terminal only**. In the Terminal running `npm run dev`, look for `[Scout agent <request-id>]`. Events include `started`, `model.step` (tool names and token counts when provided), `search.completed` (applied criteria and candidate counts), `scans.completed` (measurement availability), `selection.completed` (ordered picks and their factual summaries), and `completed`/`failed` (timing and sanitized failure details). No debug panel or log payload is sent to the website. Logs do not contain credentials, raw free-text needs, model response bodies, or private internal reasoning. Set `SCOUT_AGENT_DEBUG=0` (or the compatible `HOMEFIT_AGENT_DEBUG=0`) in `.env` and restart to turn these traces off; logs are on by default. A live OpenRouter run was verified to populate three properties in My shortlist automatically.


The recommendation harness first classifies scope and extracts preferences through a forced, typed `analyze_preferences` tool call. Searches cannot bypass that step. Off-topic questions get a polite service-specific response; detached houses, purchases, unsupported cities, mandatory unsupported amenities, conflicting requirements, per-person budget ambiguity, applications/payments and commute-time constraints prompt clarification. No such response changes the shortlist. Derived filters include pets, parking, explicit minimum area and maximum bedroom counts, and ZIP codes actually present in the request. Soft preferences can prioritize price, space or proximity; the model must not invent numeric requirements or claim unknown amenities are verified.

Location requests use real listing coordinates and a Haversine straight-line radius instead of ZIP boundaries. The built-in LAX airport reference point comes from the FAA AIP (33-56-32.987N / 118-24-28.975W): https://www.faa.gov/air_traffic/publications/atpubs/aip_html/part3_ad_2.0_california.html. Other landmarks/addresses use a bounded, cached search through the open-source Photon geocoder (https://github.com/komoot/photon), backed by OpenStreetMap. This geocoder is unrelated to Photon messaging credits. No new API key is required. Its public demo service has no availability guarantee; keep traffic moderate. `HOMEFIT_GEOCODER_URL` can switch to a self-hosted or alternate Photon-compatible endpoint. Requests are user-triggered, five results maximum, seven-second timeout, no catalog-wide geocoding, and at most one uncached lookup per second per process. Successful location-based summaries include required OpenStreetMap attribution when relevant.

Ambiguous place names show up to three choices, a city conflict asks before switching, and an unavailable place asks for a clearer address or ZIP. Driving distance and minute-based commutes are not approximated as straight-line distance. When a radius finds no qualifying listings, the harness may suggest the nearest qualifying radius; it is applied only if the user clicks the suggestion. Other requirements remain intact. Summary distance is always labeled straight-line, and the tradeoff explains that driving distance/traffic are unverified.

Tool choice: free OpenRouter models can call the application's tools through LangChain; they do not independently connect to arbitrary MCP servers. Existing Matterport measurement access remains in use. Google Maps Experience tools have MCP/REST support but separate billed access (https://developers.google.com/maps/ai/maps-experience-agent-tools); the website-restricted Embed key does not grant server geocoding/routing access. This version uses a narrow geocoding tool rather than adding an MCP transport and more credentials. No Google routing or new remote MCP was enabled, and no public Nominatim endpoint is used.

Live checks verified both a LAX radius and a general **Santa Monica Pier** search. The general geocoder returned the pier plus nearby similarly named features; choosing the pier produced three properties inside the requested 10-mile radius. Street-address lookups require a matching house number from the geocoder; a street-only centroid is treated as unverified instead of an exact address.

Ranking reliability: after the forced preference/scope analysis succeeds, code runs the validated catalog search and checks scan data for provisional picks. The model receives at most 12 distinct candidate properties with numerical facts and evidence keys, rather than the repeated full evidence prose from 24 layouts. Ranking is a single forced `finish_shortlist` call with a 15-second deadline and 900-token output budget. A missing tool call, invalid IDs/selection, provider failure or ranking timeout falls back to the existing validated filter order (rent, space or proximity), retaining all hard constraints and source-backed summaries. Logs show `ranking.started`, model `finishReason`, and `selection.fallback` when used; results record `selectionMethod`. Empty searches and three-or-fewer candidates need no model ranking call. Cancelled requests never apply a fallback, and an unsuccessful scope/preference analysis never falls back to guessed requirements. Scope analysis has a 30-second deadline; scan lookups have a shared 6.5-second deadline across their metadata queries.

Preference parsing tolerates omitted optional nested fields and safe formatting such as numeric strings, explicit `"true"`/`"false"`, null optional values, and comma-separated ZIP codes. Parsing/normalization is server-side, separate from the plain JSON Schema sent to the model. Invalid numbers, booleans, unsupported enum values or malformed requirements trigger a polite clarification, not a `ZodError` response or a search with dropped constraints. `preferences.invalid` terminal events contain only field paths, validation codes and received types; no raw arguments or values are logged. Regression tests exercise both partial responses and malformed preferences through the installed LangChain/OpenRouter adapter.

## Scout integration: homes and business spaces

The `scout-agent` source is preserved under `scout/`. Scout reuses its commercial data preparation and business-use profiles inside the existing Node application; no second Python web server or separate chat interface is required.

**Homes / Business spaces** switches the browsing filters and recommendation form. The commercial snapshot contains 3,949 advertised spaces across 561 properties; 556 properties have source photos, and 3,505 spaces have linked scans. Missing photos, asking rates and scans remain unavailable. Space use, area, ground-floor requirements and recorded fit-out claims refine commercial matching. Context includes nearby recorded apartment units, office buildings and historical same-use/service lease rates. Tenant-company employee totals are explicitly not verified on-site staffing and do not determine ranking.

Commercial prices are monthly base-rent estimates from quoted annual rate × minimum reported area ÷ 12. Lease service type stays visible; operating charges, availability, actual leasable area, zoning, permits and equipment require confirmation. A building-level scan may show another suite. Nearby catalog context is incomplete and does not establish foot traffic, demand or revenue.

Both modes use the same property details, Street View, Vexcel aerial gallery, supported Matterport tools and three-property shortlist. Recommendations add only short factual summaries to that shortlist. Explicit constraints remain mandatory; the harness asks before switching search mode or expanding a location radius. The Scout top-ten interface and automatic constraint relaxation are not used.

To rebuild the commercial snapshot from the adjacent `costar-hackathon-kit` with Python's standard library:

```sh
npm run data:commercial
npm run build
```

Debugging remains terminal-only: `model.provider`, `model.provider_completed` and `model.provider_fallback` identify the selected provider/model without logging keys or private model reasoning. Scope analysis has a 32-second parent deadline; provider attempts are bounded within it. Ranking has a 15-second parent deadline, followed by validated deterministic selection if needed. Provider-routing tests exercise the installed LangChain adapters with mocked HTTP responses, including OpenAI success and OpenRouter failover.

Live browser checks after integration verified home recommendations, a coffee-shop request producing three commercial shortlist entries, property photos and commercial Vexcel retrieval. They confirm the combined workflow; provider-selection details remain in the server terminal.

## Property contacts

Home and commercial properties show separate Owner, Management and Leasing contact rows in My shortlist, plus a Property contacts section in details. Names, company names, phone numbers/extensions and email addresses appear when recorded, with click-to-call and email links. Two contacts per group appear initially; additional contacts remain accessible in details. Missing roles are explicitly unreported. Recorded owners and owners retain their distinct source labels; brokers are never presented as landlords. Company phone lines are labeled separately from direct contact numbers.

Contacts are joined from property-specific commercial listing records, commercial-property contact references and company locations. Portfolio listing brokers can apply to their advertised spaces; owner and management contacts are attached only to the explicitly associated property. Apartment management companies remain available even without individual contacts. Explicit `displayInProduct: false` listing records are omitted. All details reflect the supplied snapshot, not current verification. Both data preparation scripts include extraction; `npm run data:contacts` updates contacts alone while preserving the existing floor plans and selected scans.

## Description-first search

The homepage uses one needs bar rather than the previous “Find my top 3” button and preference dialog. Users describe their requirements, optionally starting from the one example shown for Homes or Business spaces. Clicking an example fills the bar; Find matches or Enter starts the search (Shift+Enter adds a line). Clarifications and place/radius choices stay inline. Cancel aborts an in-flight request and ignores late responses. Matching still returns up to three validated properties in My shortlist, with factual summaries and Undo. Refine my search returns from the shortlist to the needs bar.

The description drives requirements; browsing budget, room and business-type filters do not silently constrain agent searches. The current city is a fallback, and an explicitly requested supported city or a verified landmark's city is adopted for description-first requests. Ambiguous places, unsupported requirements and search-mode conflicts still require clarification; radius expansion still requires user selection. The manual filters remain available beneath the bar, with aligned responsive fields for commercial use and area.

My shortlist no longer fetches or displays a Matterport interior-measurements row. Measurements remain available in property details and scan tools. Homepage photography changes with Homes / Business spaces; real Pexels photo sources and licensing are recorded in THIRD_PARTY_ASSETS.md.


## Scout identity and tour defaults

The app is now Scout, with a compass mark, deep teal, warm ivory and an amber accent. The standalone build is `Scout.html`; `HomeFit.html` remains a compatible copy for existing bookmarks. Existing browser storage keys and saved furniture component names stay compatible, preserving shortlists, recommendations and staged arrangements. Server request traces use `[Scout agent …]`.

Agent summaries omit generic straight-line travel and mandatory-fee reminders, including those in previously saved recommendations. Distances in match strengths remain labeled straight-line; specific property tradeoffs still appear when useful. General source and pricing context remains in property details.

The Pet friendly browsing filter accepts recorded dog or cat policies and excludes explicitly prohibited or unreported pet policies. Pet policy summaries identify the recorded species and available pet rent; a dog-only record does not become a promise that all pets are allowed. Explicit dog/cat requests in agent searches retain their respective species requirements.

Server-backed 3D tours open directly in the Bundle viewer with the Furniture studio expanded. The separate Furnish in 3D actions have been removed. Opening the same active studio reuses its iframe and session, preserving the camera and furniture. Use standard viewer remains an explicit fallback; standalone previews without SDK configuration use the standard viewer. Live Chrome verification confirmed the default studio connected to model ASWK3CoJ75u and enabled Add to room.
