/**
 * Search-engine tests against a seeded database.
 * Covers city matching, metro expansion, radius, filters, sorting and facets.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import type { RawHackathon } from '@hf/shared';
import { testDb, silentLogger } from './setup.js';
import { SearchService } from '../src/services/search.js';
import { IngestService } from '../src/services/ingest.js';
import { CityService } from '../src/services/cities.js';

function rec(over: Partial<RawHackathon> & { title: string; source: RawHackathon['source']; sourceRecordId: string }): RawHackathon {
  return {
    sourceUrl: `https://example.org/${over.source}/${over.sourceRecordId}`,
    registrationUrl: null,
    retrievedAt: '2026-09-26T00:00:00.000Z',
    provenance: [],
    ...over,
  } as RawHackathon;
}

function dated(iso: string, confidence: 'verified' | 'source_confirmed' = 'verified') {
  return {
    iso,
    kind: 'registration_deadline' as const,
    precision: (iso.length === 10 ? 'date_only' : 'instant') as 'date_only' | 'instant',
    sourceTimezone: 'IST',
    offsetMinutes: 330,
    raw: iso,
    label: 'Registration Deadline',
    confidence,
  };
}

const SEEDED = { done: false };

async function seed(): Promise<void> {
  if (SEEDED.done) return;
  SEEDED.done = true;
  const db = testDb();
  const cities = new CityService(db);
  await cities.seedRegistry();
  // Give the seeded cities coordinates so radius search works offline.
  await db.query(`UPDATE cities SET latitude = 13.0827, longitude = 80.2707 WHERE id = 'chennai'`);
  await db.query(`UPDATE cities SET latitude = 12.9716, longitude = 77.5946 WHERE id = 'bengaluru'`);
  await db.query(`UPDATE cities SET latitude = 13.0, longitude = 80.2 WHERE id IN ('ambattur','velachery')`);

  const svc = new IngestService(db, { logger: silentLogger });
  const records: RawHackathon[] = [
    rec({
      title: 'Chennai AI Sprint',
      source: 'unstop',
      sourceRecordId: 'seed-1',
      organizer: 'IIT Madras',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2026-10-01T23:59:00+05:30'),
      teamSizeMin: 1,
      teamSizeMax: 4,
      themes: ['ai'],
      technologies: ['python'],
      prizeAmount: 50000,
      prizeCurrency: 'INR',
      freeOrPaid: 'free',
      eligibility: 'Undergraduate students',
    }),
    rec({
      title: 'Ambattur Code Night',
      source: 'unstop',
      sourceRecordId: 'seed-2',
      organizer: 'Ambattur College',
      city: 'Ambattur',
      state: 'Tamil Nadu',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2026-09-28T23:59:00+05:30'),
      teamSizeMin: 2,
      teamSizeMax: 2,
      themes: ['web development'],
    }),
    rec({
      title: 'Bengaluru Builders',
      source: 'unstop',
      sourceRecordId: 'seed-3',
      organizer: 'IIIT Bangalore',
      city: 'Bangalore',
      state: 'Karnataka',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2026-10-10T23:59:00+05:30'),
      themes: ['ai'],
    }),
    rec({
      title: 'Global Online Jam',
      source: 'devpost',
      sourceRecordId: 'seed-4',
      organizer: 'Devpost',
      onlineOrOffline: 'online',
      registrationDeadline: dated('2026-10-05T23:59:00+05:30'),
      themes: ['open source'],
    }),
    rec({
      title: 'Old Chennai Classic',
      source: 'unstop',
      sourceRecordId: 'seed-5',
      organizer: 'Anna University',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2020-01-01T00:00:00+05:30'),
    }),
    rec({
      title: 'Chennai Mystery Meet',
      source: 'mlh',
      sourceRecordId: 'seed-6',
      organizer: 'Major League Hacking',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
      onlineOrOffline: 'offline',
    }),
  ];
  for (const r of records) await svc.ingest(r);
}

describe('search — Chennai', () => {
  beforeAll(seed);

  it('finds events in the searched city, including suburbs', async () => {
    const res = await new SearchService(testDb()).search({
      city: 'Chennai',
      page: 1,
      limit: 50,
      openOnly: false,
      radiusKm: 50,
      mode: 'all',
      sort: 'relevance',
    });
    expect(res.city.name).toBe('Chennai');
    // Ambattur Code Night (suburb) + Chennai AI Sprint + Chennai Mystery Meet.
    // The 2020 event is excluded as closed.
    expect(res.total).toBe(3);
    const titles = res.results.map((r) => r.title);
    expect(titles).toContain('Chennai AI Sprint');
    expect(titles).toContain('Ambattur Code Night');
    expect(titles).not.toContain('Bengaluru Builders');
    expect(titles).not.toContain('Old Chennai Classic');
  });

  it('resolves Bombay to Mumbai and Bangalore to Bengaluru', async () => {
    const search = new SearchService(testDb());
    const mumbai = await search.search({ city: 'Bombay', page: 1, limit: 5, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance' });
    expect(mumbai.city.name).toBe('Mumbai');
    const bangalore = await search.search({ city: 'Bangalore', page: 1, limit: 5, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance' });
    expect(bangalore.city.name).toBe('Bengaluru');
    expect(bangalore.total).toBe(1);
    expect(bangalore.results[0].title).toBe('Bengaluru Builders');
  });

  it('sorts open registrations by nearest deadline first', async () => {
    const res = await new SearchService(testDb()).search({
      city: 'Chennai',
      page: 1,
      limit: 50,
      openOnly: true,
      radiusKm: 50,
      mode: 'all',
      sort: 'deadline',
    });
    expect(res.results.map((r) => r.title)).toEqual(['Ambattur Code Night', 'Chennai AI Sprint']);
  });

  it('filters by theme, mode and prize', async () => {
    const search = new SearchService(testDb());
    const themed = await search.search({
      city: 'Chennai', page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance', themes: ['ai'],
    });
    expect(themed.results.map((r) => r.title)).toEqual(['Chennai AI Sprint']);

    const online = await search.search({
      page: 1, limit: 50, openOnly: false, radiusKm: null, mode: 'online', sort: 'relevance',
    });
    expect(online.results.map((r) => r.title)).toContain('Global Online Jam');
    expect(online.results.every((r) => r.onlineOrOffline === 'online')).toBe(true);

    const prize = await search.search({
      city: 'Chennai', page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'all', sort: 'prize',
    });
    expect(prize.results[0].title).toBe('Chennai AI Sprint');
  });

  it('filters by team size', async () => {
    const res = await new SearchService(testDb()).search({
      city: 'Chennai', page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance', teamSizeMin: 3, teamSizeMax: 4,
    });
    const titles = res.results.map((r) => r.title);
    // A 3-4 person team fits Chennai AI Sprint (1-4). Ambattur Code Night is
    // strictly 2-a-side and is excluded. Events that do not publish a team size
    // stay visible rather than being hidden on an unknown.
    expect(titles).toContain('Chennai AI Sprint');
    expect(titles).toContain('Chennai Mystery Meet');
    expect(titles).not.toContain('Ambattur Code Night');
  });

  it('returns facets and freshness metadata', async () => {
    const res = await new SearchService(testDb()).search({
      city: 'Chennai', page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance',
    });
    expect(res.facets.themes.length).toBeGreaterThan(0);
    expect(res.facets.withDeadline).toBeGreaterThanOrEqual(2);
    expect(res.dataFreshness.sourcesWithData.length).toBeGreaterThan(0);
    expect(res.generatedAt).toBeTruthy();
  });

  it('reports an honest empty state for a city with nothing listed', async () => {
    const res = await new SearchService(testDb()).search({
      city: 'Atlantis', page: 1, limit: 10, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance',
    });
    expect(res.total).toBe(0);
    expect(res.results).toEqual([]);
    expect(res.city.match).toBe('unknown');
  });

  it('excludes deadline-passed rows even when the stored status is stale', async () => {    const db = testDb();
    // Simulate a row ingested while open whose deadline has since passed: the
    // cached column still says "open".
    await db.query(
      `UPDATE hackathons SET registration_status = 'open'
       WHERE title = 'Old Chennai Classic'`,
    );
    const search = new SearchService(db);
    const def = await search.search({
      city: 'Chennai', page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance',
    });
    expect(def.results.map((r) => r.title)).not.toContain('Old Chennai Classic');
    const open = await search.search({
      city: 'Chennai', page: 1, limit: 50, openOnly: true, radiusKm: 50, mode: 'all', sort: 'relevance',
    });
    expect(open.results.map((r) => r.title)).not.toContain('Old Chennai Classic');
    // And a genuinely open row still passes both filters.
    expect(def.results.map((r) => r.title)).toContain('Chennai AI Sprint');
    expect(open.results.map((r) => r.title)).toContain('Chennai AI Sprint');
  });

  it('adds a separate online section to city searches', async () => {
    const search = new SearchService(testDb());
    const res = await search.search({
      city: 'Chennai', page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance',
    });
    expect(res.online).not.toBeNull();
    expect(res.online!.results.map((r) => r.title)).toContain('Global Online Jam');
    expect(res.online!.results.every((r) => r.onlineOrOffline === 'online')).toBe(true);
    // Physical results stay purely physical.
    expect(res.results.every((r) => r.onlineOrOffline !== 'online')).toBe(true);
  });

  it('suppresses the online section for offline-only searches', async () => {
    const res = await new SearchService(testDb()).search({
      city: 'Chennai', page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'offline', sort: 'relevance',
    });
    expect(res.online).toBeNull();
  });

  it('treats city + online mode as a global online search', async () => {
    const res = await new SearchService(testDb()).search({
      city: 'Chennai', page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'online', sort: 'relevance',
    });
    expect(res.results.map((r) => r.title)).toContain('Global Online Jam');
    expect(res.online).toBeNull();
  });
});
