-- Hackathon Finder — initial schema
--
-- Design notes
--  * Dates are stored twice: `<field>` keeps the source's precision-preserving
--    ISO text (so a date-only deadline stays a date and the UI can say
--    "time not specified"), while `<field>_ts` holds a timestamptz used for
--    indexing, ordering and open/closed comparisons. Sorting ISO strings with
--    mixed UTC offsets lexicographically would be wrong, hence the split.
--  * Nullable means "the source did not say". Nothing is defaulted into a value.

CREATE TABLE IF NOT EXISTS cities (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  normalized_name  text NOT NULL,
  state            text,
  country          text,
  country_code     text,
  latitude         double precision,
  longitude        double precision,
  metro            text,
  is_locality      boolean NOT NULL DEFAULT false,
  geocode_source   text,
  geocoded_at      timestamptz,
  event_count      integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cities_name_state_idx ON cities (normalized_name, coalesce(state, ''));
CREATE INDEX IF NOT EXISTS cities_normalized_idx ON cities (lower(normalized_name));
CREATE INDEX IF NOT EXISTS cities_geo_idx ON cities (latitude, longitude);
CREATE INDEX IF NOT EXISTS cities_metro_idx ON cities (metro);

CREATE TABLE IF NOT EXISTS hackathons (
  id                            uuid PRIMARY KEY,
  slug                          text NOT NULL UNIQUE,
  title                         text NOT NULL,
  description                   text,
  organizer                     text,
  source                        text NOT NULL,
  source_url                    text NOT NULL,
  registration_url              text,

  location_text                 text,
  city_id                       text REFERENCES cities (id) ON DELETE SET NULL,
  city_name                     text,
  city_key                      text,
  metro                         text,
  state                         text,
  country                       text,
  venue                         text,
  latitude                      double precision,
  longitude                     double precision,
  geocode_source                text,

  event_type                    text NOT NULL DEFAULT 'hackathon',
  online_or_offline             text NOT NULL DEFAULT 'unknown',

  registration_opens_at         text,
  registration_opens_ts         timestamptz,
  registration_deadline         text,
  registration_deadline_ts      timestamptz,
  registration_deadline_precision text NOT NULL DEFAULT 'none',
  registration_deadline_timezone text,
  registration_deadline_basis   text NOT NULL DEFAULT 'unknown',
  registration_status           text NOT NULL DEFAULT 'unknown',
  registration_status_note      text,

  hackathon_start               text,
  hackathon_start_ts            timestamptz,
  hackathon_end                 text,
  hackathon_end_ts              timestamptz,
  submission_deadline           text,
  submission_deadline_ts        timestamptz,
  idea_submission_deadline      text,
  idea_submission_deadline_ts   timestamptz,
  final_presentation            text,
  final_presentation_ts         timestamptz,
  result_announcement           text,
  result_announcement_ts        timestamptz,

  team_size_min                 integer,
  team_size_max                 integer,
  eligibility                   text,
  themes                        text[] NOT NULL DEFAULT '{}',
  technologies                  text[] NOT NULL DEFAULT '{}',

  prize_amount                  numeric,
  prize_currency                text,
  prize_details                 text,
  free_or_paid                  text NOT NULL DEFAULT 'unknown',
  registration_fee              numeric,
  registration_fee_currency     text,

  data_quality                  text NOT NULL DEFAULT 'unknown',
  deadline_conflict             boolean NOT NULL DEFAULT false,
  deadline_conflict_detail      jsonb,
  source_deadline_text          text,

  last_verified_at              timestamptz NOT NULL DEFAULT now(),
  next_verification_at          timestamptz,
  first_seen_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  is_merged                     boolean NOT NULL DEFAULT false,
  status_text                   text
);

CREATE INDEX IF NOT EXISTS hackathons_city_idx ON hackathons (city_id);
CREATE INDEX IF NOT EXISTS hackathons_city_key_idx ON hackathons (lower(city_key));
CREATE INDEX IF NOT EXISTS hackathons_reg_deadline_idx ON hackathons (registration_deadline_ts);
CREATE INDEX IF NOT EXISTS hackathons_event_start_idx ON hackathons (hackathon_start_ts);
CREATE INDEX IF NOT EXISTS hackathons_status_idx ON hackathons (registration_status);
CREATE INDEX IF NOT EXISTS hackathons_source_idx ON hackathons (source);
CREATE INDEX IF NOT EXISTS hackathons_mode_idx ON hackathons (online_or_offline);
CREATE INDEX IF NOT EXISTS hackathons_prize_idx ON hackathons (prize_amount DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS hackathons_geo_idx ON hackathons (latitude, longitude);
CREATE INDEX IF NOT EXISTS hackathons_refresh_idx ON hackathons (next_verification_at) WHERE next_verification_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS hackathons_title_lower_idx ON hackathons (lower(title));
CREATE INDEX IF NOT EXISTS hackathons_quality_idx ON hackathons (data_quality);
CREATE INDEX IF NOT EXISTS hackathons_themes_idx ON hackathons USING gin (themes);
CREATE INDEX IF NOT EXISTS hackathons_tech_idx ON hackathons USING gin (technologies);
-- Partial index for the hot path: "open registrations in a city".
CREATE INDEX IF NOT EXISTS hackathons_open_city_idx
  ON hackathons (city_id, registration_deadline_ts)
  WHERE registration_status = 'open';

-- One row per (source, source record). A merged hackathon can have several.
CREATE TABLE IF NOT EXISTS hackathon_sources (
  id               uuid PRIMARY KEY,
  hackathon_id     uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  source           text NOT NULL,
  source_record_id text NOT NULL,
  source_url       text NOT NULL,
  registration_url text,
  title_raw        text,
  organizer_raw    text,
  city_raw         text,
  is_primary       boolean NOT NULL DEFAULT false,
  fetch_status     text NOT NULL DEFAULT 'ok',
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  raw              jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS hackathon_sources_unique_idx
  ON hackathon_sources (source, source_record_id);
CREATE INDEX IF NOT EXISTS hackathon_sources_hackathon_idx ON hackathon_sources (hackathon_id);

-- Field-level provenance: which source asserted which value, and how confident.
CREATE TABLE IF NOT EXISTS field_provenance (
  id            bigserial PRIMARY KEY,
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  field         text NOT NULL,
  value         text,
  source        text NOT NULL,
  source_url    text NOT NULL,
  retrieved_at  timestamptz NOT NULL,
  confidence    text NOT NULL
);

CREATE INDEX IF NOT EXISTS field_provenance_hackathon_idx ON field_provenance (hackathon_id);
CREATE INDEX IF NOT EXISTS field_provenance_field_idx ON field_provenance (field);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id                uuid PRIMARY KEY,
  source            text NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            text NOT NULL DEFAULT 'running',
  records_seen      integer NOT NULL DEFAULT 0,
  records_upserted  integer NOT NULL DEFAULT 0,
  records_failed    integer NOT NULL DEFAULT 0,
  duration_ms       integer,
  error             text
);

CREATE INDEX IF NOT EXISTS crawl_runs_source_idx ON crawl_runs (source, started_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
  source               text PRIMARY KEY,
  enabled              boolean NOT NULL DEFAULT true,
  last_ok_at           timestamptz,
  last_error_at        timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error           text,
  avg_duration_ms      integer,
  success_count        integer NOT NULL DEFAULT 0,
  failure_count        integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Cached geocoder responses so we stay inside fair-use limits and keep working
-- offline. Every coordinate we store traces back to a row here.
CREATE TABLE IF NOT EXISTS geocode_cache (
  cache_key    text PRIMARY KEY,
  provider     text NOT NULL,
  display_name text,
  latitude     double precision,
  longitude    double precision,
  raw          jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Basis for the future reminder worker (spec section 21). Populated when a user
-- opts in; no notifications are sent by this version.
CREATE TABLE IF NOT EXISTS reminder_subscriptions (
  id              uuid PRIMARY KEY,
  hackathon_id    uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  email           text,
  lead_minutes    integer NOT NULL DEFAULT 1440,
  notify_channel  text NOT NULL DEFAULT 'email',
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);

CREATE INDEX IF NOT EXISTS reminder_subscriptions_hackathon_idx ON reminder_subscriptions (hackathon_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
