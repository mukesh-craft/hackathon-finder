# Architecture

## Principles

1. **Evidence or nothing.** A field is populated with a sourced value or left null. The UI renders null as “Not specified” with a link, never as a guess.
2. **Registration deadline is a first-class fact.** It has its own column, its own provenance, its own precision flag and its own conflict tracking — because the whole product stands or falls on it.
3. **Search is a database read.** Ingestion is a background pipeline. A user request performs indexed SQL and returns; it never crawls, never geocodes live, never waits on a third party.
4. **One source failing changes nothing for users.** Adapters run isolated, record their own health, and leave previous rows untouched on failure.
5. **Pure logic lives in `shared/`.** Date parsing, city matching, dedupe and geo have no I/O and no dependencies, so they are unit-tested exhaustively and reused by the frontend for display.

## Components

```
┌────────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────┐
│  Adapters  │──▶│ IngestService│──▶│ PostgreSQL  │──▶│ REST API │──▶ SPA
│ (per source)│   │ (merge/match)│   │ (PGlite/PG) │   │(Fastify) │
└────────────┘   └──────────────┘   └─────────────┘   └──────────┘
      ▲                 ▲                  ▲                ▲
      │                 │                  │                │
 safeFetch        CityService +      migrations        Zod validation,
 (SSRF guard,     Geocoder (cached)  (identical SQL    rate limit,
  throttle,       quality + refresh  both engines)     helmet, CORS
  retries)        policy
```

### Adapters (`backend/src/adapters/`)

`SourceAdapter.run(ctx)` crawls and pushes `RawHackathon` records through `ctx.onRecord` as they arrive — a failed page or record never discards the rest. Each adapter declares `enabled`, `homepage` and a `policyNote` explaining why its read path is permitted (surfaced in `/api/admin/sources`).

- **unstop**: public opportunity JSON. Maps `regnRequirements.end_regn_dt` → registration deadline, `end_date` → event end. No event-start is published, so none is stored.
- **devpost**: listing JSON + detail page for the exact “Deadline: … @ … TZ” wording. Stores the submission deadline as stated; mirrors it into registration_deadline only as `inferred` (configurable).
- **mlh**: season page's embedded Inertia JSON. Publishes starts/ends/venue but no registration deadline — records carry none.
- **hackerearth**: implemented, disabled by policy (listings are client-rendered; data endpoints are robots-disallowed).
- **organizer-website**: URL-driven; schema.org Event JSON-LD first, then labelled-text classification. Most conservative confidence scoring.

### Normalize → resolve → merge (`services/ingest.ts`)

1. **City resolution** (`services/cities.ts` + `shared/cities.ts`): the event's own city text maps to a `cities` row via the alias/metro registry (“Bangalore” → Bengaluru, “Karjat” → itself in the Mumbai metro). Coordinates come only from the cached geocoder.
2. **Dedup** (`shared/dedupe.ts`): same-source listings are never merged. Cross-source candidates are narrowed in SQL by title tokens/city/URL, then judged by title similarity + organizer + place + dates. Full-URL identity (host+path) short-circuits obvious matches.
3. **Reconcile** (`shared/dedupe.ts#reconcile`): values from several sources resolve by source authority (`organizer_website` 5 > `unstop`/`devpost`/`mlh` 4 > `hackerearth` 3). Equal-authority disagreement on `registration_deadline` sets `deadline_conflict` with both values preserved; other-field disagreements go to `field_conflicts` without touching the deadline flag.
4. **Persist**: one `hackathons` row, one `hackathon_sources` row per listing (original payload in `source_payload`), per-field `field_provenance` rows. Re-runs are idempotent (`ON CONFLICT` everywhere).

### Dates (`shared/dates.ts`)

- `findDateExpressions`: ISO-8601, day/month/year in either order, ordinals, numeric forms, weekday prefixes; times with meridiem/24h; zones as abbreviations or numeric offsets. A bare timezone after a dateless… no — a date with a zone but no clock stays `date_only` while recording the zone.
- Forward scan attaches “at 11:59 PM IST” to its date but refuses across sentence boundaries or intervening dates.
- `classifyLabel` orders rules most-specific-first and returns `ambiguous` when a phrase names two milestones (“registration and submission deadline”) — the date then stays unclassified.
- `computeRegistrationStatus`: future → open, past → closed, none → unknown; date-only deadlines stay open through the end of the stated day.
- Presentation (`formatDeadline`, `countdownTo`, frontend `deadlines.ts`) renders source wall-clock + source label + viewer-local equivalent separately.

### Search (`services/search.ts`)

Indexed filters (city keys incl. metro siblings + `location_text` fallback, bounding-box + haversine radius, status/mode/money/team/taxonomy/dates/text) with a single parameter binder, facet queries, and default ordering that puts open registrations with the nearest deadline first and deadline-less rows last. Status is recomputed from the stored deadline on every read, so a passed deadline flips to closed without waiting for a crawl.

### Freshness (`services/quality.ts`, `workers/scheduler.ts`)

Grades (`verified`/`source_confirmed`/`partially_verified`/`unknown`) derive from evidence strength. `next_verification_at` is deadline-proximity based (hourly < 2 days … weekly when closed). The scheduler recomputes statuses, then re-crawls sources staggered; `workers/refresh-worker.ts` runs the same loop as a separate process in production.

### Frontend (`frontend/src/`)

React Router SPA: `Home` (hero search, popular cities, open/closing-soon rails), `SearchResults` (filter panel, cards, pagination), `Details` (deadline panel, timeline, sources, provenance table), `Admin` (stats, crawls, source health). Deadlines render from API data via `deadlineView`; countdowns tick locally but status comes from the backend. Bookmarks live in `localStorage` (no account). SEO routes (`/seo/hackathons/:city`, `/seo/hackathon/:slug`) emit title/description/canonical/OG/JSON-LD plus a `<noscript>` event list from the same rows.

## Data model

See `database/migrations/001_init.sql` (core), `002_source_payload.sql`, `003_field_conflicts.sql`. Notable choices:

- Dates stored twice: `<field>` (precision-preserving ISO text) + `<field>_ts` (timestamptz for indexing/ordering) — lexicographic sorting of mixed-offset ISO strings would be wrong.
- `registration_deadline_basis` distinguishes `source_explicit` from `inferred_from_submission_deadline`.
- `field_provenance` records field/value/source/url/time/confidence per contribution.
- `source_health` + `crawl_runs` power the admin dashboard.
- `reminder_subscriptions` is the schema basis for future deadline reminders (Section 21); nothing sends mail yet.

## Failure modes (all covered by tests or runtime guards)

source down · timeout · malformed HTML/JSON · missing deadline/city · invalid date · timezone ambiguity · duplicate listings · conflicting sources · API misuse (400s) · rate limiting (429 + headers) · expired registrations · oversized responses · redirect to private network (re-validated per hop) · DNS rebinding to metadata IP (checked post-resolution).
