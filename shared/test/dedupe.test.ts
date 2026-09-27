import { describe, expect, it } from 'vitest';
import { groupDuplicates, isDuplicate, reconcile, slugify, titleSimilarity } from '../src/dedupe.js';
import { SOURCE_TRUST } from '../src/types.js';
import type { RawHackathon } from '../src/types.js';

function record(over: Partial<RawHackathon> & { title: string; source: RawHackathon['source']; sourceRecordId: string }): RawHackathon {
  return {
    sourceUrl: `https://example.org/${over.sourceRecordId}`,
    registrationUrl: null,
    retrievedAt: '2026-09-26T00:00:00.000Z',
    provenance: [],
    ...over,
  } as RawHackathon;
}

describe('titleSimilarity', () => {
  it('rates reordered and decorated titles as highly similar', () => {
    expect(titleSimilarity('Hackathon 2026', 'XYZ Hackathon 2026')).toBeGreaterThan(0.7);
    expect(titleSimilarity('Hack-A-Thon 3.0', 'Hackathon 3.0')).toBeGreaterThan(0.8);
  });

  it('rates unrelated titles as dissimilar', () => {
    expect(titleSimilarity('Smart India Hackathon', 'Hack-the-North')).toBeLessThan(0.5);
  });
});

describe('isDuplicate', () => {
  it('treats an identical vanity-subdomain registration URL as the same event', () => {
    const a = record({ title: 'Anything', source: 'unstop', sourceRecordId: '1', registrationUrl: 'https://foo.devpost.com/apply' });
    const b = record({ title: 'Something Else Entirely', source: 'devpost', sourceRecordId: '2', registrationUrl: 'https://www.foo.devpost.com/apply' });
    expect(isDuplicate(a, b).duplicate).toBe(true);
  });

  it('does NOT treat two Unstop short links as the same event', () => {
    // Regression: unstop.com/o/<code> shares its first path segment across every
    // listing, so collapsing the path to one segment merged unrelated events.
    const a = record({ title: 'Reforged 26', source: 'unstop', sourceRecordId: '1', registrationUrl: 'https://unstop.com/o/aBcD1234', city: 'Pune', country: 'India' });
    const b = record({ title: 'Colossal-A-Pitch', source: 'unstop', sourceRecordId: '2', registrationUrl: 'https://unstop.com/o/ZzYy9876', city: 'Pune', country: 'India' });
    expect(isDuplicate(a, b).duplicate).toBe(false);
  });

  it('still merges two sources pointing at the same Unstop short link', () => {
    const a = record({ title: 'Reforged 26', source: 'unstop', sourceRecordId: '1', registrationUrl: 'https://unstop.com/o/aBcD1234' });
    const b = record({ title: 'Reforged 2026', source: 'organizer_website', sourceRecordId: '2', registrationUrl: 'https://unstop.com/o/aBcD1234' });
    expect(isDuplicate(a, b).duplicate).toBe(true);
  });

  it('never merges two distinct listings from the same source', () => {
    // Real case: a college listing both "Robo Race" and "Robo Soccer" on Unstop.
    const a = record({ title: 'Robo Race', source: 'unstop', sourceRecordId: '1', organizer: 'Alpha College', city: 'Pune', country: 'India' });
    const b = record({ title: 'Robo Soccer', source: 'unstop', sourceRecordId: '2', organizer: 'Alpha College', city: 'Pune', country: 'India' });
    expect(isDuplicate(a, b).duplicate).toBe(false);
  });

  it('does not merge different events that merely share a country and are both online', () => {
    const a = record({ title: 'AETHOS Day Zero', source: 'unstop', sourceRecordId: '1', country: 'India', onlineOrOffline: 'online' });
    const b = record({ title: 'ZeroBreach 2.0 CTF 2026', source: 'unstop', sourceRecordId: '2', country: 'India', onlineOrOffline: 'online' });
    expect(isDuplicate(a, b).duplicate).toBe(false);
  });

  it('merges the same event listed under different title decorations', () => {
    const a = record({
      title: 'Hackathon 2026',
      source: 'unstop',
      sourceRecordId: '1',
      organizer: 'XYZ Institute of Technology',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
    });
    const b = record({
      title: 'XYZ Hackathon 2026',
      source: 'organizer_website',
      sourceRecordId: '2',
      organizer: 'XYZ Institute of Technology',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
    });
    const v = isDuplicate(a, b);
    expect(v.duplicate).toBe(true);
    expect(v.reasons.length).toBeGreaterThan(1);
  });

  it('does NOT merge a generic title across different cities', () => {
    const a = record({ title: 'Hackathon 2026', source: 'unstop', sourceRecordId: '1', organizer: 'A University', city: 'Chennai', state: 'Tamil Nadu', country: 'India' });
    const b = record({ title: 'Hackathon 2026', source: 'devpost', sourceRecordId: '2', organizer: 'B University', city: 'Pune', state: 'Maharashtra', country: 'India' });
    expect(isDuplicate(a, b).duplicate).toBe(false);
  });

  it('does not merge clearly different events in the same city', () => {
    const a = record({ title: 'HackVerse Chennai', source: 'unstop', sourceRecordId: '1', organizer: 'Alpha College', city: 'Chennai', country: 'India' });
    const b = record({ title: 'Quantum Build Fest', source: 'unstop', sourceRecordId: '2', organizer: 'Beta College', city: 'Chennai', country: 'India' });
    expect(isDuplicate(a, b).duplicate).toBe(false);
  });

  it('uses event dates to confirm a match when titles are close', () => {
    const a = record({
      title: 'Code Sprint Bengaluru',
      source: 'unstop',
      sourceRecordId: '1',
      organizer: 'Some Institute',
      city: 'Bengaluru',
      country: 'India',
      hackathonStart: { iso: '2026-10-10', kind: 'hackathon_start', precision: 'date_only', sourceTimezone: null, offsetMinutes: null, raw: '10 Oct 2026', label: null, confidence: 'source_confirmed' },
    });
    const b = record({
      title: 'Code Sprint Bangalore 2026',
      source: 'mlh',
      sourceRecordId: '2',
      organizer: 'Some Institute',
      city: 'Bengaluru',
      country: 'India',
      hackathonStart: { iso: '2026-10-11', kind: 'hackathon_start', precision: 'date_only', sourceTimezone: null, offsetMinutes: null, raw: 'Oct 11 2026', label: null, confidence: 'source_confirmed' },
    });
    expect(isDuplicate(a, b).duplicate).toBe(true);
  });
});

describe('groupDuplicates', () => {
  it('groups three listings of one event and leaves others alone', () => {
    const records: RawHackathon[] = [
      record({ title: 'Nova Hack 2026', source: 'unstop', sourceRecordId: '1', organizer: 'Nova College', city: 'Hyderabad', country: 'India' }),
      record({ title: 'Nova Hack 2026', source: 'mlh', sourceRecordId: '2', organizer: 'Nova College', city: 'Hyderabad', country: 'India' }),
      record({ title: 'Nova Hack 2026 - Nova College', source: 'organizer_website', sourceRecordId: '3', organizer: 'Nova College', city: 'Hyderabad', country: 'India' }),
      record({ title: 'Orbit Jam', source: 'unstop', sourceRecordId: '4', organizer: 'Orbit University', city: 'Pune', country: 'India' }),
    ];
    const groups = groupDuplicates(records);
    expect(groups.length).toBe(2);
    const big = groups.find((g) => g.length === 3);
    expect(big).toBeDefined();
    expect(new Set(big!.map((r) => r.source)).size).toBe(3);
  });
});

describe('reconcile — conflict resolution', () => {
  it('takes the highest-trust source when authorities agree', () => {
    const r = reconcile(
      [
        { value: '2026-09-29', source: 'unstop', sourceUrl: 'https://unstop.com/a' },
        { value: '2026-09-29', source: 'organizer_website', sourceUrl: 'https://x.edu/' },
      ],
      SOURCE_TRUST,
    );
    expect(r.conflict).toBe(false);
    expect(r.value).toBe('2026-09-29');
  });

  it('prefers the official organizer page over a listing when they disagree', () => {
    const r = reconcile(
      [
        { value: '2026-09-30', source: 'unstop', sourceUrl: 'https://unstop.com/a' },
        { value: '2026-09-28', source: 'organizer_website', sourceUrl: 'https://x.edu/' },
      ],
      SOURCE_TRUST,
    );
    expect(r.conflict).toBe(false);
    expect(r.value).toBe('2026-09-28');
    expect(r.chosenSource).toBe('organizer_website');
  });

  it('flags a conflict when equally-trusted sources disagree', () => {
    const r = reconcile(
      [
        { value: '2026-09-28', source: 'unstop', sourceUrl: 'https://unstop.com/a' },
        { value: '2026-09-30', source: 'devpost', sourceUrl: 'https://devpost.com/b' },
      ],
      SOURCE_TRUST,
    );
    expect(r.conflict).toBe(true);
    expect(r.chosenSource).toBeNull();
    expect(r.reports.length).toBe(2);
  });

  it('returns null when nobody reported a value', () => {
    const r = reconcile([{ value: null, source: 'unstop' as const, sourceUrl: 'x' }], SOURCE_TRUST);
    expect(r.value).toBeNull();
    expect(r.conflict).toBe(false);
  });
});

describe('slugify', () => {
  it('produces URL-safe slugs', () => {
    expect(slugify('Hack-A-Thon 3.0!')).toBe('hack-a-thon-3-0');
    expect(slugify('***')).toBe('hackathon');
  });
});
