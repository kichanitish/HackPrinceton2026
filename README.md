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
- Compare up to three properties, with rent ranges, bedrooms, bathrooms, size, availability, pet and parking information, manager and tour provenance.
- Deterministic observations about starting-rent and area differences. These are data calculations, not AI property judgments.
- A local-storage shortlist and comparison URLs; CSV download.
- Property details and embedded Matterport tours, plus an external tour link.
- Live Matterport SDK connection, camera panning, inside/floor-plan/dollhouse modes, room navigation from SDK room and sweep data, automatic room walkthrough, and JPEG screenshot download. Native saved-tour playback remains conditional on successful tour discovery and saved stops.
- Live GraphQL room labels and dimensions in details, tours and comparisons. Missing measurements remain explicitly unavailable, and scan dimensions are separate from listing floor area.
- Vexcel aerial imagery in property details and side-by-side comparison, with historical collection selection, capture windows, resolution, attribution and an optional wider surroundings view. Keys remain on the server.
- Catalog coverage audit using collection footprints. All 789 app-catalog coordinates were covered: 550 Houston and 239 Los Angeles. Actual imagery was displayed for three test properties across both cities, including historical imagery for Los Angeles. This is geographic coverage verification, not a claim that every image at every address was downloaded.
- Server-side read-only API checks for account model queries, one sample kit model, dimensional data and Vexcel MCP initialization. Check results are cached for five minutes.

## Access checks and current limits

The current environment cannot resolve api.matterport.com, api.vexcelgroup.com, or the Sites Git host. Direct agent-side requests failed before an authentication response. Those earlier failures are recorded in data/api-access.json. Subsequent browser inspection of the user-started server confirmed working GraphQL credentials, sample-model access, dimensions and Vexcel MCP authentication; see data/browser-verification.json. Vexcel image retrieval has since been verified in both catalog cities; structure/roof-product entitlements remain unverified.

The agent execution environment refused a loopback server (listen EPERM). Chrome access subsequently became available: the standalone comparison and a linked Matterport tour were visually verified. A user-started server at localhost:4317 was also inspected; its Connections panel confirms GraphQL authentication, sample kit-model access, room dimensions and Vexcel MCP authentication. SDK camera connection works. Room navigation, automatic walkthrough, floor-plan switching and screenshot download were exercised in Chrome. Native saved-tour discovery still failed on the inspected models, without downgrading the working camera connection. Twenty-six automated checks pass. The development server watches source files and reloads builds automatically; refresh Chrome after changes.

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
- src/live.js, src/tour.mjs: live room measurements, SDK navigation, imagery display and coverage status.
- worker/index.js, worker/api.mjs, worker/vexcel.mjs: Worker routes, server-only integrations, geometry checks and image proxying.
- scripts/prepare-data.py: minimal catalog extraction from the original kit.
- scripts/build.mjs: dependency-free Worker build and standalone preview export.
- scripts/dev.mjs: Node development server.
- tests/: filtering, data integrity, provider failure handling and built-route checks.

For hosted publication, use the existing Sites project, build with node scripts/build.mjs, validate with node scripts/validate-artifact.mjs, push the exact source, and package dist/ through the Sites workflow. The source and generated output contain no server credentials.
