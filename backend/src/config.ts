import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

function envFile(): Record<string, string> {
  // Minimal .env reader: no dependency, no evaluation of arbitrary code.
  const candidates = [
    process.env.ENV_FILE,
    resolve(REPO_ROOT, '.env'),
    resolve(REPO_ROOT, '..', '.env'),
  ].filter(Boolean) as string[];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const out: Record<string, string> = {};
    for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  }
  return {};
}

const fileEnv = envFile();

function str(key: string, fallback: string): string {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key] ?? fileEnv[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key] ?? fileEnv[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(key: string, fallback: string[]): string[] {
  const v = process.env[key] ?? fileEnv[key];
  if (v === undefined || v === '') return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const nodeEnv = str('NODE_ENV', 'development');

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',

  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),

  /**
   * When DATABASE_URL is set we talk to a real PostgreSQL server through
   * node-postgres. Otherwise we run an embedded PostgreSQL (PGlite) instance,
   * which is the same engine compiled to WebAssembly, so the schema, indexes and
   * SQL are identical in development and production.
   */
  databaseUrl: str('DATABASE_URL', ''),
  pgliteDataDir: str('PGLITE_DATA_DIR', resolve(REPO_ROOT, '.data', 'pglite')),

  corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173', 'http://127.0.0.1:5173']),

  rateLimit: {
    max: num('RATE_LIMIT_MAX', 300),
    windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
  },

  /** Per-source politeness. Requests are spaced by this much on average. */
  http: {
    userAgent: str(
      'HTTP_USER_AGENT',
      'HackathonFinderBot/1.0 (+https://github.com/hackathon-finder; contact: ops@example.com)',
    ),
    timeoutMs: num('HTTP_TIMEOUT_MS', 20_000),
    maxBytes: num('HTTP_MAX_BYTES', 8 * 1024 * 1024),
    maxRedirects: num('HTTP_MAX_REDIRECTS', 3),
    /** Minimum delay between two requests to the same host. */
    perHostDelayMs: num('HTTP_PER_HOST_DELAY_MS', 1_200),
    retries: num('HTTP_RETRIES', 3),
  },

  geocoder: {
    provider: str('GEOCODER_PROVIDER', 'photon'),
    endpoint: str('GEOCODER_ENDPOINT', 'https://photon.komoot.io/api/'),
    /** Fair-use: stay well under one request per second. */
    minIntervalMs: num('GEOCODER_MIN_INTERVAL_MS', 1_100),
    timeoutMs: num('GEOCODER_TIMEOUT_MS', 12_000),
    enabled: bool('GEOCODER_ENABLED', true),
  },

  adapters: {
    unstop: { enabled: bool('ADAPTER_UNSTOP_ENABLED', true) },
    devpost: { enabled: bool('ADAPTER_DEVPOST_ENABLED', true) },
    mlh: { enabled: bool('ADAPTER_MLH_ENABLED', true) },
    /**
     * HackerEarth listings are rendered client-side and their data endpoints are
     * excluded by robots.txt (`Disallow: /*AJAX`). The adapter is implemented but
     * ships disabled so we never fetch a disallowed endpoint.
     */
    hackerearth: { enabled: bool('ADAPTER_HACKEREARTH_ENABLED', false) },
    organizer_website: { enabled: bool('ADAPTER_ORGANIZER_ENABLED', true) },
  },

  /**
   * Devpost publishes one deadline, used for submissions. Registration on the
   * platform closes at the same instant, so we mirror it and label the record as
   * inferred rather than verified. Turn off to leave registration_deadline null
   * and let the UI say "Not specified".
   */
  devpostInferRegistrationDeadline: bool('DEVPOST_INFER_REGISTRATION_DEADLINE', true),
  /** Enrich Devpost records with their detail page (adds the precise timezone). */
  devpostDetailEnrichment: bool('DEVPOST_DETAIL_ENRICHMENT', true),
  devpostMaxDetailFetches: num('DEVPOST_MAX_DETAIL_FETCHES', 400),

  ingest: {
    maxPagesPerSource: num('INGEST_MAX_PAGES', 12),
    pageSize: num('INGEST_PAGE_SIZE', 25),
    unstopOppStatus: str('UNSTOP_OPPSTATUS', 'open'),
    /**
     * When true and the database holds zero hackathons, run a light crawl in
     * the background right after the server starts listening. This is how a
     * fresh free-tier deploy populates itself with no operator action. Never
     * blocks boot, never re-runs once rows exist.
     */
    onBoot: bool('INGEST_ON_BOOT', false),
  },

  refresh: {
    enabled: bool('REFRESH_ENABLED', true),
    intervalMs: num('REFRESH_INTERVAL_MS', 15 * 60_000),
    batchSize: num('REFRESH_BATCH_SIZE', 25),
  },

  /**
   * Refresh-on-visit: every search request may kick off a background crawl of
   * the fast sources (Unstop + MLH, no venue geocoding, no Devpost detail
   * enrichment), at most once per interval. The response itself is never
   * delayed — the crawl runs behind it and the client is told via the
   * `refreshing` flag. A literal crawl-on-every-visit would take minutes per
   * page view and get our IP throttled by the sources; this is the polite
   * equivalent with the same visible effect.
   */
  visitRefresh: {
    enabled: bool('VISIT_REFRESH_ENABLED', true),
    intervalMs: num('VISIT_REFRESH_INTERVAL_MS', 30 * 60_000),
    manualIntervalMs: num('MANUAL_REFRESH_INTERVAL_MS', 5 * 60_000),
  },

  frontendDist: str('FRONTEND_DIST', resolve(REPO_ROOT, 'frontend', 'dist')),
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:8080'),
  adminToken: str('ADMIN_TOKEN', ''),
} as const;

export type AppConfig = typeof config;
