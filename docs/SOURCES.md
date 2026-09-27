# Sources & collection policy

Every adapter documents *why* its read path is permitted, and the app exposes it at `GET /api/admin/sources`. The rule is simple: **if the publisher has not allowed a path, we do not fetch it** — even when that costs us coverage.

## Unstop — enabled

- **What we read:** `GET https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&oppstatus=open&page=N&per_page=25` — the same JSON endpoint Unstop's own web app calls. One page per request, spaced by `HTTP_PER_HOST_DELAY_MS` (default 1.2 s), with retries and backoff.
- **Why it is allowed:** `https://unstop.com/robots.txt` contains, for `User-agent: *`, both `Allow: /api/public/*` and `Disallow: /api/*`. Under the standard longest-match rule the specific allow wins for `/api/public/...`. The file additionally carries an explicit allow-list for AI crawlers (GPTBot, Claude-Web, ChatGPT-User, Perplexity, …). We touch no login-gated endpoint and register for nothing.
- **Fields used:** `regnRequirements.start_regn_dt` / `end_regn_dt` (registration opens/closes — structured), `end_date` (event end), `address_with_country_logo` (city/state/country), `region`, `filters[type=eligible|domain]`, `required_skills`, `prizes`, `payment_services`, `min/max_team_size`, `organisation`, `seo_url`, `short_url` (registration link).
- **Limits:** no event-start is published by this endpoint, so none is stored. `oppstatus=open` is the only honored filter, so city filtering happens in our own engine.

## Devpost — enabled

- **What we read:** `GET https://devpost.com/api/hackathons?page=N&status[]=open&status[]=upcoming`, plus one request per event page for the exact “Deadline: Sep 30, 2026 @ 11:45pm PDT” wording, capped by `DEVPOST_MAX_DETAIL_FETCHES` and spaced per host.
- **Why it is allowed:** `https://devpost.com/robots.txt` is `User-agent: *` with an empty `Disallow:` — nothing is disallowed for generic agents (only named bad bots are banned).
- **Fields used:** `title`, `organization_name`, `displayed_location`, `open_state`, `submission_period_dates`, `time_left_to_submission`, `themes`, `prize_amount` (HTML with `data-currency-value`), `url`, detail-page deadline/overview/eligibility.
- **Honesty rule:** Devpost publishes a single submission deadline. It is stored as `submission_deadline`; mirroring into `registration_deadline` happens only with basis `inferred_from_submission_deadline`, confidence `inferred`, and a UI note. Set `DEVPOST_INFER_REGISTRATION_DEADLINE=false` to leave it null.

## Major League Hacking — enabled

- **What we read:** `GET https://mlh.io/seasons/{2027,2026,2025}/events` (redirects to `mlh.com`), parsing the embedded Inertia JSON payload — structured data, not markup scraping.
- **Why it is allowed:** `https://www.mlh.com/robots.txt` disallows only `/account/`, `/tools/`, `/_/`, `/v4/`, `/auth/`, `/admin/`, `/sidekiq/` and invite paths, with `Allow: /`. Season event pages are public.
- **Fields used:** `name`, `slug`, `status`, `startsAt`, `endsAt`, `location`, `formatType`, `websiteUrl`, `venueAddress`, `customFields`.
- **Honesty rule:** MLH publishes no registration deadline, so these records carry none (`data_quality: unknown`, “Not specified” in the UI, excluded from open-only filtering).

## HackerEarth — implemented, disabled

- **Why disabled:** `https://www.hackerearth.com/robots.txt` allows `/` but disallows `/*AJAX`, and `/hackathons/` is client-rendered — the event data is only reachable through those AJAX endpoints. Fetching them would knowingly use a disallowed path, so the adapter stays off. `ADAPTER_HACKEREARTH_ENABLED=true` only makes sense if the site starts serving listings server-side or publishes a public API. The normalizer is unit-tested and ready.

## Organizer / university pages — enabled, URL-driven

- **What we read:** operator-supplied public URLs only (via `POST /api/admin/ingest-url`, token-gated). Every request passes the SSRF guard: http/https only, DNS resolved and checked against private/loopback/link-local/metadata ranges, no infrastructure ports, redirects re-validated per hop, size and time caps.
- **How dates are taken:** schema.org `Event` JSON-LD (`startDate`/`endDate`/location) first, then labelled-text classification at reduced confidence. Ambiguous labels yield no deadline.

## Geocoding — Photon

Coordinates come from Photon (`https://photon.komoot.io`, OpenStreetMap-based), one request at a time with `GEOCODER_MIN_INTERVAL_MS` spacing, cached forever in `geocode_cache` with provider + raw payload. Nominatim's public instance denies traffic from many hosting networks, which is why it is not the default. No coordinate is ever hand-written; the static city registry (`shared/src/cities.ts`) deliberately contains no lat/lon.

## Adding a source

1. Implement `SourceAdapter` in `backend/src/adapters/<name>.ts` (see `types.ts`).
2. Map every date to its semantic field; add a test in `backend/test/adapters.test.ts` with a recorded payload.
3. Register it in `adapters/index.ts`, add the env toggle, document the robots/API terms here.
4. Never invent a deadline to fill a gap — leave it null.
