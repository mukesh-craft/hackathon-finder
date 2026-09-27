/**
 * REST API.
 *
 * Everything a user request touches is a read from PostgreSQL. No route performs
 * a network fetch, so a slow or broken source can never slow down or break a
 * search. Ingestion is a background concern handled by the crawl service.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { SearchQuery, SortOption } from '@hf/shared';
import type { Db } from '../db/client.js';
import { SearchService } from '../services/search.js';
import { CityService } from '../services/cities.js';
import { pipelineStats, recentCrawls } from '../services/stats.js';
import { ADAPTERS } from '../adapters/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ingestOrganizerPage } from '../adapters/organizer-website.js';
import { IngestService } from '../services/ingest.js';
import { RefreshCoordinator } from '../services/refresh-coordinator.js';
import { popularCities, suggestCities } from '@hf/shared';
import { seoHtml } from './seo.js';

const SORTS: SortOption[] = ['relevance', 'deadline', 'event_date', 'distance', 'prize', 'recently_updated'];

/** Query validation. Unknown or malformed values are rejected, never guessed. */
const listQuerySchema = z.object({
  city: z.string().trim().min(1).max(120).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  open: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  radius: z.coerce.number().min(0).max(2000).optional(),
  mode: z.enum(['all', 'online', 'offline']).optional(),
  free: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  paid: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  prize: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  teamSize: z.coerce.number().int().min(1).max(1000).optional(),
  theme: z.union([z.string(), z.array(z.string())]).optional(),
  tech: z.union([z.string(), z.array(z.string())]).optional(),
  eligibility: z.union([z.string(), z.array(z.string())]).optional(),
  eventFrom: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  eventTo: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  sort: z.enum(SORTS as [SortOption, ...SortOption[]]).optional(),
  page: z.coerce.number().int().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  exactCity: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
});

const toArray = (v: string | string[] | undefined): string[] | undefined => {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : v.split(',');
  const cleaned = list.map((s) => s.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
};

function parseListQuery(raw: unknown): { query: SearchQuery } | { error: string } {
  const parsed = listQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ') };
  }
  const d = parsed.data;
  return {
    query: {
      city: d.city,
      q: d.q,
      openOnly: d.open ?? false,
      radiusKm: d.radius ?? (d.city ? 50 : null),
      mode: d.mode ?? 'all',
      freeOnly: d.free ?? false,
      paidOnly: d.paid ?? false,
      prizeOnly: d.prize ?? false,
      // A single team size means "my team has exactly N members": the event
      // fits when N falls inside its accepted range, so both bounds are set.
      teamSizeMin: d.teamSize ?? null,
      teamSizeMax: d.teamSize ?? null,
      themes: toArray(d.theme),
      technologies: toArray(d.tech),
      eligibility: toArray(d.eligibility),
      eventFrom: d.eventFrom ?? null,
      eventTo: d.eventTo ?? null,
      sort: d.sort ?? 'relevance',
      page: d.page ?? 1,
      limit: d.limit ?? 24,
    },
  };
}

export interface RouteDeps {
  db: Db;
  /** Enables POST /api/admin/crawl and /api/admin/ingest-url. */
  enableIngestRoutes?: boolean;
}

export async function registerApiRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db } = deps;
  const search = new SearchService(db);
  const cities = new CityService(db);
  const refresher = new RefreshCoordinator(db, logger);

  // ---- health --------------------------------------------------------------
  app.get('/api/health', async () => {
    const res = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM hackathons');
    return {
      status: 'ok',
      driver: db.driver,
      hackathons: Number(res.rows[0]?.n ?? 0),
      uptimeSeconds: Math.round(process.uptime()),
      now: new Date().toISOString(),
    };
  });

  // ---- search --------------------------------------------------------------
  app.get('/api/hackathons', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseListQuery(req.query);
    if ('error' in parsed) {
      return reply.code(400).send({ error: 'invalid_query', message: parsed.error });
    }
    try {
      const result = await search.search(parsed.query);
      // Opportunistic freshness: at most one cheap check here; a crawl, when
      // due, runs in the background and never delays this response.
      const refresh = await refresher.maybeRefresh({ manual: false });
      return reply.send({ ...result, refreshing: refresh.started });
    } catch (err) {
      logger.error('search failed', { error: (err as Error).message });
      return reply.code(500).send({ error: 'search_failed', message: 'Search could not be completed.' });
    }
  });

  app.get('/api/hackathons/slug/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const record = await search.getBySlug(slug);
    if (!record) return reply.code(404).send({ error: 'not_found', message: 'No hackathon with that slug.' });
    const provenance = await search.provenance(record.id);
    return reply.send({ hackathon: record, provenance, generatedAt: new Date().toISOString() });
  });

  app.get('/api/hackathons/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return reply.code(400).send({ error: 'invalid_id', message: 'Hackathon id must be a UUID.' });
    }
    const record = await search.getById(id);
    if (!record) return reply.code(404).send({ error: 'not_found', message: 'No hackathon with that id.' });
    const provenance = await search.provenance(record.id);
    return reply.send({ hackathon: record, provenance, generatedAt: new Date().toISOString() });
  });

  // ---- places --------------------------------------------------------------
  app.get('/api/cities', async (req, reply) => {
    const { limit } = req.query as { limit?: string };
    const parsed = z.coerce.number().int().min(1).max(200).safeParse(limit ?? 50);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', message: 'limit must be 1-200' });
    const rows = await cities.listCitiesWithEvents(parsed.data);
    return reply.send({ count: rows.length, cities: rows, popular: popularCities() });
  });

  app.get('/api/cities/suggest', async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q) return reply.send({ results: suggestCities('', 8) });
    if (q.length > 80) return reply.code(400).send({ error: 'invalid_query', message: 'q too long' });
    return reply.send({ results: suggestCities(q, 8) });
  });

  app.get('/api/cities/resolve', async (req, reply) => {
    const { city } = req.query as { city?: string };
    if (!city || city.length > 120) {
      return reply.code(400).send({ error: 'invalid_query', message: 'city is required' });
    }
    return reply.send(await cities.resolveQuery(city));
  });

  // ---- admin ---------------------------------------------------------------
  // Read-only pipeline health is public: it contains aggregate counts, source
  // health and crawl history — no secrets. Only crawl/ingest triggers need a
  // token because they spend server resources and hit third parties.
  app.get('/api/admin/stats', async (_req, reply) => {
    return reply.send(await pipelineStats(db));
  });

  app.get('/api/admin/crawls', async (_req, reply) => {
    return reply.send({ runs: await recentCrawls(db, 25) });
  });

  app.get('/api/admin/sources', async (_req, reply) => {    return reply.send({
      sources: ADAPTERS.map((a) => ({
        id: a.id,
        name: a.name,
        homepage: a.homepage,
        enabled: a.enabled,
        policyNote: a.policyNote,
      })),
    });
  });

  /**
   * Manual refresh, safe to expose: interval-guarded (default 5 min), runs the
   * light source profile in the background, and never blocks the response.
   * Global rate limiting applies on top.
   */
  app.post('/api/refresh', async (_req, reply) => {
    const attempt = await refresher.maybeRefresh({ manual: true });
    return reply.send({ started: attempt.started, reason: attempt.reason, retryAfterMs: attempt.retryAfterMs });
  });

  /**
   * Trigger a crawl. Enabled only when ADMIN_TOKEN is configured and the caller
   * presents it, so an accidental deployment cannot be crawled by the internet.
   */
  app.post('/api/admin/crawl', async (req, reply) => {
    if (!deps.enableIngestRoutes || !authorized(req)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Set ADMIN_TOKEN to enable crawling.' });
    }
    const body = req.body as { sources?: string[]; geocodeVenues?: boolean } | undefined;
    const parsed = z
      .object({ sources: z.array(z.enum(['unstop', 'devpost', 'mlh', 'hackerearth'])).optional(), geocodeVenues: z.boolean().optional() })
      .safeParse(body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { CrawlService } = await import('../services/crawl.js');
    const service = new CrawlService(db, logger);
    const summary = await service.crawl({
      sources: parsed.data.sources as never,
      geocodeVenues: parsed.data.geocodeVenues ?? true,
      logger,
    });
    return reply.send(summary);
  });

  /**
   * Ingest a single organizer page. The URL goes through the SSRF guard, so an
   * attacker cannot use this to probe internal services.
   */
  app.post('/api/admin/ingest-url', async (req, reply) => {
    if (!deps.enableIngestRoutes || !authorized(req)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Set ADMIN_TOKEN to enable ingestion.' });
    }
    const parsed = z
      .object({ url: z.string().url().max(500), city: z.string().max(120).nullish(), state: z.string().max(120).nullish() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', message: 'url must be a valid URL' });
    try {
      const result = await ingestOrganizerPage({
        url: parsed.data.url,
        cityHint: parsed.data.city ?? null,
        stateHint: parsed.data.state ?? null,
      }, logger);
      const svc = new IngestService(db, { logger });
      const stats = await svc.ingest(result.record);
      return reply.send({ stats, notes: result.notes, detected: result.detected.map((d) => ({ kind: d.kind, iso: d.iso, raw: d.raw, confidence: d.confidence })) });
    } catch (err) {
      const message = (err as Error).message;
      logger.warn('organizer ingest failed', { url: parsed.data.url, error: message });
      return reply.code(422).send({ error: 'ingest_failed', message });
    }
  });

  app.get('/api/top-cities', async () => ({ cities: await search.topCities(8) }));

  app.get('/api/sitemap', async (_req, reply) => {
    const [cityRows, eventRows] = await Promise.all([
      db.query<{ slug: string; name: string }>('SELECT id AS slug, name FROM cities WHERE event_count > 0 ORDER BY event_count DESC LIMIT 200'),
      db.query<{ slug: string; updated_at: Date }>("SELECT slug, updated_at FROM hackathons WHERE registration_status <> 'closed' ORDER BY updated_at DESC LIMIT 2000"),
    ]);
    const base = config.publicBaseUrl.replace(/\/$/, '');
    const urls = [
      { loc: `${base}/`, priority: '1.0' },
      ...cityRows.rows.map((c) => ({ loc: `${base}/hackathons/${c.slug}`, priority: '0.8' })),
      ...eventRows.rows.map((e) => ({ loc: `${base}/hackathon/${e.slug}`, priority: '0.6' })),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>`)
      .join('\n')}\n</urlset>`;
    return reply.type('application/xml; charset=utf-8').send(xml);
  });

  app.get('/api/robots.txt', async (_req, reply) => {
    const base = config.publicBaseUrl.replace(/\/$/, '');
    return reply
      .type('text/plain; charset=utf-8')
      .send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\n\nSitemap: ${base}/api/sitemap\n`);
  });

  // Server-rendered <head> for the SEO routes, so crawlers get real metadata
  // and a noscript list even though the app itself is a client-rendered SPA.
  app.get('/seo/hackathons/:city', async (req, reply) => {
    const { city } = req.params as { city: string };
    const result = await search.search({ city, page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance' });
    return reply.type('text/html; charset=utf-8').send(seoHtml({ kind: 'city', city, result }));
  });

  app.get('/seo/hackathon/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const record = await search.getBySlug(slug);
    if (!record) return reply.code(404).type('text/html; charset=utf-8').send(seoHtml({ kind: 'missing', slug }));
    return reply.type('text/html; charset=utf-8').send(seoHtml({ kind: 'event', record }));
  });
}

function authorized(req: FastifyRequest): boolean {
  if (!config.adminToken) return !config.isProduction;
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const xAdmin = typeof req.headers['x-admin-token'] === 'string' ? (req.headers['x-admin-token'] as string) : '';
  return bearer === config.adminToken || xAdmin === config.adminToken;
}
