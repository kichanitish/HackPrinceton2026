# HomeFit

A minimal property comparison app using the supplied CoStar apartment dataset.

## Open immediately

Open **HomeFit.html** in a browser. This standalone version needs no installation or server. Browsing, filters, the comparison shortlist, floor-plan selection, CSV export and ordinary Matterport embeds work from that file. Photos and Matterport playback still need internet access and a publicly playable scan. SDK controls and server API checks require the server version.

## Run the server version

Requires Node.js 22.6+ and Python 3 only if regenerating the dataset. No npm dependencies are needed.

```sh
cd /Users/nitishks/Downloads/homefit
cp .env.example .env
# Fill in .env locally with your keys. Never commit it.
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

Each opened scan discovers its own published views and feature flags. API room dimensions are listed separately from manual ruler measurements; API dimensions do not imply saved measurement lines or room labels inside the viewer. **Measure manually** opens Matterport's manual measurement mode; **Remove scanned furniture** switches to an existing published defurnished view, with a return to the original. A published-view selector exposes alternate views when returned. Publisher-disabled Dollhouse, Floor plan and measurement controls are respected. View-mode navigation is provided only by Matterport’s native controls; HomeFit does not duplicate Inside, Floor plan or Dollhouse buttons. Native toolbar/menu features remain present for tags, floor selection, sharing, search, fullscreen and other tools supported by the scan. HomeFit does not process new defurnished versions or enable owner-disabled features.

The collapsed **Tools available in this scan** panel explains confirmed, unavailable and unverified capabilities. A failed optional SDK lookup does not disable a connected viewer or prove a feature absent. Guided-tour discovery waits for the viewer's playing phase; unverified playback can be attempted without claiming saved stops exist. Switching a linked scan clears old capability state and subscriptions. Capabilities are checked on opening each scan; the full catalog has not been exhaustively audited.

## 3D furniture studio

Use **Furnish in 3D** in property details, comparison, or an ordinary tour. It opens a locally hosted Matterport Bundle SDK viewer with a compact studio beside the scan on desktop. Add a detailed Scandinavian sofa, black or burgundy armchair, or one of three coffee tables from Matterport’s examples. A simple bed, desk and dining table remain available; saved legacy shapes still restore. Use the colored transform handles to move and rotate, turn 90 degrees, edit dimensions in feet, or use precise movement and height controls. Detailed models load through the Bundle SDK GLTF loader from Matterport’s versioned public sample-asset CDN, including their textures. HomeFit centers and grounds them, and scales them to editable staging dimensions. The six selected models are listed as CC BY 4.0 in Matterport’s attribution table. Credits are included in the studio and THIRD_PARTY_ASSETS.md. The model-fit component preserves movement, rotation, resizing and browser-local arrangements. Network loading failures are shown explicitly rather than silently substituting a box. No LLM key is required.

Arrangements save automatically per scan in browser storage, with an explicit Save button as well. Reopening a scan restores its pieces. No Matterport model mutations or uploads are performed. Standard 3D tours continue to use the Embed SDK; the studio uses Bundle SDK release `26.10.4_webgl-1728-g1cd7e0997a`. Room bounds provide an initial floor height; the current-view fallback estimates floor level from camera height. Walls, doors and circulation are not automatically validated. Existing scanned furniture remains visible. This is visual staging, not a clearance guarantee.

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

To regenerate the contact-free catalog from the original adjacent kit:

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

When a floor plan links multiple Matterport scans, HomeFit checks their live model data on demand and exposes one preferred scan. Scans with room measurements rank first, followed by measured-room count, captured total area, dimension detail and room metadata. Tours, furniture staging, comparison details and CSV exports use that selection. If no scan exposes measurements, a scan with accessible metadata remains available. This does not remove other floor plans or alter the original catalog links. Saved furniture remains associated with its original model.

Street View setup: enable **Maps Embed API** in a Google Cloud project with billing enabled. Create a browser API key restricted to Maps Embed API and the app's website referrers (`http://localhost:4317/*`, plus your deployed HTTPS domain). Add `GOOGLE_MAPS_EMBED_KEY=your_key` to the ignored local `.env` and restart `npm run dev`. This browser key is intentionally returned by `/api/config`; do not reuse a server credential. See https://developers.google.com/maps/documentation/embed/get-api-key.

The Site & surroundings section in property details and comparison has keyboard-accessible Street view / Aerial tabs. With the embed key configured, Google Street View is primary and searches for outdoor panoramas within 100 m of the listing coordinate. It may show a nearby street rather than the exact entrance. Aerial imagery loads when selected. Without the key, aerial remains primary and Street view provides a key-free Google Maps link. Google's cross-origin iframe does not expose imagery availability reliably; users can switch to aerial with the link below the viewer. No Street View coverage or successful authentication is claimed until checked live with a valid key.

The Street View panel keeps the listing name and full address visible above the panorama. **Locate property** switches the same viewer to Maps Embed place mode using the complete listing address, showing Google’s matched property pin. **Back to street view** restores the nearby panorama. This uses the same Maps Embed API key, without additional API enablement. The locator is a map pin, not a marker inside the panorama, and does not identify an individual apartment. Verified live for 2125 Yale St, Houston.

Browsing uses the **My shortlist** label throughout navigation, detail actions and downloads. Bathroom filtering applies to available floor plans alongside bedroom and budget criteria, with exact counts (including half baths) and a 3+ option. Listing images in Explore and the shortlist open property details. All plan selectors are labeled **Available floor plans**; these are layouts, not unit-level live inventory. Open dialogs lock background scrolling while remaining scrollable themselves. The repetitive Still to verify row has been removed from the shortlist. Existing saved lists and shared comparison URLs remain compatible.
