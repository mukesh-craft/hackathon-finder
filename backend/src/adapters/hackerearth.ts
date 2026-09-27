/**
 * HackerEarth adapter — https://www.hackerearth.com
 *
 * This adapter is implemented but **ships disabled**, and the reason is
 * recorded rather than hidden:
 *
 *   HackerEarth's robots.txt disallows `/*AJAX`, and its /hackathons/ listing is
 *   rendered client-side — the event data is only reachable through those
 *   AJAX endpoints. Fetching them would mean knowingly requesting paths the site
 *   has asked crawlers not to use, so the adapter stays off by default.
 *
 * The normalisation code below is real and exercised by unit tests. If HackerEarth
 * ever publishes server-rendered listings or a public API, set
 * ADAPTER_HACKEREARTH_ENABLED=true and it will start contributing.
 */
import * as cheerio from 'cheerio';
import type { Confidence, ExtractedDate, RawHackathon } from '@hf/shared';
import { extractDeadlinesFromText } from '@hf/shared';
import { stripHtml } from './html.js';
import { safeFetch } from '../http/safe-fetch.js';
import { config } from '../config.js';
import type { SourceAdapter, AdapterContext, AdapterRunResult } from './types.js';

const HOSTS = ['hackerearth.com'];

export interface HackerEarthListing {
  title: string;
  url: string;
  mode: 'online' | 'offline';
  deadlineText: string | null;
  /** The classified registration deadline, if the card labelled one. */
  deadline: ExtractedDate | null;
  prizeText: string | null;
  eligibilityText: string | null;
  datesText: string | null;
}

const CURRENCY: Record<string, string> = { '₹': 'INR', $: 'USD', '€': 'EUR', '£': 'GBP' };

/**
 * Parse a server-rendered HackerEarth hackathon list. Kept pure so it can be
 * tested without touching the network.
 */
export function parseHackerEarthList(html: string): HackerEarthListing[] {
  const $ = cheerio.load(html);
  const out: HackerEarthListing[] = [];
  $('div.challenge-listing, .challenge-card-modern, [data-challenge-type]').each((_, el) => {
    const node = $(el);
    const anchor = node.find('a[href*="/challenges/"], a[href*="/hackathons/"]').first();
    const href = anchor.attr('href');
    const title = node.find('.challenge-name, .title, h3, h4').first().text().trim() || anchor.text().trim();
    if (!href || !title) return;
    const text = stripHtml(node.html() ?? '', 4000);
    const prizeMatch = /(₹|\$|€|£)\s?([\d,]+(?:\.\d+)?)/.exec(text);
    const deadline = extractDeadline(text);
    out.push({
      title,
      url: href.startsWith('http') ? href : `https://www.hackerearth.com${href}`,
      mode: /offline/i.test(text) ? 'offline' : 'online',
      deadlineText: deadline?.raw ?? null,
      deadline,
      prizeText: prizeMatch ? `${prizeMatch[1]}${prizeMatch[2]}` : null,
      eligibilityText: null,
      datesText: null,
    });
  });
  return out;
}

/**
 * Find the best deadline in a card's text. Returns the registration deadline
 * when one is labelled; otherwise returns the first dated phrase so the record
 * still preserves a verbatim deadline, without promoting it to registration.
 */
function extractDeadline(text: string): ExtractedDate | null {
  const found = extractDeadlinesFromText(text);
  if (found.length === 0) return null;
  return found.find((d) => d.kind === 'registration_deadline') ?? null;
}

export function normalizeHackerEarthListing(listing: HackerEarthListing): RawHackathon {
  const retrievedAt = new Date().toISOString();
  // The classification was made against the full card text; the bare fragment on
  // its own carries no label, so the stored verdict is used rather than
  // re-guessing from an unlabeled date.
  const registration = listing.deadline?.kind === 'registration_deadline' ? listing.deadline : null;
  const prize = listing.prizeText ? /(₹|\$|€|£)\s?([\d,]+)/.exec(listing.prizeText) : null;

  const provenance: RawHackathon['provenance'] = [];
  const prov = (field: string, value: string | null | undefined, confidence: Confidence) => {
    if (!value) return;
    provenance.push({ field, value, source: 'hackerearth', sourceUrl: listing.url, retrievedAt, confidence });
  };
  prov('title', listing.title, 'verified');
  prov('registration_deadline', registration?.iso, 'partially_verified');
  prov('online_or_offline', listing.mode, 'source_confirmed');

  return {
    source: 'hackerearth',
    sourceRecordId: listing.url,
    title: listing.title,
    description: null,
    organizer: null,
    sourceUrl: listing.url,
    registrationUrl: listing.url,
    locationText: null,
    city: null,
    state: null,
    country: 'India',
    venue: null,
    eventType: 'hackathon',
    onlineOrOffline: listing.mode,
    registrationOpensAt: null,
    registrationDeadline: registration,
    hackathonStart: null,
    hackathonEnd: null,
    submissionDeadline: null,
    teamSizeMin: null,
    teamSizeMax: null,
    eligibility: listing.eligibilityText,
    themes: [],
    technologies: [],
    prizeAmount: prize ? Number(prize[2].replace(/,/g, '')) : null,
    prizeCurrency: prize ? CURRENCY[prize[1]] ?? null : null,
    prizeDetails: listing.prizeText,
    freeOrPaid: 'unknown',
    sourceDeadlineText: listing.deadlineText,
    provenance,
    raw: listing,
    retrievedAt,
  };
}

export const hackerEarthAdapter: SourceAdapter = {
  id: 'hackerearth',
  name: 'HackerEarth',
  homepage: 'https://www.hackerearth.com/hackathons/',
  policyNote:
    'DISABLED BY POLICY. HackerEarth robots.txt disallows /*AJAX and the /hackathons/ listing is client-rendered, so the data would only be reachable through disallowed endpoints. Enable only if the site starts serving listings server-side or publishes a public API.',
  enabled: config.adapters.hackerearth.enabled,

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    if (!config.adapters.hackerearth.enabled) {
      ctx.log.info('hackerearth adapter disabled by policy; skipping');
      return { records: 0, failed: 0, durationMs: 0 };
    }
    const started = Date.now();
    let records = 0;
    let failed = 0;
    try {
      const res = await safeFetch('https://www.hackerearth.com/hackathons/', { allowedHosts: HOSTS });
      const listings = parseHackerEarthList(res.body);
      if (listings.length === 0) {
        ctx.log.warn('hackerearth returned no server-rendered listings (page is client-rendered)');
      }
      for (const listing of listings) {
        try {
          await ctx.onRecord(normalizeHackerEarthListing(listing));
          records += 1;
        } catch {
          failed += 1;
        }
      }
    } catch (err) {
      failed += 1;
      ctx.log.warn('hackerearth fetch failed', { error: (err as Error).message });
    }
    return { records, failed, durationMs: Date.now() - started };
  },

  async check() {
    const started = Date.now();
    try {
      const res = await safeFetch('https://www.hackerearth.com/hackathons/', { allowedHosts: HOSTS, retries: 1 });
      const listings = parseHackerEarthList(res.body);
      return {
        ok: listings.length > 0,
        detail:
          listings.length > 0
            ? `${listings.length} listings parsed`
            : 'listings are client-rendered; would require disallowed AJAX endpoints',
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, durationMs: Date.now() - started };
    }
  },
};
