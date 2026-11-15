# Deploy Scout on Render

Scout runs as one Node web service: the website, API routes and Matterport Bundle viewer share an origin. No database or Python server is needed. The included `render.yaml` can create a Render Blueprint; the same settings work with New → Web Service.

1. Push the latest `main` branch to GitHub. It must include `scripts/start.mjs`, `scripts/server.mjs` and `render.yaml`.
2. In Render, choose **New → Web Service**, connect `kichanitish/HackPrinceton2026`, and select `main`.
3. Use these settings:

| Setting | Value |
|---|---|
| Runtime | Node |
| Root directory | Leave empty (package.json is at repository root) |
| Build command | `npm ci && npm run sdk:install && npm run build` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Node version | Environment variable `NODE_VERSION=22` |
| Other environment | `NODE_ENV=production`, `TRUST_PROXY=1` |

The build downloads the pinned official Matterport Bundle archive, verifies its checksum, and installs its static assets. These assets are intentionally excluded from Git. Do not regenerate the data catalogs during deployment: the supplied snapshot files are already committed. Production start does not rebuild, watch source files, or load a local `.env`.

4. Enter the values from your local `.env` in Render's **Environment** settings:

```text
OPENAI_API_KEY
OPENAI_MODEL=gpt-5.5
OPENROUTER_API_KEY
OPENROUTER_MODEL=openrouter/free
MATTERPORT_API_KEY
MATTERPORT_API_TOKEN
MATTERPORT_SDK_KEY
VEXCEL_API_KEY
GOOGLE_MAPS_EMBED_KEY
```

Use your existing explicit model setting if it differs. OpenAI is primary and OpenRouter is fallback. Keep all credential values in Render's environment, never in GitHub or this document. Do not copy the local `PORT=4317`; Render supplies its own port. Debug traces are visible in Render logs; `SCOUT_AGENT_DEBUG=0` disables them.

5. Choose an instance type and create the service. The Blueprint defaults to Free without committing you to paid hosting. Free web services sleep after 15 minutes of inactivity and can take about a minute to wake; choose an always-on instance if a cold first visit would disrupt your demo.
6. Once Render assigns your HTTPS URL, authorize that exact website/domain for the Matterport SDK application key. In Google Cloud, add `https://YOUR-SERVICE.onrender.com/*` to the website restrictions of the Maps Embed key. Keep the key restricted to Maps Embed API. Also add a custom domain if you use one. Changing the hostname alone does not require changing the SDK/API credential values.
7. Verify the hosted app:

   - `/healthz` returns `{"ok":true,"app":"Scout"}`.
   - `/bundle/version.txt` returns the pinned SDK version.
   - Homes and business cards have photos and open property details.
   - Connections confirms Matterport and Vexcel access.
   - A 3D tour connects and enables Add to room; adding furniture works.
   - Street View and Vexcel aerial imagery load.
   - A description-based search fills My shortlist; `[Scout agent …]` traces appear in Render logs.

Shortlists and furniture arrangements live in browser storage. A new deployment hostname starts with separate browser storage; it does not erase the saved local version.

Reference: [Render Node deployment](https://render.com/docs/deploy-node-express-app), [web service settings](https://render.com/docs/web-services), [environment variables](https://render.com/docs/configure-environment-variables), [free service limits](https://render.com/docs/free).
