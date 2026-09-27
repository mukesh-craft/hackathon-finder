/**
 * Unstop adapter — https://unstop.com
 *
 * Data source: the public opportunity JSON endpoint that Unstop's own web app
 * calls. `robots.txt` explicitly allows `/api/public/*` (a more specific rule
 * than the `/api/*` disallow) and explicitly welcomes AI crawlers, so this is a
 * sanctioned read path rather than scraping.
 *
 * Deadline handling is the important part. Unstop publishes two distinct fields:
 *   regnRequirements.end_regn_dt  -> registration closes
 *   end_date                      -> the event ends
 * These are different values for roughly half of the live catalogue, so the
 * adapter maps each to its own field and never substitutes one for the other.
 */
import type { DeadlineConflict, RawHackathon, ExtractedDate, Confidence, SourceId } from '@hf/shared';
import { extractDeadlinesFromText, parseDateExpression, SOURCE_TRUST } from '@hf/shared';
import { stripHtml } from './html.js';
import { safeFetchJson } from '../http/safe-fetch.js';
import { config } from '../config.js';
import type { SourceAdapter, AdapterContext, AdapterRunResult } from './types.js';

const SOURCE: SourceId = 'unstop';
const HOSTS = ['unstop.com'];

interface UnstopPrize {
  rank?: string;
  cash?: number | null;
  currency?: string | null;
  cash_postfix?: string | null;
  others?: string | null;
  certificate?: number | null;
  pre_placement_internship?: number | null;
}

interface UnstopPayment {
  amount?: number | null;
  required?: number | null;
}

interface UnstopRegn {
  start_regn_dt?: string | null;
  end_regn_dt?: string | null;
  min_team_size?: number | null;
  max_team_size?: number | null;
  reg_status?: string | null;
  eligibility?: string | null;
  work_location_type?: string | null;
}

interface UnstopItem {
  id: number;
  title: string;
  details?: string | null;
  seo_url?: string | null;
  public_url?: string | null;
  short_url?: string | null;
  region?: string | null;
  subtype?: string | null;
  regn_open?: number | null;
  status?: string | null;
  updated_at?: string | null;
  end_date?: string | null;
  organisation?: { id?: number; name?: string | null } | null;
  regnRequirements?: UnstopRegn | null;
  address_with_country_logo?: {
    address?: string | null;
    city?: string | null;
    state?: string | null;
    country?: { name?: string | null; alpha_2?: string | null } | null;
  } | null;
  filters?: Array<{ name?: string | null; type?: string | null }> | null;
  required_skills?: Array<{ skill?: string | null }> | null;
  prizes?: UnstopPrize[] | null;
  payment_services?: UnstopPayment[] | null;
  isPaid?: boolean | null;
  registerCount?: number | null;
}

interface UnstopResponse {
  data?: { data?: UnstopItem[]; total?: number; last_page?: number; current_page?: number } | null;
  error?: { message?: string } | null;
}

const CURRENCY_MAP: Record<string, string> = {
  'fa-rupee': 'INR',
  'fa-dollar': 'USD',
  'fa-euro': 'EUR',
  'fa-gbp': 'GBP',
  'fa-yen': 'JPY',
};

function instant(value: string | null | undefined, label: string | null, confidence: Confidence): ExtractedDate | null {
  if (!value) return null;
  const parsed = parseDateExpression(value);
  if (!parsed?.iso) return null;
  return { ...parsed, kind: 'unknown', label, raw: value, confidence };
}

function cleanUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `https://unstop.com/${path.replace(/^\/+/, '')}`;
}

function eligibilityText(filters: UnstopItem['filters']): string[] {
  return (filters ?? [])
    .map((f) => (f.type === 'eligible' ? f.name : null))
    .filter((n): n is string => Boolean(n));
}

function domainNames(filters: UnstopItem['filters']): string[] {
  return (filters ?? [])
    .map((f) => (f.type === 'domain' ? f.name : null))
    .filter((n): n is string => Boolean(n));
}

function prizeTotal(prizes: UnstopPrize[] | null | undefined): {
  amount: number | null;
  currency: string | null;
  details: string | null;
} {
  if (!Array.isArray(prizes) || prizes.length === 0) return { amount: null, currency: null, details: null };
  const cashPrizes = prizes.filter((p) => typeof p.cash === 'number' && p.cash > 0);
  const total = cashPrizes.length > 0 ? cashPrizes.reduce((sum, p) => sum + (p.cash ?? 0), 0) : null;
  const currency = cashPrizes[0]?.currency ? CURRENCY_MAP[cashPrizes[0].currency] ?? cashPrizes[0].currency : null;
  const breakdown = prizes
    .map((p) => {
      const label = p.rank ?? 'Prize';
      const cash = p.cash ? ` ${currency ?? ''}${p.cash.toLocaleString('en-IN')}`.trimEnd() : '';
      const cert = p.certificate ? ' + certificate' : '';
      return `${label}:${cash}${cert}`;
    })
    .join(' | ');
  return { amount: total, currency, details: breakdown || null };
}

const PRIZE_CURRENCIES: Record<string, string> = { '₹': 'INR', $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const PRIZE_UNITS: Record<string, number> = { k: 1_000, thousand: 1_000, lakh: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000, m: 1_000_000, million: 1_000_000 };

/**
 * Last-resort prize reader for listings whose structured prizes are empty but
 * whose description states an amount ("₹25,000 Cash Prize Pool", "prizes worth
 * $5,000", "1 lakh in prizes"). Requires a prize word NEAR the amount so a
 * stray fee or date never becomes a prize.
 */
export function prizeFromText(text: string | null): { amount: number; currency: string | null; text: string } | null {
  if (!text) return null;
  const patterns = [
    /(?<word>prize\s*(?:pool|amount|money|fund)?|cash\s*prize|winnings?|worth)\b[^₹$€£\d]{0,50}(?<symbol>[₹$€£])\s?(?<digits>[\d,]+(?:\.\d+)?)\s?(?<unit>lakhs?|crores?|thousand|million|[kKmM])?/i,
    /(?<symbol>[₹$€£])\s?(?<digits>[\d,]+(?:\.\d+)?)\s?(?<unit>lakhs?|crores?|thousand|million|[kKmM])?\b[^₹$€£.]{0,50}\b(?<word>prize\s*(?:pool|amount|money)?|cash\s*prize|winnings?)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m?.groups) continue;
    const symbol = m.groups.symbol ?? '';
    const value = Number((m.groups.digits ?? '').replace(/,/g, ''));
    const unit = (m.groups.unit ?? '').toLowerCase();
    if (!Number.isFinite(value) || value <= 0) continue;
    const amount = Math.round(value * (PRIZE_UNITS[unit] ?? 1));
    return { amount, currency: PRIZE_CURRENCIES[symbol] ?? null, text: m[0].trim().slice(0, 160) };
  }
  return null;
}

/** True when two ISO instants differ by more than a day (either direction). */
export function differsByMoreThanADay(aIso: string | null | undefined, bIso: string | null | undefined): boolean {
  if (!aIso || !bIso) return false;
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) > 86_400_000;
}

export function normalizeUnstopItem(item: UnstopItem): RawHackathon {
  const sourceUrl = cleanUrl(item.seo_url) ?? cleanUrl(item.public_url) ?? `https://unstop.com/hackathons/${item.id}`;
  const registrationUrl = cleanUrl(item.short_url) ?? sourceUrl;
  const retrievedAt = new Date().toISOString();

  // --- The two deadlines Unstop publishes, kept apart on purpose. -----------
  const registrationDeadline = instant(
    item.regnRequirements?.end_regn_dt,
    'Registration Deadline (regnRequirements.end_regn_dt)',
    'verified',
  );
  const hackathonEnd = instant(item.end_date, 'Event end (end_date)', 'source_confirmed');
  const registrationOpens = instant(
    item.regnRequirements?.start_regn_dt,
    'Registration opens (regnRequirements.start_regn_dt)',
    'verified',
  );

  const addr = item.address_with_country_logo ?? null;
  const region = (item.region ?? '').toLowerCase();
  const onlineOrOffline: RawHackathon['onlineOrOffline'] =
    region === 'online' ? 'online' : region === 'offline' ? 'offline' : region === 'hybrid' ? 'hybrid' : 'unknown';

  const prize = prizeTotal(item.prizes);
  const description = item.details ? stripHtml(item.details).slice(0, 6000) : null;

  // --- Prize fallback: structured prizes are often empty while the ---------
  // description states the amount in prose ("₹25,000 Cash Prize Pool").
  // Only used when structured data is absent; always marked as text-derived.
  const textPrize = prize.amount === null ? prizeFromText(description) : null;
  const prizeAmount = prize.amount ?? textPrize?.amount ?? null;
  const prizeCurrency = prize.currency ?? textPrize?.currency ?? null;
  const prizeDetails = prize.details ?? textPrize?.text ?? null;

  // --- Event dates from the organizer's own description text. --------------
  // Unstop never publishes an event start; the description often does
  // ("Date: 7–8 October 2026"). The structured end_date stays primary; when
  // the text names a materially different end, both are preserved as a
  // conflict instead of silently swapping one for the other.
  const fieldConflicts: DeadlineConflict[] = [];
  const textDates = description ? extractDeadlinesFromText(description, { assumeYear: new Date().getUTCFullYear() }) : [];
  const textStart = textDates.find((d) => d.kind === 'hackathon_start' && d.iso) ?? null;
  const textEnd = textDates.find((d) => d.kind === 'hackathon_end' && d.iso) ?? null;
  const hackathonStart = textStart
    ? { ...textStart, label: textStart.label ?? 'Event dates in description' }
    : null;
  if (hackathonEnd && textEnd && differsByMoreThanADay(hackathonEnd.iso, textEnd.iso)) {
    fieldConflicts.push({
      field: 'hackathon_end',
      values: [
        { value: hackathonEnd.iso as string, source: SOURCE, sourceUrl, trust: SOURCE_TRUST[SOURCE] ?? 0 },
        { value: textEnd.iso as string, source: SOURCE, sourceUrl, trust: SOURCE_TRUST[SOURCE] ?? 0 },
      ],
      resolvedFrom: SOURCE,
      resolutionNote:
        'Unstop’s event-end field and the organizer’s description text name different dates. The structured field is shown; verify on the official page.',
    });
  }
  const eligible = eligibilityText(item.filters);
  const technologies = Array.from(
    new Set((item.required_skills ?? []).map((s) => s.skill).filter((s): s is string => Boolean(s))),
  );
  const themes = Array.from(new Set(domainNames(item.filters)));

  const fee = (item.payment_services ?? []).reduce<number | null>((sum, p) => {
    if (typeof p.amount !== 'number') return sum;
    return sum === null ? p.amount : sum + p.amount;
  }, null);

  let freeOrPaid: RawHackathon['freeOrPaid'] = 'unknown';
  if (fee !== null && fee > 0) freeOrPaid = 'paid';
  else if (item.isPaid === false) freeOrPaid = 'free';

  const provenance: RawHackathon['provenance'] = [];
  const prov = (field: string, value: string | number | boolean | null | undefined, confidence: Confidence) => {
    if (value === null || value === undefined || value === '') return;
    provenance.push({ field, value: String(value), source: SOURCE, sourceUrl, retrievedAt, confidence });
  };

  prov('title', item.title, 'verified');
  prov('organizer', item.organisation?.name, 'source_confirmed');
  prov('city', addr?.city, 'source_confirmed');
  prov('state', addr?.state, 'source_confirmed');
  prov('country', addr?.country?.name, 'source_confirmed');
  prov('venue', addr?.address, 'source_confirmed');
  prov('online_or_offline', onlineOrOffline, 'source_confirmed');
  prov('registration_deadline', registrationDeadline?.iso, 'verified');
  prov('registration_opens_at', registrationOpens?.iso, 'verified');
  prov('hackathon_end', hackathonEnd?.iso, 'source_confirmed');
  prov('hackathon_start', hackathonStart?.iso, 'partially_verified');
  prov('prize_amount', prizeAmount, textPrize ? 'partially_verified' : 'source_confirmed');
  prov('prize_details', prizeDetails, textPrize ? 'partially_verified' : 'source_confirmed');
  prov('team_size_min', item.regnRequirements?.min_team_size, 'source_confirmed');
  prov('team_size_max', item.regnRequirements?.max_team_size, 'source_confirmed');

  prov('registration_fee', fee, 'source_confirmed');
  prov('eligibility', eligible.join(', '), 'source_confirmed');
  prov('technologies', technologies.join(', '), 'source_confirmed');

  return {
    source: SOURCE,
    sourceRecordId: String(item.id),
    title: item.title,
    description,
    organizer: item.organisation?.name ?? null,
    sourceUrl,
    registrationUrl,
    locationText: addr ? [addr.city, addr.state].filter(Boolean).join(', ') || null : null,
    city: addr?.city ?? null,
    state: addr?.state ?? null,
    country: addr?.country?.name ?? null,
    venue: addr?.address ?? null,
    eventType: item.subtype?.includes('datathon') ? 'datathon' : 'hackathon',
    onlineOrOffline,
    registrationOpensAt: registrationOpens,
    registrationDeadline,
    hackathonStart, // From the description text; the list payload publishes no event start.
    hackathonEnd,
    submissionDeadline: null,
    teamSizeMin: item.regnRequirements?.min_team_size ?? null,
    teamSizeMax: item.regnRequirements?.max_team_size ?? null,
    eligibility: eligible.length > 0 ? eligible.join(', ') : null,
    themes,
    technologies,
    prizeAmount,
    prizeCurrency,
    prizeDetails,
    registrationFee: fee,
    registrationFeeCurrency: fee !== null ? 'INR' : null,
    freeOrPaid,
    sourceDeadlineText: item.regnRequirements?.end_regn_dt ?? null,
    provenance,
    fieldConflicts,
    raw: item,
    retrievedAt,
  };
}

function listUrl(page: number, perPage: number): string {
  const params = new URLSearchParams({
    opportunity: 'hackathons',
    oppstatus: config.ingest.unstopOppStatus,
    page: String(page),
    per_page: String(perPage),
  });
  return `https://unstop.com/api/public/opportunity/search-result?${params.toString()}`;
}

export const unstopAdapter: SourceAdapter = {
  id: SOURCE,
  name: 'Unstop',
  homepage: 'https://unstop.com/hackathons',
  policyNote:
    'Uses Unstop\'s public opportunity JSON endpoint at /api/public/*, which robots.txt explicitly allows and which welcomes automated readers. Requests are spaced by HTTP_PER_HOST_DELAY_MS and no login-gated endpoints are touched.',
  enabled: config.adapters.unstop.enabled,

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const started = Date.now();
    let records = 0;
    let failed = 0;
    const perPage = config.ingest.pageSize;
    const maxPages = config.ingest.maxPagesPerSource;

    for (let page = 1; page <= maxPages; page += 1) {
      if (ctx.signal.aborted) break;
      let payload: UnstopResponse;
      try {
        payload = await safeFetchJson<UnstopResponse>(listUrl(page, perPage), { allowedHosts: HOSTS });
      } catch (err) {
        failed += 1;
        ctx.log.warn('unstop page failed', { page, error: (err as Error).message });
        // One failed page must not end the crawl; the next page may still work.
        continue;
      }
      const items = payload.data?.data ?? [];
      if (!Array.isArray(items) || items.length === 0) break;
      for (const item of items) {
        if (ctx.signal.aborted) break;
        if (!item?.id || !item.title) {
          failed += 1;
          continue;
        }
        try {
          await ctx.onRecord(normalizeUnstopItem(item));
          records += 1;
        } catch (err) {
          failed += 1;
          ctx.log.warn('unstop record rejected', { id: item.id, error: (err as Error).message });
        }
      }
      const total = payload.data?.total ?? 0;
      const lastPage = payload.data?.last_page ?? 1;
      ctx.log.info('unstop page ingested', { page, items: items.length, records, total, lastPage });
      // The API can return a short page before the end of the catalogue, so the
      // only reliable stop signals are "reached the last page" and "no rows".
      if (page >= lastPage) break;
      if (items.length === 0) break;
    }

    return { records, failed, durationMs: Date.now() - started };
  },

  async check() {
    const started = Date.now();
    try {
      const payload = await safeFetchJson<UnstopResponse>(listUrl(1, 1), { allowedHosts: HOSTS, retries: 1 });
      return {
        ok: Array.isArray(payload.data?.data),
        detail: `endpoint reachable, ${payload.data?.total ?? '?'} hackathons listed`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, durationMs: Date.now() - started };
    }
  },
};
