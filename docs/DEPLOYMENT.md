# Deployment

## Free hosting (recommended starting point): Render + Neon — $0, no card

Researched September 2026. Fly.io's free allowance is now a 7-day trial, Railway is credits-only, and Render's own free Postgres **deletes itself after 30 days** — so the durable free stack is:

| Piece | Service | Free terms (verified Sep 2026) |
|---|---|---|
| App (API + SPA) | **Render** free web service | 750 hrs/mo, 512 MB, Singapore region, sleeps after 15 min idle (~1 min wake), commercial use allowed, no card |
| Database | **Neon** free Postgres | Permanent (never expires), 0.5 GB storage, 100 CU-hrs/mo, sleeps when idle, no card |

Our data (~400 hackathons + provenance) is a few MB — nowhere near Neon's 0.5 GB. Pick **Singapore** on both for the lowest latency to India.

### Steps (about 15 minutes, all in dashboards)

1. **Neon first:** sign up at neon.tech → New Project → region **Singapore** → copy the connection string (the plain `postgres://…` one, SSL on).
2. **Push this repo to GitHub** (Render deploys from git).
3. **Render:** Dashboard → New → **Blueprint** → select the repo. `render.yaml` wires everything: Node 24, Singapore, build `npm install && npm run build`, start `npm start`, health check `/api/health`.
4. **Before clicking deploy**, set two env vars on the web service:
   - `DATABASE_URL` = your Neon connection string
   - `PUBLIC_BASE_URL` = your Render URL, e.g. `https://hackathon-finder.onrender.com`
   - (`ADMIN_TOKEN` is auto-generated. `INGEST_ON_BOOT=true` is already set.)
5. **Deploy.** First boot runs migrations, then — finding an empty database — auto-seeds Unstop + MLH in the background (a few minutes). Devpost joins via the in-process scheduler (`REFRESH_ENABLED=true`). Open the URL, search Chennai.
6. **Optional, stay-awake ping:** free services sleep after 15 min idle. A free cron-job.org job hitting `https://<your-app>/api/health` every 10 minutes keeps it warm (uses ~720 of your 750 monthly hours — fits).

### Honest limits of free
- First visit after idle takes ~1 minute (cold start). The keep-awake ping above avoids it.
- Heavy crawl days share the 512 MB box with serving traffic; refreshes are staggered and interval-guarded for this reason.
- When you outgrow it: Render Starter $7/mo (no sleep) + Neon Launch (pay-as-you-go). No code changes needed.

## What runs where

| Process | Command | Notes |
|---|---|---|
| API + SPA | `node backend/dist/index.js` (or `npm run dev -w backend`) | Serves `/api/*`, SEO routes and the built SPA. Runs migrations on boot. |
| Refresh worker | `node --experimental-strip-types workers/refresh-worker.ts` (or build + `node dist/workers/refresh-worker.js`) | Status recompute + staggered re-crawls + venue geocoding. Run separately in production so crawls never compete with requests. |
| PostgreSQL | managed service or container | Point `DATABASE_URL` at it. |
| (Optional) Redis | — | Not required. Search is indexed SQL; the only caches are the `geocode_cache` table and short-lived in-process memoization. If you add Redis later, it slots in as a query-result cache in `services/search.ts`. |

## Docker

```dockerfile
# --- build ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci
COPY . .
RUN npm run build -w shared && npm run build -w frontend && npm run build -w backend

# --- api ---
FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/shared ./shared
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/database ./database
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev
EXPOSE 8080
CMD ["node", "backend/dist/index.js"]
```

```yaml
# docker-compose.yml (sketch)
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: hackfinder
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: hackfinder
    volumes: [pgdata:/var/lib/postgresql/data]
  api:
    build: .
    environment:
      DATABASE_URL: postgres://hackfinder:${DB_PASSWORD}@db:5432/hackfinder
      PUBLIC_BASE_URL: https://hackathons.example.com
      ADMIN_TOKEN: ${ADMIN_TOKEN}
    depends_on: [db]
  worker:
    build: .
    command: ["node", "workers/refresh-worker.js"]
    environment:
      DATABASE_URL: postgres://hackfinder:${DB_PASSWORD}@db:5432/hackfinder
    depends_on: [db]
volumes: { pgdata: {} }
```

The `api` image path above assumes the worker entry is compiled too; simplest is to keep one image and override the command. PGlite is only a fallback — with `DATABASE_URL` set, node-postgres is used and no local files are needed.

## Environment

All settings are in `.env.example`. Production must-haves:

- `DATABASE_URL` (managed Postgres; backups on)
- `PUBLIC_BASE_URL` (canonical URLs, sitemap, OG tags)
- `ADMIN_TOKEN` (long random; enables crawl/ingest endpoints; without it they 403)
- `CORS_ORIGINS` (your frontend origin if served separately)
- `REFRESH_ENABLED=false` in the API if the standalone worker runs (avoids double crawling)
- `DEVPOST_MAX_DETAIL_FETCHES` sized to your crawl window (each detail fetch ≈ 1.2 s+)

Never commit `.env`. No secrets are read from anywhere except the environment.

## First boot in production

```bash
npm run migrate -w backend                 # schema
ADMIN_TOKEN=... node backend/dist/ingest-cli.js -- --sources unstop,mlh
ADMIN_TOKEN=... node backend/dist/ingest-cli.js -- --sources devpost
node backend/dist/cli/warm-geocoder.js     # geocode event cities for distance
```

Then verify: `GET /api/health`, `GET /api/hackathons?city=Chennai`, `GET /api/admin/stats` (with token), and compare one stored deadline with its source page (the e2e live spot-check automates this: `npm run test -- --project e2e` with `DATABASE_URL` pointed at a staging copy).

## Logging & monitoring

Structured JSON logs in production (`ts`, `level`, `msg`, …). Watch:

- `source result` lines (`ok: false`, `failed > 0`) and `/api/admin/stats` → `sources[].health`
- `totals.missingDeadlines` and `totals.deadlineConflicts` trends
- crawl duration vs `REFRESH_INTERVAL_MS`
- 5xx rate and PGlite/PG connection errors

Liveness: `/api/health`. Readiness for search: `hackathons > 0`.

## Performance notes

- Hot path is one indexed `SELECT` + one count + facet aggregates; pagination caps at 100/page.
- Composite/partial indexes exist for city, status, deadline, geo and the open-in-city query (`EXPLAIN` the slow ones before adding more).
- Per-host request spacing + bounded pages keep crawls polite; detail enrichment is capped.
- Frontend: debounced autocomplete, skeletons, sticky filters, hashed-asset caching, no JS needed for SEO routes.
