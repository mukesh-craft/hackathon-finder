# Hackathon Finder

Find hackathons in your city — with the **actual registration deadline**, read from the event's own page and shown with its source.

A user types *Chennai* and gets currently relevant hackathons: name, organizer, location, **registration deadline with countdown**, prize, team size, eligibility, format and themes — plus a Register button that opens the real registration page.

## What makes this different

- **Registration deadline ≠ event date.** Unstop publishes `end_regn_dt` (registration closes) separately from `end_date` (event ends); they differ for roughly half the live catalogue. We map each to its own field and never substitute one for the other.
- **Milestones are classified, not guessed.** Registration, application, idea-submission, project-submission, shortlisting, finals and results are distinct fields. A page listing “Registration → 29 Sep, PPT → 5 Oct, Offline Round → 24 Oct” shows 29 Sep as the registration deadline.
- **No deadline is better than a fake one.** Sources that publish no registration deadline (MLH) render as “Not specified” with a link to the official page. Date-only deadlines never gain an invented 23:59.
- **Conflicts and merges are explicit.** The same event on several platforms is one row with all source links; equally trusted sources that disagree raise a visible conflict warning.

## Repository layout

| Path | Contents |
|---|---|
| `shared/` | Pure domain logic with zero dependencies: date extraction/classification, city normalization, dedupe, geo. Used by backend and frontend. |
| `backend/src/adapters/` | One module per source (`unstop`, `devpost`, `mlh`, `hackerearth`, `organizer-website`) behind a common contract. |
| `backend/src/services/` | Ingest/merge pipeline, search, geocoding, crawl orchestration, quality & refresh policy, stats. |
| `backend/src/http/` | Fastify server: REST API, validation, rate limiting, SEO routes, static SPA. |
| `backend/src/workers/` | Refresh scheduler (status recompute + staggered re-crawls). |
| `frontend/` | React + TypeScript + Vite SPA: home, city search, details, admin dashboard. |
| `workers/` | Standalone refresh worker entrypoint (run separately in production). |
| `database/migrations/` | PostgreSQL schema. Applies to embedded PGlite and to real PostgreSQL identically. |
| `tests/` | End-to-end tests against the real server and database. |
| `docs/` | Architecture, sources & collection policy, API reference, deployment. |

## Quick start

Prerequisites: Node.js ≥ 20, network access. No database server needed for development — an embedded PostgreSQL (PGlite) is used when `DATABASE_URL` is unset.

```bash
npm install
cp .env.example .env

# 1. Create the schema
npm run migrate -w backend

# 2. Ingest real data (Unstop ~3-4 min, MLH ~2 min, Devpost ~6 min with enrichment)
npm run ingest -w backend -- --sources unstop,mlh
npm run ingest -w backend -- --sources devpost

# 3. Build the frontend and start the API (serves API + SPA on :8080)
npm run build -w frontend
npm run dev -w backend
```

Open http://localhost:8080 and search **Chennai**.

Useful commands:

```bash
npm run ingest -w backend -- --sources unstop --venues   # also geocode venue addresses
npm run geo-warm -w backend                              # geocode every event city (distance filters)
npm test                                                 # shared + backend + frontend + e2e
node node_modules/vitest/vitest.mjs run --project e2e    # live verification incl. Unstop spot-check
```

## How data flows

```
Unstop public API ─┐
Devpost JSON API ──┼─► adapters ─► RawHackathon ─► ingest pipeline ─► PostgreSQL ─► REST API ─► SPA
MLH season JSON ───┘                  (normalize)      (city resolve → geocode →        (search,
Organizer pages ───┘                                   dedupe/merge → quality →          never crawls)
                                                       schedule refresh)
```

Search never touches the network. A broken source degrades to “last verified” data and a failing health entry — never to an empty page.

## Testing

- `shared/test/` — 86 tests: date parsing/classification, city & metro matching, dedupe & conflict resolution, status, countdown, geo.
- `backend/test/` — adapter normalization against **recorded real payloads**, ingest/merge/conflict/idempotency, search filters & sorting, SSRF guards, quality policy, HTTP API incl. validation errors.
- `frontend/test/` — cards, countdown, filters, bookmarks, empty/error states, inferred-deadline wording.
- `tests/e2e.test.ts` — boots the real server on the real database and verifies a Chennai search, alternate spellings, deadline fidelity, plus a **live spot-check** that stored deadlines equal Unstop's `end_regn_dt` right now.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (Docker, managed Postgres + Redis notes, worker processes, env vars, monitoring).

## Collection policy

We fetch only endpoints the publishers allow (see [`docs/SOURCES.md`](docs/SOURCES.md)): Unstop's `/api/public/*` (explicitly allowed by robots.txt, AI crawlers welcomed), Devpost's listing JSON (robots.txt disallows nothing for generic agents), MLH season pages (only private paths disallowed), with per-host spacing, retries and size/time caps. HackerEarth's adapter ships **disabled** because its data lives behind AJAX endpoints its robots.txt disallows.
