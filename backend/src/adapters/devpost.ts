/**
 * Devpost adapter — https://devpost.com
 *
 * Data source: the JSON listing endpoint that powers devpost.com/hackathons,
 * plus the public event page for the precise deadline wording.
 * `robots.txt` is `User-agent: * / Disallow:` — nothing is disallowed for
 * generic agents — so both paths are permitted. Requests are spaced and capped.
 *
 * Deadline handling: Devpost publishes a single deadline and labels it
 * "Deadline: <date> @ <time> <tz>". On the platform you cannot register without
 * being able to submit, so registration closes at that instant. We therefore
 * store it as `submission_deadline` (the fact Devpost states) and, when
 * DEVPOST_INFER_REGISTRATION_DEADLINE is on, mirror it into
 * `registration_deadline` with basis `inferred_from_submission_deadline` and a
 * confidence of `inferred`, so the UI can state plainly that it is an inference
 * rather than a published registration deadline.
 */
import type { ExtractedDate, RawHackathon, Confidence } from '@hf/shared';
import { extractDeadlinesFromText } from '@hf/shared';
import { stripHtml } from './html.js';
import { safeFetch, safeFetchJson } from '../http/safe-fetch.js';
import { config } from '../config.js';
import type { SourceAdapter, AdapterContext, AdapterRunResult } from './types.js';
import * as cheerio from 'cheerio';

const HOSTS = ['devpost.com'];

interface DevpostHackathon {
  id: number;
  title: string;
  displayed_location?: { icon?: string; location?: string } | null;
  open_state?: string;
  url?: string;
  thumbnail_url?: string | null;
  time_left_to_submission?: string | null;
  submission_period_dates?: string | null;
  themes?: Array<{ id: number; name: string }> | null;
  prize_amount?: string | null;
  prizes_counts?: { cash?: number; other?: number } | null;
  registrations_count?: number | null;
  featured?: boolean;
  organization_name?: string | null;
  winners_announced?: boolean;
  invite_only?: boolean;
  managed_by_devpost_badge?: boolean;
}

interface DevpostResponse {
  hackathons?: DevpostHackathon[];
  meta?: Record<string, unknown>;
}

const CURRENCY_SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY' };

/** Devpost renders prize as HTML: "$<span data-currency-value>740,000</span>". */
function parsePrize(raw: string | null | undefined): { amount: number | null; currency: string | null; raw: string | null } {
  if (!raw) return { amount: null, currency: null, raw: null };
  const text = stripHtml(raw);
  const valueMatch = /data-currency-value="([\d.,]+)"/.exec(raw);
  const cleaned = (valueMatch ? valueMatch[1] : text.replace(/[^\d.,]/g, '')).replace(/,/g, '');
  const amount = cleaned && /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
  const symbol = /([$€£₹¥])/.exec(raw)?.[1];
  return { amount, currency: symbol ? CURRENCY_SYMBOLS[symbol] ?? null : null, raw: text || null };
}

/** "Jul 31 - Oct 01, 2026" -> the end of the window, which is the deadline. */
function parseSubmissionWindow(raw: string | null | undefined): ExtractedDate | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\u2013/g, '-').replace(/\s+/g, ' ').trim();
  const dates = extractDeadlinesFromText(cleaned, { assumeYear: new Date().getUTCFullYear() });
  if (dates.length === 0) return null;
  // The window's end is the last date in the string.
  return dates[dates.length - 1] ?? null;
}

function parseDeadlineFromPage(html: string): ExtractedDate | null {
  try {
    const $ = cheerio.load(html);
    // Devpost renders "Deadline: Sep 30, 2026 @ 11:45pm PDT" in its own markup.
    const candidates: string[] = [];
    $('*').each((_, el) => {
      const node = $(el);
      if (node.children().length > 0) return; // only leaf nodes hold the text
      const text = node.text().replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (/deadline/i.test(text) && extractDeadlinesFromText(text).length > 0) candidates.push(text);
    });
    for (const text of candidates) {
      const found = extractDeadlinesFromText(text, { assumeYear: new Date().getUTCFullYear() });
      const dated = found.find((d) => d.iso);
      if (dated) return { ...dated, kind: 'submission_deadline', confidence: 'verified' };
    }
  } catch {
    return null;
  }
  return null;
}

function isOnline(rec: DevpostHackathon): boolean {
  const icon = rec.displayed_location?.icon ?? '';
  const location = (rec.displayed_location?.location ?? '').toLowerCase();
  return icon === 'globe' || location === 'online' || location.includes('online') || location.includes('worldwide');
}

export interface DevpostNormalizeOptions {
  /** Exact deadline read from the event page, when enrichment ran. */
  detailDeadline?: ExtractedDate | null;
  detailDescription?: string | null;
  detailEligibility?: string | null;
  detailTeamSizeMin?: number | null;
  detailTeamSizeMax?: number | null;
  inferRegistrationDeadline?: boolean;
}

export function normalizeDevpostHackathon(
  rec: DevpostHackathon,
  opts: DevpostNormalizeOptions = {},
): RawHackathon {
  const sourceUrl = rec.url ?? `https://devpost.com/${rec.id}`;
  const retrievedAt = new Date().toISOString();
  const prize = parsePrize(rec.prize_amount);
  const online = isOnline(rec);

  const windowEnd = parseSubmissionWindow(rec.submission_period_dates);
  const submissionDeadline = opts.detailDeadline ?? windowEnd ?? null;

  const registrationDeadline: ExtractedDate | null =
    submissionDeadline && (opts.inferRegistrationDeadline ?? config.devpostInferRegistrationDeadline)
      ? {
          ...submissionDeadline,
          kind: 'registration_deadline',
          label: 'Derived from the Devpost submission deadline',
          confidence: 'inferred' as Confidence,
        }
      : null;

  const locationText = rec.displayed_location?.location ?? (online ? 'Online' : null);
  const city = online ? null : locationText?.split(',')[0]?.trim() || null;
  const state = online ? null : locationText?.split(',').slice(1).join(',').trim() || null;

  const themes = (rec.themes ?? []).map((t) => t.name).filter(Boolean);
  const openState = (rec.open_state ?? '').toLowerCase();

  const provenance: RawHackathon['provenance'] = [];
  const prov = (field: string, value: string | number | boolean | null | undefined, confidence: Confidence) => {
    if (value === null || value === undefined || value === '') return;
    provenance.push({ field, value: String(value), source: 'devpost', sourceUrl, retrievedAt, confidence });
  };
  prov('title', rec.title, 'verified');
  prov('organizer', rec.organization_name, 'source_confirmed');
  prov('online_or_offline', online ? 'online' : 'offline', 'source_confirmed');
  prov('location_text', locationText, 'source_confirmed');
  prov('submission_deadline', submissionDeadline?.iso, opts.detailDeadline ? 'verified' : 'partially_verified');
  if (registrationDeadline) {
    prov('registration_deadline', registrationDeadline.iso, 'inferred');
  }
  prov('prize_amount', prize.amount, 'source_confirmed');
  prov('themes', themes.join(', '), 'source_confirmed');
  prov('eligibility', opts.detailEligibility, 'source_confirmed');

  return {
    source: 'devpost',
    sourceRecordId: String(rec.id),
    title: rec.title,
    description: opts.detailDescription ?? null,
    organizer: rec.organization_name ?? null,
    sourceUrl,
    registrationUrl: sourceUrl,
    locationText,
    city,
    state,
    country: online ? null : 'United States',
    venue: null,
    eventType: 'hackathon',
    onlineOrOffline: online ? 'online' : 'offline',
    registrationOpensAt: null,
    registrationDeadline,
    hackathonStart: null,
    hackathonEnd: null,
    submissionDeadline,
    teamSizeMin: opts.detailTeamSizeMin ?? null,
    teamSizeMax: opts.detailTeamSizeMax ?? null,
    eligibility: opts.detailEligibility ?? null,
    themes,
    technologies: [],
    prizeAmount: prize.amount,
    prizeCurrency: prize.currency,
    prizeDetails: prize.raw,
    freeOrPaid: 'free',
    sourceDeadlineText: submissionDeadline?.raw ?? rec.submission_period_dates ?? null,
    provenance,
    raw: { ...rec, open_state: openState },
    retrievedAt,
  };
}

function listUrl(page: number): string {
  return `https://devpost.com/api/hackathons?page=${page}&status[]=open&status[]=upcoming`;
}

export const devpostAdapter: SourceAdapter = {
  id: 'devpost',
  name: 'Devpost',
  homepage: 'https://devpost.com/hackathons',
  policyNote:
    'Reads devpost.com/api/hackathons and public event pages. robots.txt sets `User-agent: * / Disallow:` so no path is disallowed for generic agents. Detail-page enrichment is capped by DEVPOST_MAX_DETAIL_FETCHES and requests are spaced per host.',
  enabled: config.adapters.devpost.enabled,

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const started = Date.now();
    let records = 0;
    let failed = 0;
    let detailFetches = 0;
    const seen = new Set<string>();

    for (let page = 1; page <= config.ingest.maxPagesPerSource; page += 1) {
      if (ctx.signal.aborted) break;
      let payload: DevpostResponse;
      try {
        payload = await safeFetchJson<DevpostResponse>(listUrl(page), {
          allowedHosts: HOSTS,
          headers: { accept: 'application/json, text/plain, */*' },
        });
      } catch (err) {
        failed += 1;
        ctx.log.warn('devpost page failed', { page, error: (err as Error).message });
        continue;
      }
      const list = payload.hackathons ?? [];
      if (!Array.isArray(list) || list.length === 0) break;
      let newOnPage = 0;
      for (const rec of list) {
        if (ctx.signal.aborted) break;
        if (!rec?.id || !rec.title) {
          failed += 1;
          continue;
        }
        if (seen.has(String(rec.id))) continue;
        seen.add(String(rec.id));
        newOnPage += 1;

        let detail: DevpostNormalizeOptions = {};
        const canEnrich =
          config.devpostDetailEnrichment && detailFetches < config.devpostMaxDetailFetches;
        if (canEnrich) {
          detailFetches += 1;
          try {
            const page = await safeFetch(rec.url ?? `https://devpost.com/${rec.id}`, { allowedHosts: HOSTS });
            detail = {
              detailDeadline: parseDeadlineFromPage(page.body),
              detailDescription: extractOverview(page.body),
              detailEligibility: extractEligibility(page.body),
            };
          } catch (err) {
            // A failed detail fetch degrades precision, never correctness: the
            // listing-level window is still used at reduced confidence.
            ctx.log.warn('devpost detail fetch failed', { id: rec.id, error: (err as Error).message });
          }
        }

        try {
          await ctx.onRecord(normalizeDevpostHackathon(rec, detail));
          records += 1;
        } catch (err) {
          failed += 1;
          ctx.log.warn('devpost record rejected', { id: rec.id, error: (err as Error).message });
        }
      }
      ctx.log.info('devpost page ingested', { page, items: list.length, newOnPage, records });
      if (newOnPage === 0) break;
    }

    return { records, failed, durationMs: Date.now() - started };
  },

  async check() {
    const started = Date.now();
    try {
      const payload = await safeFetchJson<DevpostResponse>(listUrl(1), { allowedHosts: HOSTS, retries: 1 });
      return {
        ok: Array.isArray(payload.hackathons),
        detail: `endpoint reachable, ${payload.hackathons?.length ?? 0} on first page`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, durationMs: Date.now() - started };
    }
  },
};

function extractOverview(html: string): string | null {
  try {
    const $ = cheerio.load(html);
    const node = $('#overview, .challenge-overview, [data-testid="challenge-overview"]').first();
    const text = stripHtml(node.html() ?? '', 4000);
    return text || null;
  } catch {
    return null;
  }
}

function extractEligibility(html: string): string | null {
  try {
    const $ = cheerio.load(html);
    const node = $('#eligibility, .challenge-eligibility, [data-testid="challenge-eligibility"]').first();
    const text = stripHtml(node.html() ?? '', 2000);
    return text || null;
  } catch {
    return null;
  }
}
