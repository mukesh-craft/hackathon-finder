/**
 * Duplicate detection and record merging.
 *
 * The same event is routinely listed on an event platform and on the
 * organizer's own site, under slightly different titles. Showing it three times
 * is a correctness bug, not a cosmetic one. Matching therefore combines several
 * weak signals (title shape, organizer, place, event dates, registration URL)
 * rather than relying on exact title equality.
 */

import { normalizeKey } from './cities.js';
import type { RawHackathon, SourceId } from './types.js';

const TITLE_NOISE = new Set([
  'hackathon', 'hack', 'hacks', 'hackthons', 'the', 'a', 'an', 'of', 'and', 'for', 'in', 'at',
  '20', 'edition', 'ed', 'annual', 'grand', 'national', 'international', 'official', 'invitational',
  'season', 'series', 'challenge', 'competition', 'contest', 'fest', 'code', 'coding', 'tech',
  'technothon', 'hackfest', 'summit', 'meet', 'up', 'x', 'by', 'is', 'live', 'online', 'offline',
]);

/**
 * Collapse intra-word punctuation so "Hack-A-Thon" and "Hackathon" compare as
 * the same word, while keeping real word boundaries intact.
 */
function collapseForTitle(input: string): string {
  return normalizeKey(String(input ?? '').replace(/[-'\u2010-\u2015]/g, ''));
}

/** Normalize a title for comparison: drop edition noise, years and punctuation. */
export function normalizeTitle(title: string): string {
  const key = normalizeKey(title);
  return key
    .split(' ')
    .filter((t) => t && !/^(19|20)\d{2}$/.test(t))
    .filter((t) => !TITLE_NOISE.has(t))
    .join(' ')
    .replace(/\bv(\d+)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalizeTitle(value).split(' ').filter(Boolean));
}

function titleKey(value: string): string {
  return collapseForTitle(value);
}

export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** Bounded Levenshtein distance; bails out once it exceeds `max`. */
export function levenshtein(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 0..1 title similarity.
 *
 * Three signals, deliberately ordered so that raw edit distance can never carry
 * a comparison on its own:
 *  1. exact match of the noise-stripped title
 *  2. containment, e.g. "Hackathon 2026" inside "XYZ Hackathon 2026"
 *  3. token overlap, with edit distance allowed to break ties only when the two
 *     titles actually share a meaningful token
 *
 * Titles that share no meaningful token score 0, which keeps "Smart India
 * Hackathon" and "Hack-the-North" apart despite a similar raw length.
 */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = titleKey(a);
  const nb = titleKey(b);
  if (na === nb) return 1;
  const ta = normalizeTitle(a);
  const tb = normalizeTitle(b);
  if (ta && ta === tb) return 0.97;
  if (na.length >= 4 && (na.includes(nb) || nb.includes(na))) return 0.9;

  const overlap = jaccard(a, b);
  if (overlap === 0) return 0;
  const maxLen = Math.max(na.length, nb.length);
  const dist = levenshtein(na, nb, 5);
  const editScore = maxLen === 0 ? 0 : Math.max(0, 1 - dist / maxLen);
  return Math.min(1, Math.max(overlap, editScore * 0.9));
}

export function organizerSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const na = normalizeKey(a);
  const nb = normalizeKey(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  return jaccard(a, b);
}

function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(ta - tb) / 86_400_000;
}

/**
 * Identity of an event's own web address: host + full path, lower-cased, with
 * `www.`, query strings and fragments removed and a trailing slash trimmed.
 *
 * The full path matters. Platforms issue URLs whose first path segment is a
 * constant (`unstop.com/o/<code>`), so comparing only the host, or only the
 * first segment, would declare every listing on that platform to be the same
 * event. Vanity-subdomain hosts such as `<event>.devpost.com` still compare
 * correctly because the subdomain is part of the host.
 */
function urlIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    const identity = `${host}${path}`;
    return identity.length >= 9 ? identity : null;
  } catch {
    return null;
  }
}

export interface DuplicateVerdict {
  duplicate: boolean;
  score: number;
  reasons: string[];
}

/**
 * Decide whether two source records describe the same event.
 *
 * Signals, in order of decisiveness:
 *  - identical registration URL identity (near-certain)
 *  - near-identical title + same organizer + same place
 *  - near-identical title + same organizer + event dates within 2 days
 *  - very high title similarity alone is NOT enough, because "Hackathon 2026" is
 *    a real and common name across many cities.
 */
export function isDuplicate(a: RawHackathon, b: RawHackathon): DuplicateVerdict {
  const reasons: string[] = [];
  let score = 0;

  // Two distinct listings on the same platform are two distinct events. A single
  // source assigning its own id to both means they are separate entries, whatever
  // their titles look like — many colleges run several similarly named events.
  if (a.source === b.source && a.sourceRecordId !== b.sourceRecordId) {
    return { duplicate: false, score: 0, reasons: ['different listings on the same source'] };
  }

  const ua = urlIdentity(a.registrationUrl ?? a.sourceUrl);
  const ub = urlIdentity(b.registrationUrl ?? b.sourceUrl);
  if (ua && ub && ua === ub) {
    return { duplicate: true, score: 1, reasons: [`identical event URL (${ua})`] };
  }

  const tSim = titleSimilarity(a.title, b.title);
  const oSim = organizerSimilarity(a.organizer, b.organizer);
  const sameCountry = (a.country ?? '').toLowerCase() === (b.country ?? '').toLowerCase();
  const sameCity = normalizeKey(a.city ?? '') === normalizeKey(b.city ?? '') && normalizeKey(a.city ?? '') !== '';
  const bothOnline = a.onlineOrOffline === 'online' && b.onlineOrOffline === 'online';
  const samePlace = sameCity || (sameCountry && (bothOnline || (!a.city && !b.city)));
  const startDelta = daysBetween(a.hackathonStart?.iso, b.hackathonStart?.iso);
  const regDelta = daysBetween(a.registrationDeadline?.iso, b.registrationDeadline?.iso);

  if (tSim >= 0.9) { score += 0.5; reasons.push(`title similarity ${tSim.toFixed(2)}`); }
  else if (tSim >= 0.75) { score += 0.35; reasons.push(`title similarity ${tSim.toFixed(2)}`); }
  else if (tSim >= 0.55) { score += 0.2; reasons.push(`title similarity ${tSim.toFixed(2)}`); }
  else if (tSim >= 0.35) { score += 0.08; }

  if (oSim >= 0.85) { score += 0.25; reasons.push(`organizer similarity ${oSim.toFixed(2)}`); }
  else if (oSim >= 0.6) { score += 0.12; }

  if (samePlace) { score += 0.2; reasons.push('same event location'); }

  if (startDelta !== null && startDelta <= 2) { score += 0.2; reasons.push('event start within 2 days'); }
  else if (regDelta !== null && regDelta <= 1) { score += 0.15; reasons.push('registration deadline within 1 day'); }

  // A generic title alone must not merge two different cities' events.
  const generic = normalizeTitle(a.title).length <= 3;
  if (generic && !samePlace) score = Math.min(score, 0.5);

  const duplicate = score >= 0.75;
  return { duplicate, score, reasons };
}

export interface MergedDeadline<T = string> {
  value: T | null;
  /** Sources that reported a value for this field. */
  reports: Array<{ source: SourceId; value: string; sourceUrl: string }>;
  conflict: boolean;
  chosenSource: SourceId | null;
}

export interface MergeResult<T> {
  primary: T;
  members: T[];
  reasons: string[];
}

/**
 * Choose one value for a field across several sources.
 *
 * `trust` orders sources by authority (official organizer page beats a
 * directory listing). When the highest-trust source is uniquely best its value
 * wins; when sources of comparable authority disagree the field is marked as a
 * conflict instead of being silently chosen.
 */
export function reconcile<T>(
  reports: Array<{ value: T | null | undefined; source: SourceId; sourceUrl: string }>,
  trust: Record<SourceId, number>,
): MergedDeadline<T> {
  const present = reports.filter((r) => r.value !== null && r.value !== undefined && String(r.value).length > 0);
  if (present.length === 0) {
    return { value: null, reports: [], conflict: false, chosenSource: null };
  }
  const distinct = new Map<string, { value: T; source: SourceId; sourceUrl: string; trust: number }>();
  for (const r of present) {
    const key = String(r.value);
    const existing = distinct.get(key);
    const t = trust[r.source] ?? 0;
    if (!existing || t > existing.trust) {
      distinct.set(key, { value: r.value as T, source: r.source, sourceUrl: r.sourceUrl, trust: t });
    }
  }
  const values = [...distinct.values()];
  if (values.length === 1) {
    return {
      value: values[0].value,
      reports: present.map((r) => ({ source: r.source, value: String(r.value), sourceUrl: r.sourceUrl })),
      conflict: false,
      chosenSource: values[0].source,
    };
  }
  values.sort((a, b) => b.trust - a.trust);
  const top = values[0];
  const runnerUp = values[1];
  if (top.trust > runnerUp.trust) {
    return {
      value: top.value,
      reports: present.map((r) => ({ source: r.source, value: String(r.value), sourceUrl: r.sourceUrl })),
      conflict: false,
      chosenSource: top.source,
    };
  }
  return {
    value: top.value,
    reports: present.map((r) => ({ source: r.source, value: String(r.value), sourceUrl: r.sourceUrl })),
    conflict: true,
    chosenSource: null,
  };
}

/** Group records that refer to the same event using union-find. */
export function groupDuplicates<T extends RawHackathon>(records: T[]): T[][] {
  const parent = records.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      if (records[i].source === records[j].source) continue; // same source: distinct events
      if (isDuplicate(records[i], records[j]).duplicate) union(i, j);
    }
  }
  const buckets = new Map<number, T[]>();
  records.forEach((rec, i) => {
    const root = find(i);
    const list = buckets.get(root) ?? [];
    list.push(rec);
    buckets.set(root, list);
  });
  return [...buckets.values()];
}

/** Deterministic, human-readable URL slug. */
export function slugify(input: string, fallback = 'hackathon'): string {
  const base = normalizeKey(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return base || fallback;
}
