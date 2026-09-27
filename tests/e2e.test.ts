/**
 * End-to-end: boot the real HTTP server against the real database and prove
 * that a city search returns real, source-faithful results.
 *
 * These tests run against the project's development database (PGlite files or
 * DATABASE_URL). They do not seed fixtures — the point is to verify the actual
 * ingested data a user would see. A live spot-check against Unstop runs when
 * the network is reachable and is skipped gracefully otherwise.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getDb, type Db } from '../backend/src/db/client.js';
import { buildServer } from '../backend/src/http/server.js';

let app: FastifyInstance;
let db: Db;
let base = '';

beforeAll(async () => {
  db = await getDb();
  const { runMigrations } = await import('../backend/src/db/client.js');
  await runMigrations(db);
  app = await buildServer(db);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  base = address.replace('[::1]', '127.0.0.1');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 60_000);

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${path}: ${text.slice(0, 120)}`);
  }
  return { status: res.status, body };
}

interface SearchBody {
  city: { name: string | null; match: string };
  total: number;
  results: Array<{
    title: string;
    city: string | null;
    registrationStatus: string;
    registrationDeadline: string | null;
    registrationDeadlineTimezone: string | null;
    sourceUrl: string;
    registrationUrl: string | null;
    sources: Array<{ source: string; sourceUrl: string }>;
    dataQuality: string;
  }>;
}

describe('e2e — real city search', () => {
  it('serves a healthy API over real data', async () => {
    const { status, body } = await get<{ status: string; hackathons: number }>('/api/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.hackathons).toBeGreaterThan(50);
  });

  it('finds real hackathons in Chennai with registration deadlines and source links', async () => {
    const { status, body } = await get<SearchBody>('/api/hackathons?city=Chennai&limit=25');
    expect(status).toBe(200);
    expect(body.city.name).toBe('Chennai');
    expect(body.total).toBeGreaterThan(0);

    for (const h of body.results) {
      // Every displayed hackathon must open its original source.
      expect(h.sourceUrl).toMatch(/^https:\/\//);
      expect(h.sources.length).toBeGreaterThanOrEqual(1);
      // Open events must carry a deadline; unknown-deadline events must say so.
      if (h.registrationStatus === 'open') {
        expect(h.registrationDeadline).toBeTruthy();
      }
    }

    const withDeadline = body.results.filter((h) => h.registrationDeadline);
    expect(withDeadline.length).toBeGreaterThan(0);
    // Deadlines are ISO with an explicit offset or a bare date — never a bare guess.
    for (const h of withDeadline) {
      expect(h.registrationDeadline).toMatch(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/);
    }
  });

  it('resolves alternate spellings to the same city', async () => {
    const madras = await get<SearchBody>('/api/hackathons?city=Madras&limit=5');
    const chennai = await get<SearchBody>('/api/hackathons?city=Chennai&limit=5');
    expect(madras.body.city.name).toBe('Chennai');
    expect(madras.body.total).toBe(chennai.body.total);
  });

  it('keeps stored deadlines identical to the source snapshots', async () => {
    // For a sample of open Unstop records, the API's registration_deadline must
    // equal the end_regn_dt the source itself published — the anti-substitution
    // guarantee, checked against the database rather than fixtures. Merged rows
    // legitimately carry the winning source's value, so the check passes when
    // the row matches ANY of its contributing snapshots.
    const rows = await db.query<{
      title: string;
      registration_deadline: string | null;
      snapshots: Array<Record<string, unknown> | null>;
    }>(
      `SELECT h.title, h.registration_deadline, array_agg(hs.raw) AS snapshots
       FROM hackathons h JOIN hackathon_sources hs ON hs.hackathon_id = h.id
       WHERE h.registration_status = 'open' AND h.registration_deadline IS NOT NULL
         AND EXISTS (SELECT 1 FROM hackathon_sources s2 WHERE s2.hackathon_id = h.id AND s2.source = 'unstop')
       GROUP BY h.id, h.title, h.registration_deadline
       ORDER BY MAX(h.last_verified_at) DESC LIMIT 25`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    let checked = 0;
    for (const row of rows.rows) {
      const reported = row.snapshots
        .map((s) => s?.registration_deadline)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (reported.length === 0) continue;
      expect(reported, `deadline drift for "${row.title}"`).toContain(row.registration_deadline);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('live spot-check: the stored deadline matches Unstop right now', async () => {
    // Fetch one open listing straight from Unstop and compare with our row.
    // Skipped (not failed) when the network or the source is unreachable.
    let live: { data?: { data?: Array<{ id: number; title: string; regnRequirements?: { end_regn_dt?: string } }> } };
    try {
      const res = await fetch(
        'https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&oppstatus=open&page=1&per_page=5',
        { headers: { 'user-agent': 'HackathonFinderBot/1.0 e2e-spot-check', accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) return;
      live = (await res.json()) as typeof live;
    } catch {
      return;
    }
    const items = live.data?.data ?? [];
    if (items.length === 0) return;

    let compared = 0;
    for (const item of items.slice(0, 5)) {
      const expected = item.regnRequirements?.end_regn_dt;
      if (!expected) continue;
      const row = await db.query<{ registration_deadline: string | null }>(
        `SELECT h.registration_deadline FROM hackathons h
         JOIN hackathon_sources hs ON hs.hackathon_id = h.id
         WHERE hs.source = 'unstop' AND hs.source_record_id = $1`,
        [String(item.id)],
      );
      if (row.rows.length === 0) continue; // ingested after the spot-check sample; fine
      expect(row.rows[0].registration_deadline, `live mismatch for "${item.title}"`).toBe(expected);
      compared += 1;
    }
    // At least one direct comparison must succeed for the check to mean anything.
    expect(compared).toBeGreaterThan(0);
  });
});
