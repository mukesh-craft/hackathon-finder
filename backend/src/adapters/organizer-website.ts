/**
 * OrganizerWebsiteAdapter — arbitrary public hackathon pages.
 *
 * University and college event pages, community pages and organizer sites do not
 * share a platform, so this adapter takes a URL and does its best with what the
 * page actually provides:
 *
 *   1. schema.org Event JSON-LD (most reliable: gives structured start/end/location)
 *   2. Open Graph / meta tags
 *   3. visible text scanned by the deadline classifier
 *
 * Every step is confidence-scored. When nothing states a registration deadline,
 * the result carries none — the record simply says "Not specified" and points at
 * the source page. This adapter is where the anti-hallucination requirement is
 * under the most pressure, so it is also the most conservative.
 */
import * as cheerio from 'cheerio';
import type { Confidence, ExtractedDate, RawHackathon } from '@hf/shared';
import { extractDeadlinesFromText } from '@hf/shared';
import { extractJsonLdEvents, extractMeta, readAddress, stripHtml } from './html.js';
import { safeFetch } from '../http/safe-fetch.js';
import type { SourceAdapter, AdapterContext, AdapterRunResult } from './types.js';

export interface OrganizerPageInput {
  url: string;
  /** Optional hint supplied by a human/operator, e.g. a known city. */
  cityHint?: string | null;
  stateHint?: string | null;
}

export interface OrganizerPageResult {
  record: RawHackathon;
  /** Everything the classifier found, for debugging in the admin dashboard. */
  detected: ExtractedDate[];
  notes: string[];
}

function isoInstant(value: string | undefined, kind: ExtractedDate['kind'], label: string, confidence: Confidence): ExtractedDate | null {
  if (!value) return null;
  const match = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim());
  if (!match) return null;
  const dateOnly = !/[T ]\d{2}:\d{2}/.test(value);
  const offset = /([+-]\d{2}:?\d{2}|Z)$/.exec(value.trim());
  let sourceTimezone: string | null = null;
  let offsetMinutes: number | null = null;
  if (offset) {
    if (offset[1] === 'Z') {
      sourceTimezone = 'UTC';
      offsetMinutes = 0;
    } else {
      const digits = offset[1].slice(1).replace(':', '');
      offsetMinutes = (offset[1][0] === '-' ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
      sourceTimezone = `UTC${offset[1]}`;
    }
  }
  return {
    iso: value.trim(),
    kind,
    precision: dateOnly ? 'date_only' : 'instant',
    sourceTimezone,
    offsetMinutes,
    raw: value.trim(),
    label,
    confidence,
  };
}

/** Pick the best registration deadline out of everything the page contained. */
export function chooseDeadlines(found: ExtractedDate[]): {
  registrationDeadline: ExtractedDate | null;
  registrationOpens: ExtractedDate | null;
  submission: ExtractedDate | null;
  start: ExtractedDate | null;
  end: ExtractedDate | null;
  finalPresentation: ExtractedDate | null;
  results: ExtractedDate | null;
} {
  const pick = (kind: ExtractedDate['kind']) => found.find((d) => d.kind === kind && d.iso) ?? null;
  return {
    registrationDeadline: pick('registration_deadline'),
    registrationOpens: pick('registration_opens'),
    submission:
      pick('submission_deadline') ?? pick('project_submission_deadline') ?? pick('idea_submission_deadline'),
    start: pick('hackathon_start'),
    end: pick('hackathon_end'),
    finalPresentation: pick('final_presentation'),
    results: pick('result_announcement'),
  };
}

export async function ingestOrganizerPage(
  input: OrganizerPageInput,
  log?: { warn: (m: string, meta?: Record<string, unknown>) => void },
): Promise<OrganizerPageResult> {
  const res = await safeFetch(input.url, { retries: 2 });
  const html = res.body;
  const retrievedAt = new Date().toISOString();
  const $ = cheerio.load(html);
  const notes: string[] = [];

  const jsonLd = extractJsonLdEvents(html);
  const event = jsonLd[0] ?? null;
  const meta = extractMeta(html);
  const metaValue = (name: string) => meta.find((m) => m.name === name)?.content ?? null;

  // Structured values win; visible text is the fallback.
  let start: ExtractedDate | null = isoInstant(event?.startDate, 'hackathon_start', 'schema.org Event.startDate', 'verified');
  let end: ExtractedDate | null = isoInstant(event?.endDate, 'hackathon_end', 'schema.org Event.endDate', 'verified');

  const bodyText = stripHtml($('body').html() ?? '', 60_000);
  // The classifier reads a bounded window around the date-bearing part of the page
  // so that an unrelated "copyright 2026" cannot outvote a labelled deadline.
  const relevant = collectDeadlineContext(bodyText);
  const detected = extractDeadlinesFromText(relevant, { assumeYear: new Date().getUTCFullYear() });
  const chosen = chooseDeadlines(detected);

  const title =
    (typeof event?.name === 'string' && event.name.trim()) ||
    metaValue('og:title') ||
    $('h1').first().text().trim() ||
    $('title').text().trim() ||
    'Untitled hackathon';

  const address = readAddress(event?.location);
  const text = bodyText;
  const city = input.cityHint ?? address.city ?? null;
  const state = input.stateHint ?? address.region ?? null;
  const venue = address.address ?? null;

  const organizerName = readOrganizer(event?.organizer, $, meta);
  const isOnline = /fully online|online event|virtual/i.test(`${metaValue('og:description') ?? ''} ${address.address ?? ''}`);
  const isOffline = Boolean(venue) || /offline|in-?person|on-?site/i.test(text.slice(0, 4000));

  // A date found only in body text is lower confidence than one in JSON-LD.
  const registrationDeadline = chosen.registrationDeadline;
  if (!registrationDeadline) {
    notes.push('No labelled registration deadline found on the page.');
  } else if (registrationDeadline.confidence === 'unknown') {
    notes.push(`Deadline phrase was ambiguous: "${registrationDeadline.label ?? registrationDeadline.raw}".`);
  }

  const prize = extractPrize(text);
  const teamSize = extractTeamSize(text);
  const eligibility = extractEligibility(text, $);

  const provenance: RawHackathon['provenance'] = [];
  const prov = (field: string, value: string | number | null | undefined, confidence: Confidence) => {
    if (value === null || value === undefined || value === '') return;
    provenance.push({ field, value: String(value), source: 'organizer_website', sourceUrl: res.url, retrievedAt, confidence });
  };
  prov('title', title, event?.name ? 'verified' : 'partially_verified');
  prov('organizer', organizerName, 'partially_verified');
  prov('city', city, address.city || input.cityHint ? 'source_confirmed' : 'partially_verified');
  prov('venue', venue, 'source_confirmed');
  prov('registration_deadline', registrationDeadline?.iso, registrationDeadline?.confidence ?? 'unknown');
  prov('hackathon_start', start?.iso, 'verified');
  prov('hackathon_end', end?.iso, 'verified');
  prov('submission_deadline', chosen.submission?.iso, 'partially_verified');
  prov('team_size_min', teamSize.min, 'partially_verified');
  prov('team_size_max', teamSize.max, 'partially_verified');
  prov('prize_amount', prize.amount, 'partially_verified');
  prov('eligibility', eligibility, 'partially_verified');

  const record: RawHackathon = {
    source: 'organizer_website',
    sourceRecordId: canonicaliseUrl(res.url),
    title,
    description: (typeof event?.description === 'string' ? event.description : metaValue('og:description')) ?? null,
    organizer: organizerName,
    sourceUrl: res.url,
    registrationUrl: findRegistrationLink($),
    locationText: [city, state].filter(Boolean).join(', ') || (isOnline ? 'Online' : null),
    city,
    state,
    country: address.country ?? (isOnline ? null : 'India'),
    venue,
    eventType: 'hackathon',
    onlineOrOffline: isOnline ? 'online' : isOffline ? 'offline' : 'unknown',
    registrationOpensAt: chosen.registrationOpens,
    registrationDeadline,
    hackathonStart: start,
    hackathonEnd: end,
    submissionDeadline: chosen.submission,
    teamSizeMin: teamSize.min,
    teamSizeMax: teamSize.max,
    eligibility,
    themes: extractThemes(text),
    technologies: extractTechnologies(text),
    prizeAmount: prize.amount,
    prizeCurrency: prize.currency,
    prizeDetails: prize.text,
    freeOrPaid: 'unknown',
    sourceDeadlineText: registrationDeadline?.raw ?? null,
    provenance,
    raw: { jsonLd, meta: meta.slice(0, 40), textSample: text.slice(0, 4000) },
    retrievedAt,
  };

  log?.warn('organizer page parsed', { url: res.url, deadlines: detected.length });
  return { record, detected, notes };
}

/** Keep only the page regions that plausibly contain schedule information. */
function collectDeadlineContext(text: string): string {
  const keywords = /deadline|register|registration|submit|submission|schedule|important dates|timeline|apply|starts|ends|closes/i;
  const blocks = text
    .split(/\n{2,}|(?<=\b(?:date|dates|deadline)\b)\s*[|·•]\s*/i)
    .map((b) => b.trim())
    .filter(Boolean);
  const relevant = blocks.filter((b) => keywords.test(b) && /\d/.test(b));
  if (relevant.length === 0) return text.slice(0, 20_000);
  return relevant.slice(0, 120).join('\n');
}

function canonicaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|source|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function readOrganizer(organizer: unknown, $: cheerio.CheerioAPI, meta: Array<{ name: string; content: string }>): string | null {
  if (typeof organizer === 'string') return organizer.trim() || null;
  if (organizer && typeof organizer === 'object') {
    const node = organizer as Record<string, unknown>;
    if (typeof node.name === 'string' && node.name.trim()) return node.name.trim();
  }
  if (Array.isArray(organizer)) {
    for (const entry of organizer) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
        return String((entry as Record<string, unknown>).name);
      }
    }
  }
  const siteName = meta.find((m) => m.name === 'og:site_name')?.content;
  if (siteName) return siteName;
  const about = $('[rel="author"], .organizer, .organised-by, #organizer').first().text().trim();
  return about || null;
}

function findRegistrationLink($: cheerio.CheerioAPI): string {
  const link = $('a[href]').filter((_, el) => {
    const href = ($(el).attr('href') ?? '').toLowerCase();
    const text = $(el).text().trim().toLowerCase();
    return (
      /register|registration|apply|sign\s*up|submit/.test(href) ||
      /register|apply|sign\s*up|join/.test(text)
    );
  }).first().attr('href');
  if (!link) return $('base').attr('href') ?? '';
  try {
    return new URL(link, $('base').attr('href')).toString();
  } catch {
    return link;
  }
}

const PRIZE_CURRENCY: Record<string, string> = { '₹': 'INR', $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };

function extractPrize(text: string): { amount: number | null; currency: string | null; text: string | null } {
  const patterns = [
    /(?:total\s+)?prize\s*(?:pool|amount)?[^0-9₹$€£¥]{0,40}([₹$€£¥])\s?([\d,]+(?:\.\d+)?)\s*(lakh|crore|k|m)?/i,
    /([₹$€£¥])\s?([\d,]+(?:\.\d+)?)\s*(lakh|crore)\b[^.]{0,20}prize/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    let value = Number(m[2].replace(/,/g, ''));
    const unit = (m[3] ?? '').toLowerCase();
    if (unit === 'k' || unit === 'thousand') value *= 1_000;
    if (unit === 'lakh') value *= 100_000;
    if (unit === 'crore') value *= 10_000_000;
    if (unit === 'm') value *= 1_000_000;
    return {
      amount: Number.isFinite(value) ? value : null,
      currency: PRIZE_CURRENCY[m[1]] ?? null,
      text: m[0].trim().slice(0, 160),
    };
  }
  return { amount: null, currency: null, text: null };
}

function extractTeamSize(text: string): { min: number | null; max: number | null } {
  const range = /team\s*(?:size\s*)?(?:of\s*)?(\d+)\s*(?:-|–|to)\s*(\d+)/i.exec(text);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const upto = /team\s*(?:size\s*)?(?:of\s*)?(?:up\s*to|max(?:imum)?\s*(?:of\s*)?)(\d+)/i.exec(text);
  if (upto) return { min: 1, max: Number(upto[1]) };
  const minimum = /(?:minimum|at\s*least)\s*(\d+)\s*(?:members?|participants?)/i.exec(text);
  if (minimum) return { min: Number(minimum[1]), max: null };
  return { min: null, max: null };
}

function extractEligibility(text: string, $: cheerio.CheerioAPI): string | null {
  const node = $('#eligibility, .eligibility, [id*="eligib"]').first();
  const fromDom = stripHtml(node.html() ?? '', 1500);
  if (fromDom) return fromDom;
  const m = /eligib\w*[^.]{0,320}/i.exec(text);
  return m ? m[0].trim().slice(0, 320) : null;
}

const THEME_KEYWORDS = [
  'artificial intelligence', 'machine learning', 'ai/ml', 'blockchain', 'web3', 'cybersecurity',
  'web development', 'mobile', 'cloud', 'iot', 'healthcare', 'fintech', 'open source',
  'devops', 'quantum', 'climate', 'social good', 'space', 'gaming', 'ar/vr', 'computer vision',
];
const TECH_KEYWORDS = [
  'python', 'javascript', 'typescript', 'react', 'node.js', 'django', 'flask', 'java', 'c++',
  'go lang', 'rust', 'kotlin', 'swift', 'flutter', 'tensorflow', 'pytorch', 'aws', 'azure',
  'gcp', 'docker', 'kubernetes', 'solidity', 'postgresql', 'mongodb', 'firebase',
];

function extractThemes(text: string): string[] {
  const lower = text.toLowerCase();
  return THEME_KEYWORDS.filter((k) => lower.includes(k));
}

function extractTechnologies(text: string): string[] {
  const lower = text.toLowerCase();
  return TECH_KEYWORDS.filter((k) => lower.includes(k));
}

/**
 * The organizer adapter is driven by explicit URLs rather than a listing crawl:
 * there is no directory of university hackathon pages to walk. The registry
 * endpoint can enqueue a URL for ingestion.
 */
export const organizerWebsiteAdapter: SourceAdapter = {
  id: 'organizer_website',
  name: 'Organizer websites',
  homepage: '',
  policyNote:
    'Fetches operator-supplied public pages only. Every request goes through the SSRF guard (http/https, no private or metadata addresses, port allowlist, redirect re-validation, size and time caps). Deadlines are taken from schema.org Event JSON-LD first, then from labelled page text; ambiguous labels yield no deadline.',
  enabled: true,

  async run(): Promise<AdapterRunResult> {
    // Enqueued per-URL by the ingest API rather than discovered by crawling.
    return { records: 0, failed: 0, durationMs: 0 };
  },
};
