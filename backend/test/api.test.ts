/**
 * HTTP API tests: validation, search shape, details, cities, admin and SEO.
 * The server is exercised through inject() — no socket is opened.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RawHackathon } from '@hf/shared';
import { testDb, silentLogger } from './setup.js';
import { buildServer } from '../src/http/server.js';
import { IngestService } from '../src/services/ingest.js';
import { CityService } from '../src/services/cities.js';
import { config } from '../src/config.js';
import type { Db } from '../src/db/client.js';

let app: FastifyInstance;
let db: Db;

function rec(over: Partial<RawHackathon> & { title: string; source: RawHackathon['source']; sourceRecordId: string }): RawHackathon {
  return {
    sourceUrl: `https://example.org/${over.source}/${over.sourceRecordId}`,
    registrationUrl: null,
    retrievedAt: '2026-09-26T00:00:00.000Z',
    provenance: [],
    ...over,
  } as RawHackathon;
}

function dated(iso: string) {
  return {
    iso,
    kind: 'registration_deadline' as const,
    precision: (iso.length === 10 ? 'date_only' : 'instant') as 'date_only' | 'instant',
    sourceTimezone: 'IST',
    offsetMinutes: 330,
    raw: iso,
    label: 'Registration Deadline',
    confidence: 'verified' as const,
  };
}

beforeAll(async () => {
  db = testDb();
  await new CityService(db).seedRegistry();
  const svc = new IngestService(db, { logger: silentLogger });
  await svc.ingest(
    rec({
      title: 'API Chennai Sprint',
      source: 'unstop',
      sourceRecordId: 'api-1',
      organizer: 'IIT Madras',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2026-10-02T23:59:00+05:30'),
      prizeAmount: 100000,
      prizeCurrency: 'INR',
      themes: ['ai'],
      teamSizeMin: 1,
      teamSizeMax: 4,
    }),
  );
  await svc.ingest(
    rec({
      title: 'API Closed Classic',
      source: 'unstop',
      sourceRecordId: 'api-2',
      organizer: 'Anna University',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2020-05-01T00:00:00+05:30'),
    }),
  );
  await svc.ingest(
    rec({
      title: 'API Big Squad Jam',
      source: 'unstop',
      sourceRecordId: 'api-3',
      organizer: 'IIT Madras',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2026-10-03T23:59:00+05:30'),
      teamSizeMin: 5,
      teamSizeMax: 6,
    }),
  );
  app = await buildServer(db);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('GET /api/health', () => {
  it('reports driver and counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.hackathons).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/hackathons', () => {
  it('returns Chennai results with the documented envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hackathons?city=Chennai' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.city.name).toBe('Chennai');
    expect(body.total).toBe(2);
    expect(body.results[0].title).toBe('API Chennai Sprint');
    expect(body.results[0].registrationDeadline).toBe('2026-10-02T23:59:00+05:30');
    expect(body.results[0].registrationStatus).toBe('open');
    expect(body.results[0].sourceUrl).toBeTruthy();
    expect(Array.isArray(body.results[0].sources)).toBe(true);
    expect(body.facets).toBeTruthy();
    expect(body.dataFreshness).toBeTruthy();
  });

  it('filters by exact team size: a team of 2 fits 1-4 but not 5-6', async () => {
    const two = await app.inject({ method: 'GET', url: '/api/hackathons?city=Chennai&teamSize=2' });
    const titles2 = two.json().results.map((r: { title: string }) => r.title);
    expect(titles2).toContain('API Chennai Sprint');
    expect(titles2).not.toContain('API Big Squad Jam');

    const five = await app.inject({ method: 'GET', url: '/api/hackathons?city=Chennai&teamSize=5' });
    const titles5 = five.json().results.map((r: { title: string }) => r.title);
    expect(titles5).toContain('API Big Squad Jam');
    expect(titles5).not.toContain('API Chennai Sprint');
  });

  it('excludes closed registrations by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hackathons?city=Chennai' });
    expect(res.json().results.map((r: { title: string }) => r.title)).not.toContain('API Closed Classic');
  });

  it('rejects invalid query values with 400', async () => {
    for (const url of [
      '/api/hackathons?radius=abc',
      '/api/hackathons?radius=99999',
      '/api/hackathons?mode=sideways',
      '/api/hackathons?page=0',
      '/api/hackathons?limit=500',
      '/api/hackathons?sort=popularity',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
    }
  });

  it('paginates', async () => {
    const p1 = await app.inject({ method: 'GET', url: '/api/hackathons?city=Chennai&limit=1&page=1' });
    const p2 = await app.inject({ method: 'GET', url: '/api/hackathons?city=Chennai&limit=1&page=2' });
    expect(p1.json().results.length).toBe(1);
    expect(p2.json().results.length).toBe(1);
    expect(p1.json().hasMore).toBe(true);
    expect(p2.json().hasMore).toBe(false);
    expect(p1.json().results[0].title).not.toBe(p2.json().results[0].title);
  });
});

describe('GET /api/hackathons/slug/:slug and /:id', () => {
  it('serves a details payload with provenance', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/hackathons?city=Chennai' });
    const slug = list.json().results[0].slug;
    const res = await app.inject({ method: 'GET', url: `/api/hackathons/slug/${slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().hackathon.title).toBe('API Chennai Sprint');
    expect(Array.isArray(res.json().provenance)).toBe(true);
    expect(res.json().provenance.length).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown slug and 400 for a malformed id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/hackathons/slug/no-such-slug' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/hackathons/not-a-uuid' })).statusCode).toBe(400);
  });
});

describe('GET /api/cities*', () => {
  it('lists cities with events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cities' });
    expect(res.statusCode).toBe(200);
    expect(res.json().cities.some((c: { name: string }) => c.name === 'Chennai')).toBe(true);
  });

  it('suggests cities for autocomplete', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cities/suggest?q=chen' });
    expect(res.json().results[0].name).toBe('Chennai');
  });

  it('resolves a city with metro notes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cities/resolve?city=Bombay' });
    expect(res.json().name).toBe('Mumbai');
  });
});

describe('admin + seo', () => {
  it('serves pipeline stats publicly (read-only health, no token needed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.hackathons).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(res.json().sources)).toBe(true);
  });

  it('serves crawl history publicly', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/crawls' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().runs)).toBe(true);
  });

  it('still gates crawl triggers behind the token', async () => {
    if (!config.adminToken) return;
    const res = await app.inject({ method: 'POST', url: '/api/admin/crawl', payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('marks API responses as non-cacheable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hackathons?city=Chennai' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts manual refresh requests without blocking', async () => {
    // Test env disables visit refresh, so this asserts the safe fallback.
    const res = await app.inject({ method: 'POST', url: '/api/refresh' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().started).toBe('boolean');
    expect(typeof res.json().reason).toBe('string');
  });

  it('lists known sources and their collection policy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/sources' });
    const ids = res.json().sources.map((s: { id: string }) => s.id);
    expect(ids).toContain('unstop');
    expect(ids).toContain('devpost');
    expect(ids).toContain('mlh');
    expect(ids).toContain('hackerearth');
    const he = res.json().sources.find((s: { id: string }) => s.id === 'hackerearth');
    expect(he.enabled).toBe(false);
  });

  it('renders indexable SEO metadata for a city', async () => {
    const res = await app.inject({ method: 'GET', url: '/seo/hackathons/Chennai' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Hackathons in Chennai');
    expect(res.body).toContain('rel="canonical"');
    expect(res.body).toContain('application/ld+json');
    expect(res.body).toContain('API Chennai Sprint');
  });

  it('pre-renders real content into the home shell (works with JS disabled)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Find hackathons near you');
    // Real event with a working link, not a loading spinner.
    expect(res.body).toContain('API Chennai Sprint');
    expect(res.body).toContain('/hackathon/');
    // …while still booting the SPA when JS runs.
    expect(res.body).toContain('type="module"');
  });

  it('pre-renders city results into the shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/hackathons/chennai?city=Chennai' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Hackathons in Chennai');
    expect(res.body).toContain('API Chennai Sprint');
    expect(res.body).toContain('type="module"');
  });

  it('serves a sitemap and robots.txt', async () => {
    const sitemap = await app.inject({ method: 'GET', url: '/api/sitemap' });
    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.body).toContain('<urlset');
    const robots = await app.inject({ method: 'GET', url: '/api/robots.txt' });
    expect(robots.body).toContain('Sitemap:');
  });
});
