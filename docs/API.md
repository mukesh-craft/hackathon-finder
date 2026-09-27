# API reference

Base URL: the same origin that serves the SPA (e.g. `http://localhost:8080`). All responses are JSON. Errors use `{ "error": "<code>", "message": "<human text>" }`.

## GET /api/health

Liveness plus row counts. `{ status, driver, hackathons, uptimeSeconds, now }`.

## GET /api/hackathons — search

The core endpoint. Reads come from PostgreSQL; nothing here performs network I/O.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `city` | string | — | City name, alias or locality (“Chennai”, “Bombay”, “Bangalore Urban”, “OMR”). Unknown places fall back to geocoding + radius. |
| `q` | string | — | Free text over title/organizer/description. |
| `open` | bool | `false` | `true` → only `registration_status = 'open'`. Default hides `closed` but keeps `unknown` (no published deadline). |
| `radius` | number (km) | `50` when `city` is set | Bounding-box + haversine filter around the resolved city. Events without coordinates are kept when their place already matches. |
| `mode` | `all`\|`online`\|`offline` | `all` | `offline` includes `hybrid`. |
| `free` / `paid` | bool | `false` | Entry-fee filter. |
| `prize` | bool | `false` | Only events with a prize amount. |
| `teamSize` | int | — | Your team size; keeps events whose accepted range overlaps it (unknown ranges are kept). |
| `theme` / `tech` | string (repeatable) | — | Overlap match against `themes[]` / `technologies[]`. |
| `eligibility` | string (repeatable) | — | Case-insensitive substring match. |
| `eventFrom` / `eventTo` | ISO date | — | Filters on event start. |
| `sort` | `relevance`\|`deadline`\|`event_date`\|`distance`\|`prize`\|`recently_updated` | `relevance` | Default: open first, nearest deadline first, deadline-less last. |
| `page` / `limit` | int | `1` / `24` (max 100) | Pagination. |

Response:

```json
{
  "city": { "query": "Chennai", "name": "Chennai", "match": "exact", "latitude": 13.08, "longitude": 80.27, "notes": ["Matched city ..."], "aliases": ["Madras"], "metroMembers": ["Ambattur", "..."] },
  "count": 6, "total": 6, "page": 1, "limit": 24, "hasMore": false,
  "results": [ { "id": "uuid", "slug": "...", "title": "...", "registrationDeadline": "2026-09-29T23:59:00+05:30", "registrationDeadlinePrecision": "instant", "registrationDeadlineTimezone": "IST", "registrationDeadlineBasis": "source_explicit", "registrationStatus": "open", "dataQuality": "verified", "deadlineConflict": false, "sources": [{ "source": "unstop", "sourceUrl": "..." }], "...": "..." } ],
  "facets": { "themes": [...], "technologies": [...], "eligibility": [...], "online": 1, "offline": 5, "withPrize": 4, "withDeadline": 6, "withConflict": 0 },
  "dataFreshness": { "lastIngestAt": "...", "lastIngestSource": "unstop", "sourcesWithData": ["unstop"] },
  "generatedAt": "...",
  "refreshing": false,
  "online": { "total": 0, "results": [] }
}
```

Countdowns anchor to `generatedAt` (server time), never the device clock.

Example: `GET /api/hackathons?city=Chennai`, `GET /api/hackathons?city=Chennai&open=true`, `GET /api/hackathons?city=Chennai&radius=50`.

## POST /api/refresh — manual refresh

Asks the server for a background crawl of the fast sources (Unstop + MLH). Interval-guarded (default 5 min for manual, 30 min automatic on any search), never blocks. Response: `{ started, reason, retryAfterMs }`. Every `GET /api/hackathons` may also trigger the automatic variant and reports it via `refreshing`.

## GET /api/hackathons/slug/:slug and GET /api/hackathons/:id

Full record plus `{ provenance: [{ field, value, source, sourceUrl, retrievedAt, confidence }] }`. 404 for unknown slugs, 400 for malformed ids.

## GET /api/cities · /api/cities/suggest?q= · /api/cities/resolve?city= · /api/top-cities

Cities that actually have events (with open counts), autocomplete suggestions, and query resolution with metro notes.

## Health (public read) and gated triggers

- `GET /api/admin/stats` — totals, per-source health, last crawl. Public.
- `GET /api/admin/crawls` — recent `crawl_runs` rows. Public.
- `GET /api/admin/sources` — adapters with their collection-policy notes (public).
- `POST /api/admin/crawl` `{ sources?, geocodeVenues? }` — run a crawl now. Requires the token.
- `POST /api/admin/ingest-url` `{ url, city?, state? }` — ingest one organizer page through the SSRF guard. Requires the token.

Pass the token as `Authorization: Bearer <token>` or `X-Admin-Token`.

## SEO, sitemap, robots

- `GET /seo/hackathons/:city`, `GET /seo/hackathon/:slug` — server-rendered metadata + JSON-LD + `<noscript>` lists (the SPA shell at `/hackathons/:city` and `/hackathon/:slug` proxies to these for crawlers).
- `GET /api/sitemap` — XML sitemap of indexable routes.
- `GET /api/robots.txt` — allows `/`, disallows `/api/` and `/admin`.

## Rate limiting & security

Global 300 req/min/IP (configurable) with `Retry-After`; admin ingest routes additionally require the token. Helmet sets CSP/HSTS-style headers, CORS is allow-listed, bodies are capped, and all query/body input is Zod-validated (invalid values get 400, never silent coercion).
