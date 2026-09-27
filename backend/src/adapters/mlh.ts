/**
 * MLH adapter — https://mlh.io (Major League Hacking)
 *
 * Data source: the public season event page. The site is an Inertia app that
 * embeds its whole event list as JSON in a `data-page` attribute, so we read
 * structured data rather than scraping markup. `robots.txt` disallows only
 * account/tool/admin paths; `/seasons/.../events` is allowed.
 *
 * Deadline handling: MLH publishes event start and end, but **no registration
 * deadline**. This adapter therefore leaves `registrationDeadline` null. Those
 * events surface with "Registration deadline: Not specified" and are excluded
 * from registration-open filtering, which is the correct outcome rather than a
 * manufactured date.
 */
import * as cheerio from 'cheerio';
import type { ExtractedDate, RawHackathon, Confidence } from '@hf/shared';
import { parseDateExpression } from '@hf/shared';
import { safeFetch } from '../http/safe-fetch.js';
import { config } from '../config.js';
import type { SourceAdapter, AdapterContext, AdapterRunResult } from './types.js';

const HOSTS = ['mlh.io', 'mlh.com'];

export interface MlhEvent {
  id: string;
  slug: string;
  name: string;
  status?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  dateRange?: string | null;
  url?: string | null;
  location?: string | null;
  formatType?: string | null;
  websiteUrl?: string | null;
  region?: string | null;
  customFields?: { underserved_types?: string[]; hackathon_focus?: string[] } | null;
  venueAddress?: { city?: string | null; state?: string | null; country?: string | null } | null;
}

const DEFAULT_SEASONS = ['2027', '2026', '2025'];

function instant(value: string | null | undefined, label: string | null): ExtractedDate | null {
  if (!value) return null;
  const parsed = parseDateExpression(value);
  if (!parsed?.iso) return null;
  return { ...parsed, kind: 'unknown', label, raw: value, confidence: 'source_confirmed' };
}

export function normalizeMlhEvent(event: MlhEvent, season: string): RawHackathon {
  const path = event.url ?? `/events/${event.slug}`;
  const sourceUrl = path.startsWith('http') ? path : `https://mlh.io${path}`;
  const retrievedAt = new Date().toISOString();
  const digital = (event.formatType ?? '').toLowerCase() === 'digital';

  const locationParts = (event.location ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const city = event.venueAddress?.city?.trim() || (digital ? null : locationParts[0] || null);
  const region = event.venueAddress?.state?.trim() || (digital ? null : locationParts[1] || null);
  const countryName = event.venueAddress?.country
    ? (event.venueAddress.country === 'IN' ? 'India' : event.venueAddress.country)
    : null;

  const focus = [
    ...(event.customFields?.hackathon_focus ?? []),
    ...(event.customFields?.underserved_types ?? []),
  ].filter(Boolean);

  const provenance: RawHackathon['provenance'] = [];
  const prov = (field: string, value: string | null | undefined, confidence: Confidence) => {
    if (!value) return;
    provenance.push({ field, value: String(value), source: 'mlh', sourceUrl, retrievedAt, confidence });
  };

  prov('title', event.name, 'verified');
  prov('organizer', 'Major League Hacking', 'source_confirmed');
  prov('location_text', event.location, 'source_confirmed');
  prov('city', city, 'source_confirmed');
  prov('state', region, 'source_confirmed');
  prov('country', countryName, 'source_confirmed');
  prov('online_or_offline', digital ? 'online' : 'offline', 'source_confirmed');
  prov('hackathon_start', event.startsAt, 'source_confirmed');
  prov('hackathon_end', event.endsAt, 'source_confirmed');
  prov('themes', focus.join(', '), 'source_confirmed');
  prov('season', season, 'verified');

  return {
    source: 'mlh',
    sourceRecordId: event.id,
    title: (event.name ?? '').trim(),
    description: null,
    organizer: 'Major League Hacking',
    sourceUrl,
    registrationUrl: event.websiteUrl ?? sourceUrl,
    locationText: event.location ?? null,
    city,
    state: region,
    country: countryName,
    venue: null,
    eventType: 'hackathon',
    onlineOrOffline: digital ? 'online' : 'offline',
    registrationOpensAt: null,
    // MLH publishes no registration deadline. Left null on purpose.
    registrationDeadline: null,
    hackathonStart: instant(event.startsAt, 'Event start (startsAt)'),
    hackathonEnd: instant(event.endsAt, 'Event end (endsAt)'),
    submissionDeadline: null,
    teamSizeMin: null,
    teamSizeMax: null,
    eligibility: focus.length > 0 ? focus.join(', ') : null,
    themes: focus,
    technologies: [],
    prizeAmount: null,
    prizeCurrency: null,
    prizeDetails: null,
    freeOrPaid: 'unknown',
    sourceDeadlineText: null,
    provenance,
    raw: event,
    retrievedAt,
  };
}

/**
 * Read the Inertia page payload out of an MLH season page.
 *
 * Inertia renders `<script data-page="app" type="application/json">{...}</script>`,
 * where `data-page` is the page identifier and the JSON lives in the script's text
 * content. Parsing the attribute instead would return the literal string "app".
 * A malformed payload yields an empty list rather than an exception, so one broken
 * page cannot fail a whole crawl.
 */
export function parseMlhSeasonPage(html: string): MlhEvent[] {
  let events: MlhEvent[] = [];
  try {
    const $ = cheerio.load(html);
    const candidates: string[] = [];
    $('script[type="application/json"]').each((_, el) => {
      const text = $(el).contents().text().trim();
      if (text.startsWith('{')) candidates.push(text);
    });
    $('script[data-page]').each((_, el) => {
      const text = $(el).contents().text().trim();
      if (text.startsWith('{')) candidates.push(text);
    });

    for (const text of candidates) {
      let payload: { props?: Record<string, unknown> };
      try {
        payload = JSON.parse(text);
      } catch {
        continue;
      }
      const props = payload?.props;
      if (!props) continue;

      const isEventList = (value: unknown): value is MlhEvent[] =>
        Array.isArray(value) && value.some((item) => Boolean(item) && typeof item === 'object' && 'slug' in (item as object) && 'startsAt' in (item as object));

      // MLH splits its listing into upcoming and past events; both are useful
      // (a closed event is still worth showing with a closed registration).
      const collected: MlhEvent[] = [];
      for (const key of ['upcomingEvents', 'pastEvents']) {
        if (isEventList(props[key])) collected.push(...(props[key] as MlhEvent[]));
      }
      if (collected.length > 0) {
        events = collected;
      } else {
        for (const value of Object.values(props)) {
          if (isEventList(value)) {
            events = value as MlhEvent[];
            break;
          }
        }
      }
      if (events.length > 0) break;
    }
  } catch {
    return [];
  }
  return events;
}

export const mlhAdapter: SourceAdapter = {
  id: 'mlh',
  name: 'Major League Hacking',
  homepage: 'https://mlh.io/seasons',
  policyNote:
    'Reads the public season event page and its embedded JSON payload. robots.txt disallows only /account/, /tools/, /admin/ and similar private paths; season pages are allowed. No authentication is used.',
  enabled: config.adapters.mlh.enabled,

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const started = Date.now();
    let records = 0;
    let failed = 0;
    const now = Date.now();

    for (const season of DEFAULT_SEASONS) {
      if (ctx.signal.aborted) break;
      let events: MlhEvent[];
      try {
        const res = await safeFetch(`https://mlh.io/seasons/${season}/events`, { allowedHosts: HOSTS });
        events = parseMlhSeasonPage(res.body);
      } catch (err) {
        failed += 1;
        ctx.log.warn('mlh season failed', { season, error: (err as Error).message });
        continue;
      }
      if (events.length === 0) {
        ctx.log.warn('mlh season yielded no events', { season });
        continue;
      }

      // MLH lists every event ever, so keep what is still relevant: anything
      // not already finished, judged by its own end date.
      const relevant = events.filter((e) => {
        if (e.status && e.status !== 'ended') return true;
        if (!e.endsAt) return true;
        const end = new Date(e.endsAt).getTime();
        return Number.isNaN(end) ? true : end > now - 30 * 86_400_000;
      });

      for (const event of relevant) {
        if (ctx.signal.aborted) break;
        if (!event?.id || !event?.name) {
          failed += 1;
          continue;
        }
        try {
          await ctx.onRecord(normalizeMlhEvent(event, season));
          records += 1;
        } catch (err) {
          failed += 1;
          ctx.log.warn('mlh record rejected', { id: event.id, error: (err as Error).message });
        }
      }
      ctx.log.info('mlh season ingested', { season, total: events.length, kept: relevant.length, records });
    }

    return { records, failed, durationMs: Date.now() - started };
  },

  async check() {
    const started = Date.now();
    try {
      const res = await safeFetch('https://mlh.io/seasons/2026/events', { allowedHosts: HOSTS, retries: 1 });
      const events = parseMlhSeasonPage(res.body);
      return {
        ok: events.length > 0,
        detail: `season page parsed, ${events.length} events`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, durationMs: Date.now() - started };
    }
  },
};
