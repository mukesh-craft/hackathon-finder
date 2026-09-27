/**
 * Pipeline tests: ingest, merge, conflict, idempotency and status derivation.
 * Cities are never geocoded here (tests stay offline by design).
 */
import { describe, expect, it } from 'vitest';
import type { RawHackathon } from '@hf/shared';
import { testDb, silentLogger } from './setup.js';
import { IngestService } from '../src/services/ingest.js';
import { CityService } from '../src/services/cities.js';

function base(over: Partial<RawHackathon> & { title: string; source: RawHackathon['source']; sourceRecordId: string }): RawHackathon {
  return {
    sourceUrl: `https://example.org/${over.source}/${over.sourceRecordId}`,
    registrationUrl: null,
    retrievedAt: '2026-09-26T00:00:00.000Z',
    provenance: [],
    ...over,
  } as RawHackathon;
}

function dated(iso: string, confidence: RawHackathon['registrationDeadline'] extends infer _ ? 'verified' : never) {
  return {
    iso,
    kind: 'registration_deadline' as const,
    precision: iso.length === 10 ? ('date_only' as const) : ('instant' as const),
    sourceTimezone: 'IST',
    offsetMinutes: 330,
    raw: iso,
    label: 'Registration Deadline',
    confidence,
  };
}

describe('ingest — merge across sources', () => {
  it('stores one row for the same event from two sources and keeps both links', async () => {
    const db = testDb();
    await new CityService(db).seedRegistry();
    const svc = new IngestService(db, { logger: silentLogger });

    const unstop = base({
      title: 'Nova Hack 2026',
      source: 'unstop',
      sourceRecordId: 'u-1',
      organizer: 'Nova College',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2026-10-05T23:59:00+05:30', 'verified'),
    });
    const organizer = base({
      title: 'Nova Hack 2026 - Nova College',
      source: 'organizer_website',
      sourceRecordId: 'https://nova.edu/hack',
      sourceUrl: 'https://nova.edu/hack',
      organizer: 'Nova College',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
      onlineOrOffline: 'offline',
      registrationDeadline: dated('2026-10-05T23:59:00+05:30', 'source_confirmed'),
    });

    await svc.ingest(unstop);
    const stats = await svc.ingest(organizer);
    expect(stats.merged).toBe(1);

    const rows = await db.query<{ id: string; title: string; registration_deadline: string; data_quality: string; deadline_conflict: boolean }>(
      'SELECT id, title, registration_deadline, data_quality, deadline_conflict FROM hackathons',
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].registration_deadline).toBe('2026-10-05T23:59:00+05:30');
    expect(rows.rows[0].data_quality).toBe('verified');
    expect(rows.rows[0].deadline_conflict).toBe(false);

    const links = await db.query<{ source: string }>('SELECT source FROM hackathon_sources ORDER BY source');
    expect(links.rows.map((r) => r.source).sort()).toEqual(['organizer_website', 'unstop']);
  });

  it('flags a conflict when equally trusted sources disagree on the deadline', async () => {
    const db = testDb();
    await new CityService(db).seedRegistry();
    const svc = new IngestService(db, { logger: silentLogger });

    await svc.ingest(
      base({
        title: 'Orbit Jam',
        source: 'unstop',
        sourceRecordId: 'conflict-a',
        organizer: 'Orbit Labs',
        city: 'Pune',
        state: 'Maharashtra',
        country: 'India',
        registrationDeadline: dated('2026-09-28', 'source_confirmed'),
      }),
    );
    await svc.ingest(
      base({
        title: 'Orbit Jam 2026',
        source: 'devpost',
        sourceRecordId: 'conflict-b',
        organizer: 'Orbit Labs',
        city: 'Pune',
        state: 'Maharashtra',
        country: 'India',
        registrationDeadline: dated('2026-09-30', 'source_confirmed'),
      }),
    );

    const rows = await db.query<{ deadline_conflict: boolean; deadline_conflict_detail: { values: unknown[] } | null; data_quality: string }>(
      'SELECT deadline_conflict, deadline_conflict_detail, data_quality FROM hackathons WHERE title = $1',
      ['Orbit Jam'],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].deadline_conflict).toBe(true);
    expect(rows.rows[0].deadline_conflict_detail?.values.length).toBe(2);
    expect(rows.rows[0].data_quality).toBe('partially_verified');
  });

  it('never merges two distinct listings from the same source', async () => {
    const db = testDb();
    const svc = new IngestService(db, { logger: silentLogger });
    await svc.ingest(base({ title: 'Robo Race', source: 'unstop', sourceRecordId: 'same-a', organizer: 'Alpha College', city: 'Pune', country: 'India' }));
    await svc.ingest(base({ title: 'Robo Soccer', source: 'unstop', sourceRecordId: 'same-b', organizer: 'Alpha College', city: 'Pune', country: 'India' }));
    const rows = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hackathons WHERE title LIKE 'Robo%'");
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it('derives open/closed/unknown status from the stored deadline', async () => {
    const db = testDb();
    const svc = new IngestService(db, { logger: silentLogger });
    await svc.ingest(
      base({ title: 'Future Fest', source: 'unstop', sourceRecordId: 'status-open', registrationDeadline: dated('2099-01-01T00:00:00+05:30', 'verified') }),
    );
    await svc.ingest(
      base({ title: 'Past Fest', source: 'unstop', sourceRecordId: 'status-closed', registrationDeadline: dated('2020-01-01T00:00:00+05:30', 'verified') }),
    );
    await svc.ingest(base({ title: 'Mystery Fest', source: 'mlh', sourceRecordId: 'status-unknown' }));

    const rows = await db.query<{ title: string; registration_status: string }>(
      "SELECT title, registration_status FROM hackathons WHERE title LIKE '% Fest' ORDER BY title",
    );
    const map = new Map(rows.rows.map((r) => [r.title, r.registration_status]));
    expect(map.get('Future Fest')).toBe('open');
    expect(map.get('Past Fest')).toBe('closed');
    expect(map.get('Mystery Fest')).toBe('unknown');
  });

  it('marks MLH-style records ("no deadline published") as unknown quality', async () => {
    const db = testDb();
    const svc = new IngestService(db, { logger: silentLogger });
    await svc.ingest(
      base({
        title: 'Campus Classic',
        source: 'mlh',
        sourceRecordId: 'quality-mlh',
        organizer: 'Major League Hacking',
        city: 'Austin',
        country: 'United States',
        onlineOrOffline: 'offline',
      }),
    );
    const rows = await db.query<{ data_quality: string; registration_status: string; source_deadline_text: string | null }>(
      'SELECT data_quality, registration_status, source_deadline_text FROM hackathons WHERE title = $1',
      ['Campus Classic'],
    );
    expect(rows.rows[0].data_quality).toBe('unknown');
    expect(rows.rows[0].registration_status).toBe('unknown');
    expect(rows.rows[0].source_deadline_text).toBeNull();
  });

  it('is idempotent: re-ingesting the same source record updates, never duplicates', async () => {
    const db = testDb();
    const svc = new IngestService(db, { logger: silentLogger });
    const rec = base({ title: 'Repeat Run', source: 'unstop', sourceRecordId: 'repeat-1', city: 'Kolkata', country: 'India' });
    await svc.ingest(rec);
    await svc.ingest({ ...rec, description: 'updated description' });
    const rows = await db.query<{ n: string; description: string | null }>(
      "SELECT count(*)::text AS n, max(description) AS description FROM hackathons WHERE title = 'Repeat Run'",
    );
    expect(Number(rows.rows[0].n)).toBe(1);
    expect(rows.rows[0].description).toBe('updated description');
  });

  it('carries adapter-found field conflicts through to the stored row', async () => {
    const db = testDb();
    const svc = new IngestService(db, { logger: silentLogger });
    await svc.ingest(
      base({
        title: 'Clash Fest',
        source: 'unstop',
        sourceRecordId: 'clash-1',
        city: 'Chennai',
        country: 'India',
        hackathonEnd: dated('2026-09-27T23:59:00+05:30', 'source_confirmed'),
        fieldConflicts: [
          {
            field: 'hackathon_end',
            values: [
              { value: '2026-09-27T23:59:00+05:30', source: 'unstop', sourceUrl: 'https://unstop.com/x', trust: 4 },
              { value: '2026-10-08', source: 'unstop', sourceUrl: 'https://unstop.com/x', trust: 4 },
            ],
            resolvedFrom: 'unstop',
            resolutionNote: 'structured vs text',
          },
        ],
      }),
    );
    const rows = await db.query<{ field_conflicts: Array<{ field: string }> | null }>(
      'SELECT field_conflicts FROM hackathons WHERE title = $1',
      ['Clash Fest'],
    );
    expect(rows.rows[0].field_conflicts?.map((c) => c.field)).toContain('hackathon_end');
    // Re-ingest must not duplicate the conflict entry.
    await svc.ingest(
      base({
        title: 'Clash Fest',
        source: 'unstop',
        sourceRecordId: 'clash-1',
        city: 'Chennai',
        country: 'India',
        fieldConflicts: [
          {
            field: 'hackathon_end',
            values: [
              { value: '2026-09-27T23:59:00+05:30', source: 'unstop', sourceUrl: 'https://unstop.com/x', trust: 4 },
              { value: '2026-10-08', source: 'unstop', sourceUrl: 'https://unstop.com/x', trust: 4 },
            ],
            resolvedFrom: 'unstop',
            resolutionNote: 'structured vs text',
          },
        ],
      }),
    );
    const again = await db.query<{ field_conflicts: Array<{ field: string }> | null }>(
      'SELECT field_conflicts FROM hackathons WHERE title = $1',
      ['Clash Fest'],
    );
    expect(again.rows[0].field_conflicts?.filter((c) => c.field === 'hackathon_end').length).toBe(1);
  });
});
