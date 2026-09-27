/**
 * Source-adapter normalization tests, run against recorded real payloads.
 *
 * The fixtures are unedited responses captured from the live sources. Every
 * assertion below documents a fact the product depends on: the registration
 * deadline must come from the registration field and must not be the event end.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeUnstopItem, prizeFromText, differsByMoreThanADay } from '../src/adapters/unstop.js';
import { normalizeDevpostHackathon } from '../src/adapters/devpost.js';
import { extractDeadlinesFromText } from '@hf/shared';
import { parseMlhSeasonPage, normalizeMlhEvent, type MlhEvent } from '../src/adapters/mlh.js';
import { parseHackerEarthList, normalizeHackerEarthListing } from '../src/adapters/hackerearth.js';
import { chooseDeadlines } from '../src/adapters/organizer-website.js';
import * as cheerio from 'cheerio';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

describe('unstop adapter — the registration/event-end distinction', () => {
  const payload = JSON.parse(read('unstop-list.json')) as {
    data: { data: Array<Parameters<typeof normalizeUnstopItem>[0]> };
  };
  const byId = new Map(payload.data.data.map((r) => [r.id, normalizeUnstopItem(r)]));

  it('parses every recorded listing without loss', () => {
    expect(payload.data.data.length).toBeGreaterThanOrEqual(3);
    for (const rec of byId.values()) {
      expect(rec.title).toBeTruthy();
      expect(rec.sourceUrl).toMatch(/^https:\/\/unstop\.com\//);
      expect(rec.registrationUrl).toBeTruthy();
      expect(rec.provenance.length).toBeGreaterThan(3);
    }
  });

  it('uses end_regn_dt as the registration deadline and end_date as the event end', () => {
    const rec = byId.get(1759668)!; // HackForge 2026: regn ends Oct 8, event ends Oct 18
    expect(rec.title).toBe('HackForge 2026');
    expect(rec.registrationDeadline?.iso).toBe('2026-10-08T23:59:00+05:30');
    expect(rec.hackathonEnd?.iso).toBe('2026-10-18T20:00:00+05:30');
    expect(rec.registrationDeadline?.iso).not.toBe(rec.hackathonEnd?.iso);
  });

  it('marks the registration deadline as a structured, verified fact', () => {
    for (const rec of byId.values()) {
      if (rec.registrationDeadline) {
        expect(rec.registrationDeadline.confidence).toBe('verified');
        expect(rec.registrationDeadline.label).toContain('end_regn_dt');
      }
    }
  });

  it('keeps organizer, city, eligibility, skills, prize and fee', () => {
    const rec = byId.get(1737808)!; // HackCelestial 3.0
    expect(rec.organizer).toContain('Pillai');
    expect(rec.city).toBe('Navi Mumbai');
    expect(rec.state).toBe('Maharashtra');
    expect(rec.onlineOrOffline).toBe('offline');
    expect(rec.prizeAmount).toBe(150000);
    expect(rec.prizeCurrency).toBe('INR');
    expect(rec.teamSizeMin).toBe(1);
    expect(rec.teamSizeMax).toBe(5);
    expect(rec.eligibility).toContain('Engineering Students');
    expect(rec.technologies.length).toBeGreaterThan(0);
  });

  it('preserves the verbatim deadline wording for audit', () => {
    const rec = byId.get(1737808)!;
    expect(rec.sourceDeadlineText).toBe('2026-09-27T23:59:00+05:30');
  });

  it('does not invent an event start date Unstop does not publish', () => {
    for (const rec of byId.values()) {
      // Structured start stays null; text-derived starts are ExtractedDates
      // with real ISOs (confidence follows precision, as everywhere else).
      if (rec.hackathonStart) {
        expect(rec.hackathonStart.iso).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(rec.hackathonStart.confidence).not.toBe('verified');
      }
    }
  });

  it('reads a prize stated only in the description text', () => {
    const item = {
      id: 999001,
      title: 'Text Prize Fest',
      details: '<p>Welcome.</p><p>Prizes &amp; Opportunities ₹25,000 Cash Prize Pool. Certificates for all.</p>',
      organisation: { name: 'Test College' },
      region: 'offline',
      address_with_country_logo: { city: 'Chennai', state: 'Tamil Nadu', country: { name: 'India' } },
    };
    const rec = normalizeUnstopItem(item as never);
    expect(rec.prizeAmount).toBe(25000);
    expect(rec.prizeCurrency).toBe('INR');
    expect(rec.provenance.find((x) => x.field === 'prize_amount')?.confidence).toBe('partially_verified');
  });

  it('never turns a fee or stray number into a prize', () => {
    expect(prizeFromText('Entry fee ₹500. Contact us.')).toBeNull();
    expect(prizeFromText('The event is on 29 Sep 2026.')).toBeNull();
    expect(prizeFromText(null)).toBeNull();
  });

  it('reads lakh-scale prizes with units', () => {
    expect(prizeFromText('Total prizes worth ₹2 lakh for winners')?.amount).toBe(200000);
    expect(prizeFromText('Win $5,000 cash prize today')?.amount).toBe(5000);
  });

  it('flags structured-vs-description event-end disagreements instead of swapping', () => {
    const item = {
      id: 999002,
      title: 'Date Clash Fest',
      details: '<p>Event Details. Date: 7–8 October 2026. Venue: Hall.</p>',
      organisation: { name: 'Test College' },
      region: 'offline',
      end_date: '2026-09-27T23:59:00+05:30',
      address_with_country_logo: { city: 'Chennai', state: 'Tamil Nadu', country: { name: 'India' } },
    };
    const rec = normalizeUnstopItem(item as never);
    // Structured stays primary…
    expect(rec.hackathonEnd?.iso).toBe('2026-09-27T23:59:00+05:30');
    // …start is filled from text…
    expect(rec.hackathonStart?.iso).toBe('2026-10-07');
    // …and the disagreement is preserved, not hidden.
    const conflict = (rec.fieldConflicts ?? []).find((c) => c.field === 'hackathon_end');
    expect(conflict).toBeDefined();
    expect(conflict!.values.map((v) => v.value).sort()).toEqual(['2026-09-27T23:59:00+05:30', '2026-10-08']);
  });

  it('compares instants with a one-day tolerance', () => {
    expect(differsByMoreThanADay('2026-09-27T23:59:00+05:30', '2026-09-28T12:00:00+05:30')).toBe(false);
    expect(differsByMoreThanADay('2026-09-27T23:59:00+05:30', '2026-10-08')).toBe(true);
    expect(differsByMoreThanADay(null, '2026-10-08')).toBe(false);
  });
});

describe('devpost adapter — one deadline, labelled honestly', () => {
  const payload = JSON.parse(read('devpost-list.json')) as {
    hackathons: Array<Parameters<typeof normalizeDevpostHackathon>[0]>;
  };

  it('normalises the recorded listings', () => {
    expect(payload.hackathons.length).toBeGreaterThanOrEqual(3);
    for (const item of payload.hackathons) {
      const rec = normalizeDevpostHackathon(item, { inferRegistrationDeadline: true });
      expect(rec.title).toBeTruthy();
      expect(rec.sourceUrl).toMatch(/^https:\/\//);
      expect(rec.onlineOrOffline).toBe('online');
    }
  });

  it('reads the submission window and mirrors it as an inferred registration deadline', () => {
    const revenueCat = payload.hackathons.find((h) => h.title.includes('RevenueCat'))!;
    const rec = normalizeDevpostHackathon(revenueCat, { inferRegistrationDeadline: true });
    expect(revenueCat.submission_period_dates).toBe('Jul 31 - Oct 01, 2026');
    // The window end, date-only: no time is invented.
    expect(rec.submissionDeadline?.iso).toBe('2026-10-01');
    expect(rec.registrationDeadline?.iso).toBe('2026-10-01');
    expect(rec.registrationDeadline?.confidence).toBe('inferred');
  });

  it('leaves registration_deadline null when inference is disabled', () => {
    const rec = normalizeDevpostHackathon(payload.hackathons[0], { inferRegistrationDeadline: false });
    expect(rec.submissionDeadline?.iso).toBeTruthy();
    expect(rec.registrationDeadline).toBeNull();
  });

  it('reads the exact deadline from a recorded event page', () => {
    const html = read('devpost-detail.html');
    const $ = cheerio.load(html);
    const candidates: string[] = [];
    $('*').each((_, el) => {
      const node = $(el);
      if (node.children().length > 0) return;
      const text = node.text().replace(/\s+/g, ' ').trim();
      if (/deadline/i.test(text) && extractDeadlinesFromText(text).length > 0) candidates.push(text);
    });
    const withDate = candidates.find((t) => extractDeadlinesFromText(t).some((d) => d.iso));
    expect(withDate).toBeTruthy();
    const found = extractDeadlinesFromText(withDate!, { assumeYear: 2026 });
    // "Sep 30, 2026 @ 11:45pm PDT" is a genuine instant, not a bare date.
    const deadline = found.find((d) => d.iso);
    expect(deadline?.iso).toBe('2026-09-30T23:45:00-07:00');
    expect(deadline?.precision).toBe('instant');
  });

  it('parses the HTML-rendered prize amount', () => {
    const rec = normalizeDevpostHackathon(payload.hackathons.find((h) => h.title.includes('RevenueCat'))!, {
      inferRegistrationDeadline: false,
    });
    expect(rec.prizeAmount).toBe(740000);
    expect(rec.prizeCurrency).toBe('USD');
  });
});

describe('mlh adapter — no registration deadline is published', () => {
  it('parses the recorded season payload', () => {
    const html = `<script data-page="app" type="application/json">${read('mlh-season.json')}</script>`;
    const events = parseMlhSeasonPage(html);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('normalises events with start/end and a venue but no deadline', () => {
    const fixture = JSON.parse(read('mlh-season.json')) as { props: { upcomingEvents: MlhEvent[]; pastEvents: MlhEvent[] } };
    const event = [...fixture.props.upcomingEvents, ...fixture.props.pastEvents][0];
    const rec = normalizeMlhEvent(event, '2026');
    expect(rec.title).toBe(event.name);
    expect(rec.hackathonStart?.iso).toBeTruthy();
    expect(rec.hackathonEnd?.iso).toBeTruthy();
    expect(rec.registrationDeadline).toBeNull();
    expect(rec.sourceDeadlineText).toBeNull();
  });

  it('returns an empty list for a malformed payload instead of throwing', () => {
    expect(parseMlhSeasonPage('<html><body>no scripts here</body></html>')).toEqual([]);
    expect(parseMlhSeasonPage('<script type="application/json">{not json</script>')).toEqual([]);
  });
});

describe('hackerearth adapter — parses whatever is server-rendered', () => {
  it('returns no listings for the current client-rendered page', () => {
    const listings = parseHackerEarthList('<html><body><div class="filters">Status: Live</div></body></html>');
    expect(listings).toEqual([]);
  });

  it('normalises a server-rendered style card', () => {
    const html = `<div class="challenge-listing">
      <a href="/challenges/hack-chennai/">Hack Chennai 2026</a>
      <div class="challenge-name">Hack Chennai 2026</div>
      <span>Registration Deadline: 30 Sep 2026</span>
      <span>Prize: ₹50,000</span>
    </div>`;
    const listings = parseHackerEarthList(html);
    expect(listings.length).toBe(1);
    const rec = normalizeHackerEarthListing(listings[0]);
    expect(rec.title).toBe('Hack Chennai 2026');
    expect(rec.registrationDeadline?.iso).toBe('2026-09-30');
    expect(rec.registrationDeadline?.kind).toBe('registration_deadline');
    expect(rec.prizeAmount).toBe(50000);
    expect(rec.prizeCurrency).toBe('INR');
  });
});

describe('organizer adapter — deadline choice', () => {
  it('picks the registration deadline out of a realistic timeline', () => {
    const text = [
      'Welcome to the national hackathon.',
      'Registration Deadline: 29 Sep 2026, 11:59 PM IST',
      'Idea submission: 1 Oct 2026',
      'Hackathon ends on 24 Oct 2026',
      'Results will be announced on 30 Oct 2026.',
    ].join('\n');
    const found = extractDeadlinesFromText(text, { defaultTimezone: 'Asia/Kolkata' });
    const chosen = chooseDeadlines(found);
    expect(chosen.registrationDeadline?.iso).toBe('2026-09-29T23:59:00+05:30');
  });
});
