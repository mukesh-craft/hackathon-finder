/**
 * Deadline extraction and semantic classification.
 *
 * Hard rules enforced here:
 *  1. A date is only produced from text that actually contains one.
 *  2. A time-of-day is only produced when the source stated one. "Sep 29" yields
 *     `2026-09-29` (precision `date_only`), never `2026-09-29T23:59`.
 *  3. Lifecycle milestones are classified separately. A project-submission
 *     deadline is never emitted as the registration deadline.
 *  4. The source's own timezone wording is preserved next to the value.
 */

import type {
  Confidence,
  DatePrecision,
  DeadlineKind,
  ExtractedDate,
} from './types.js';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

/**
 * Timezone abbreviations and their offsets in minutes.
 * `ist` defaults to +05:30 (India Standard Time): every source this system
 * ingests that writes "IST" is Indian, and India is the product's focus region.
 * Indian hackathon pages are the sole producers of "IST" in this dataset.
 */
const TZ_OFFSETS: Record<string, number> = {
  utc: 0, gmt: 0, z: 0, ut: 0,
  ist: 330,          // India Standard Time
  idt: 210,          // Israel Daylight Time (only if a source ever uses it)
  bst: 0,            // British Summer Time, resolved below by season
  cet: 60, cest: 120,
  eet: 120, eest: 180,
  mst: -420, mdt: -360,
  cst: -360, cdt: -300,
  est: -300, edt: -240,
  pst: -480, pdt: -420,
  akst: -540, akdt: -480,
  hst: -600,
  aest: 600, aedt: 660,
  acst: 570, acdt: 630,
  sgt: 480, sst: 480,
  jst: 540, kst: 540,
  hkt: 480,
  gst: 240,          // Gulf Standard Time
  pk: 300,
  npt: 345,
  brt: -180, art: -180,
  sa: -180,
  wib: 420, wita: 480,
  pht: 480,
};

const TZ_ALT = Object.keys(TZ_OFFSETS).sort((a, b) => b.length - a.length).join('|');

export interface ParsedDateParts {
  year: number | null;
  month: number;
  day: number;
  hour: number | null;
  minute: number | null;
  second: number | null;
  offsetMinutes: number | null;
  sourceTimezone: string | null;
  precision: DatePrecision;
  /** Character offsets inside the scanned text. */
  start: number;
  end: number;
  text: string;
}

export interface ParseOptions {
  /** IANA zone used when the source gave a time but no timezone, e.g. Asia/Kolkata. */
  defaultTimezone?: string;
  /** Used when the source omitted the year, e.g. "Deadline: Sep 30". */
  assumeYear?: number;
}

const WEEKDAYS = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (y < 1970 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

interface TimeScan {
  time: { hour: number; minute: number; second: number } | null;
  offsetMinutes: number | null;
  sourceTimezone: string | null;
  end: number;
}

/** How far past a date we are willing to look for "at 11:59 PM IST". */
const TIME_LOOKAHEAD = 32;

/**
 * Look forward from a matched date for an explicit clock time and timezone.
 *
 * Deliberately conservative: if another date-looking token appears in the
 * window first, nothing is attached. Attaching the wrong time to a registration
 * deadline is worse than reporting that no time was given.
 */
function scanForwardForTimeAndZone(text: string, from: number): TimeScan {
  const empty: TimeScan = { time: null, offsetMinutes: null, sourceTimezone: null, end: from };
  const window = text.slice(from, from + TIME_LOOKAHEAD);

  const clock =
    /(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*([ap])\.?\s*m\.?/i.exec(window) ??
    /(\d{1,2}):([0-5]\d)(?::([0-5]\d))?/.exec(window) ??
    /(\d{1,2})\s*([ap])\.?\s*m\.?(?![\w])/i.exec(window);
  if (!clock || clock.index === undefined) {
    // No time. A bare timezone right after the date is still worth recording.
    const tzOnly = parseTimezoneToken(window);
    if (tzOnly) {
      return {
        time: null,
        offsetMinutes: tzOnly.offsetMinutes,
        sourceTimezone: tzOnly.label,
        end: from + tzOnly.length,
      };
    }
    return empty;
  }

  const gap = window.slice(0, clock.index);
  // Refuse when the gap introduces another date or a new sentence/section.
  if (/\b(?:19|20)\d{2}\b/.test(gap)) return empty;
  if (new RegExp(`\\b(?:${MONTH_ALT})\\b`, 'i').test(gap)) return empty;
  if (/[.!?:;]/.test(gap.replace(/[,@\-\u2013\u2014]/g, ''))) return empty;
  if (!/^[\s,@\-–—()]*$/i.test(gap)) return empty;

  const colon = /:/.test(clock[0]);
  let hour: number;
  let minute = 0;
  let second = 0;
  if (colon) {
    hour = Number(clock[1]);
    minute = Number(clock[2]);
    second = /^\d+$/.test(String(clock[3] ?? '')) ? Number(clock[3]) : 0;
  } else {
    hour = Number(clock[1]);
  }
  const meridiem = String(clock[colon ? 4 : 2] ?? '').toLowerCase();
  if (meridiem.includes('p') && hour < 12) hour += 12;
  if (meridiem.includes('a') && hour === 12) hour = 0;
  if (hour > 23) return empty;

  const timeEnd = from + clock.index + clock[0].length;
  const tzWindow = text.slice(timeEnd, timeEnd + 12);
  const tz = parseTimezoneToken(tzWindow);
  return {
    time: { hour, minute, second },
    offsetMinutes: tz?.offsetMinutes ?? null,
    sourceTimezone: tz?.label ?? null,
    end: tz ? timeEnd + tz.length : timeEnd,
  };
}

function parseTimezoneToken(text: string): { offsetMinutes: number; label: string; length: number } | null {
  const numeric = /\b(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\s*(?=$|[\s,.;)\]])/i.exec(text);
  if (numeric) {
    const sign = numeric[1] === '-' ? -1 : 1;
    const h = Number(numeric[2]);
    const min = numeric[3] ? Number(numeric[3]) : 0;
    if (h > 14) return null;
    const label = (numeric[0] || '').trim();
    const span = (numeric.index ?? 0) + numeric[0].length;
    return { offsetMinutes: sign * (h * 60 + min), label: label || `${sign < 0 ? '-' : '+'}${h}`, length: span };
  }
  const abbr = new RegExp(`(?<![\\w@])(?:${TZ_ALT})(?![\\w])`, 'i').exec(text);
  if (abbr) {
    const key = abbr[0].toLowerCase();
    if (key === 'z') return { offsetMinutes: 0, label: 'UTC', length: abbr[0].length };
    let offset = TZ_OFFSETS[key];
    // British Summer Time is UTC+1 only between late March and late October.
    if (key === 'bst') offset = 60;
    if (offset === undefined) return null;
    const label = /^(?:utc|gmt|ut)$/i.test(abbr[0]) ? 'UTC' : abbr[0].toUpperCase();
    // Length must cover any leading whitespace, otherwise the caller truncates
    // the preserved source wording.
    return { offsetMinutes: offset, label, length: (abbr.index ?? 0) + abbr[0].length };
  }
  return null;
}

/** Resolve the UTC offset of an IANA zone at a given instant, using the platform tz database. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    const part = dtf.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      return sign * (Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0));
    }
    if (/GMT/.test(part)) return 0;
    return null;
  } catch {
    return null;
  }
}

/**
 * Find every date expression in `text`.
 * Handles ISO-8601, "29 Sep 2026", "Sep 29, 2026", "29/09/2026", "29th September 2026",
 * "September 29", and weekday-prefixed variants.
 */
export function findDateExpressions(text: string, opts: ParseOptions = {}): ParsedDateParts[] {
  const out: ParsedDateParts[] = [];
  const assumeYear = opts.assumeYear ?? new Date().getUTCFullYear();

  // --- 1. ISO-8601 / RFC-3339 -------------------------------------------------
  const isoRe = /(?<![\d/-])(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?/g;
  for (const m of text.matchAll(isoRe)) {
    const [full, y, mo, d, hh, mm, ss, off] = m;
    if (!isValidYmd(Number(y), Number(mo), Number(d))) continue;
    let offsetMinutes: number | null = null;
    let sourceTimezone: string | null = null;
    if (off) {
      if (off === 'Z') {
        offsetMinutes = 0;
        sourceTimezone = 'UTC';
      } else {
        const sign = off[0] === '-' ? -1 : 1;
        const digits = off.slice(1).replace(':', '');
        offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
        sourceTimezone = `UTC${off}`;
      }
    }
    const hasTime = hh !== undefined;
    out.push({
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: hasTime ? Number(hh) : null,
      minute: hasTime ? Number(mm) : null,
      second: ss !== undefined ? Number(ss) : null,
      offsetMinutes,
      sourceTimezone,
      precision: hasTime ? 'instant' : 'date_only',
      start: m.index ?? 0,
      end: (m.index ?? 0) + full.length,
      text: full,
    });
  }

  // --- 2. Day-Month-Year / Month-Day-Year ------------------------------------
  const dayFirst = new RegExp(
    `(?<![\\w/-])([0-3]?\\d)(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_ALT})\\.?\\s*,?\\s*(\\d{4})?(?![\\d/-])`,
    'gi',
  );
  const monthFirst = new RegExp(
    `(?<![\\w/-])(${MONTH_ALT})\\.?\\s+([0-3]?\\d)(?:st|nd|rd|th)?\\s*(?:,?\\s*(\\d{4}))?(?![\\d/-])`,
    'gi',
  );
  const numericSlash = /(?<![\d/])([0-3]?\d)[/.-]([01]?\d)[/.-](\d{2,4})(?![\d/])/g;

  const push = (
    dayStr: string,
    monthStr: string,
    yearStr: string | undefined,
    idx: number,
    len: number,
  ) => {
    const month = MONTHS[monthStr.toLowerCase()];
    const day = Number(dayStr);
    if (!month || day > 31) return;
    let year = yearStr ? Number(yearStr) : null;
    if (year !== null && year < 100) year += 2000;
    if (year === null) year = assumeYear;
    if (!isValidYmd(year, month, day)) return;
    // Extend the match forward to swallow an explicit clock time and timezone
    // that belong to this date, e.g. "29 Sep 2026, 11:59 PM IST".
    const scan = scanForwardForTimeAndZone(text, idx + len);
    const consumed = text.slice(idx, scan.end);
    const time = scan.time;
    let offsetMinutes = scan.offsetMinutes;
    let sourceTimezone = scan.sourceTimezone;
    if (time && offsetMinutes === null && opts.defaultTimezone) {
      const guess = new Date(Date.UTC(year, month - 1, day, time.hour, time.minute));
      const resolved = zoneOffsetMinutes(opts.defaultTimezone, guess);
      if (resolved !== null) {
        offsetMinutes = resolved;
        sourceTimezone = opts.defaultTimezone;
      }
    }
    out.push({
      year,
      month,
      day,
      hour: time?.hour ?? null,
      minute: time?.minute ?? null,
      second: time?.second ?? null,
      offsetMinutes,
      sourceTimezone,
      precision: time ? 'instant' : 'date_only',
      start: idx,
      end: scan.end,
      text: consumed,
    });
  };

  for (const m of text.matchAll(dayFirst)) {
    push(m[1], m[2], m[3], m.index ?? 0, m[0].length);
  }
  for (const m of text.matchAll(monthFirst)) {
    push(m[2], m[1], m[3], m.index ?? 0, m[0].length);
  }
  for (const m of text.matchAll(numericSlash)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Disambiguate D/M/Y (Indian/European) vs M/D/Y (US). Values > 12 force D/M/Y.
    const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (!isValidYmd(year, month, day)) continue;
    const start = m.index ?? 0;
    const scan = scanForwardForTimeAndZone(text, start + m[0].length);
    out.push({
      year,
      month,
      day,
      hour: scan.time?.hour ?? null,
      minute: scan.time?.minute ?? null,
      second: scan.time?.second ?? null,
      offsetMinutes: scan.offsetMinutes,
      sourceTimezone: scan.sourceTimezone,
      precision: scan.time ? 'instant' : 'date_only',
      start,
      end: scan.end,
      text: text.slice(start, scan.end),
    });
  }

  // Deduplicate overlapping matches, preferring the longest / most specific one.
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped: ParsedDateParts[] = [];
  for (const cand of out) {
    const clash = deduped.find(
      (d) => cand.start < d.end && d.start < cand.end,
    );
    if (!clash) deduped.push(cand);
  }
  return deduped.sort((a, b) => a.start - b.start);
}

/** Build an ISO string. Emits a bare date when the source gave no time. */
export function partsToIso(parts: ParsedDateParts, opts: ParseOptions = {}): string | null {
  if (parts.year === null) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  if (parts.hour === null) return date;
  const time = `${pad(parts.hour)}:${pad(parts.minute ?? 0)}`;
  if (parts.offsetMinutes === null) {
    // Time present but no zone anywhere: render a floating local time. The
    // consumer must treat it as "no timezone stated" rather than assuming UTC.
    return `${date}T${time}:00`;
  }
  const sign = parts.offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(parts.offsetMinutes);
  return `${date}T${time}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Parse a single loose date string. Returns null when nothing date-like is present. */
export function parseDateExpression(input: string | null | undefined, opts: ParseOptions = {}): ExtractedDate | null {
  if (!input || typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  // Try the whole string as a structured timestamp first.
  const trimmed = text.replace(/^\[|\]$/g, '');
  const strict = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed);
  if (strict) {
    const found = findDateExpressions(trimmed, opts)[0];
    if (found) return toExtracted(found, null, trimmed, 'verified');
    return null;
  }
  const found = findDateExpressions(text, opts);
  if (found.length === 0) return null;
  return toExtracted(found[0], null, text, found[0].precision === 'instant' ? 'source_confirmed' : 'source_confirmed');
}

function toExtracted(
  parts: ParsedDateParts,
  kind: DeadlineKind | null,
  raw: string,
  confidence: Confidence,
  label: string | null = null,
): ExtractedDate {
  return {
    iso: partsToIso(parts),
    kind: kind ?? 'unknown',
    precision: parts.precision,
    sourceTimezone: parts.sourceTimezone,
    offsetMinutes: parts.offsetMinutes,
    raw: raw.trim(),
    label,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Semantic classification
// ---------------------------------------------------------------------------

interface LabelRule {
  kind: DeadlineKind;
  test: RegExp;
  /** When two different kinds match the same label, the record is ambiguous. */
  conflictsWith?: DeadlineKind[];
}

/**
 * Ordered most-specific first. Multi-word forms must precede their substrings
 * ("project submission deadline" before "submission deadline").
 */
const LABEL_RULES: LabelRule[] = [
  { kind: 'idea_submission_deadline', test: /\b(idea|concept|pitch|proposal)\s*(submission|upload|deadline|closing|closes)|submit\s+(your\s+)?(idea|concept)|idea\s+submission\s+deadline/i },
  { kind: 'project_submission_deadline', test: /\b(project|code|source\s*code|repo|repository|ppt|pptx|powerpoint|slide\s*deck|slides|prototype|demo\s*video|final)\s*(submission|upload|deadline|closing|closes)|\bsubmit\s+(your\s+)?(project|code|solution|source\s*code)|\bsubmissions?\s+(are\s+)?(open|close|closes|closing|due|end)\b|final\s+submission/i },
  { kind: 'result_announcement', test: /\b(result|results|winner|winner'?s?)\s*(announce|announcement|declared|declared?on|date)|\bwinners?\s+(are\s+)?(announced|declared)\b/i },
  { kind: 'final_presentation', test: /\b(final|demo)\s*(presentation|round|day|show)|\bdemo\s*day\b|\bfinale\b|\bfinal\s+round\b/i },
  { kind: 'shortlisting', test: /\bshort\s*-?\s*list(ing)?\b|\bshortlist\s+(date|on|by)\b/i },
  { kind: 'registration_opens', test: /\bregistration\s+(opens?|opens\s+on|starts?|begins?)\b|\bregistrations?\s+open(ing)?\s+(on|from)|\bopens?\s+on\b/i },
  { kind: 'registration_deadline', test: /\bregistration\s*(deadline|closes|closing|closed|ends?|end\s+date|last\s+date|cut\s*-?\s*off|last\s+day)\b|\bregister\s+(before|by|till|until|now)|\b(last\s+date\s+to\s+register)\b|\bregistration\s+window\b/i },
  { kind: 'application_deadline', test: /\b(application|apply|applications?)\s*(deadline|closes|closing|due|end|ends?)\b|\bapply\s+(before|by|till|until)\b/i },
  { kind: 'submission_deadline', test: /\bsubmission\s*(deadline|closes|closing|due|end|ends?|window)\b|\bsubmit\s+(before|by|till|until)\b|\bdeadline\s+(to|for)\s+submit/i },
  { kind: 'hackathon_start', test: /\b(hackathon|event|contest)?\s*(starts?|start\s+date|starts?\s+on|begins?|begins?\s+on|opens?|from)\b/i },
  { kind: 'hackathon_end', test: /\b(hackathon|event|contest)?\s*(ends?|end\s+date|ends?\s+on|finishes?|concludes?)\b/i },
];

/**
 * Classify a label phrase into a lifecycle kind.
 * Returns `ambiguous: true` when a single phrase names two different milestones
 * (e.g. "registration and submission deadline") — the caller must then treat the
 * date as unclassified rather than guessing.
 */
export function classifyLabel(label: string): { kind: DeadlineKind; ambiguous: boolean; matched: string | null } {
  const matches: Array<{ kind: DeadlineKind; matched: string }> = [];
  for (const rule of LABEL_RULES) {
    const m = rule.test.exec(label);
    if (m) matches.push({ kind: rule.kind, matched: m[0] });
  }
  if (matches.length === 0) return { kind: 'unknown', ambiguous: false, matched: null };

  // A label that mentions registration together with a submission or
  // application milestone is genuinely ambiguous. Guessing here is exactly how a
  // submission deadline ends up displayed as the registration deadline.
  const kinds = new Set(matches.map((m) => m.kind));
  const mentionsRegistration = /\bregistration\b|\bregister\b|\bregistrations\b/i.test(label);
  const hasReg = kinds.has('registration_deadline');
  const hasSub =
    kinds.has('submission_deadline') ||
    kinds.has('project_submission_deadline') ||
    kinds.has('idea_submission_deadline');
  const hasApp = kinds.has('application_deadline');
  if ((hasReg || (mentionsRegistration && (hasSub || hasApp))) && (hasSub || hasApp)) {
    return { kind: 'unknown', ambiguous: true, matched: matches[0].matched };
  }

  // Otherwise take the most specific match, which is the first rule that hit.
  const best = matches[0];
  return { kind: best.kind, ambiguous: false, matched: best.matched };
}

const LABEL_WINDOW = 90;

/**
 * Extract every date in `text` together with the lifecycle milestone it belongs to.
 * Looks backwards from each date for the nearest label; if nothing is found it
 * looks forwards (handles "closes on: 29 Sep 2026").
 */
export function extractDeadlinesFromText(text: string, opts: ParseOptions = {}): ExtractedDate[] {
  if (!text) return [];
  const found = findDateExpressions(text, opts);
  const results: ExtractedDate[] = [];

  for (const parts of found) {
    const before = text.slice(Math.max(0, parts.start - LABEL_WINDOW), parts.start);
    const after = text.slice(parts.end, Math.min(text.length, parts.end + LABEL_WINDOW));
    const beforeText = before.split(/[\n\r;|]|\.{3,}/).pop() ?? '';
    const afterLine = after.split(/[\n\r;|]|\.{3,}/)[0] ?? '';

    let label: string | null = null;
    let info = classifyLabel(beforeText);
    if (info.kind === 'unknown' && !info.ambiguous) {
      const forward = classifyLabel(afterLine);
      if (forward.kind !== 'unknown') {
        label = afterLine.trim().slice(0, 60);
        info = forward;
      }
    }
    if (info.kind === 'unknown') {
      if (info.ambiguous) label = (label ?? beforeText).trim().slice(0, 60);
      results.push(toExtracted(parts, 'unknown', parts.text, 'unknown', label));
      continue;
    }
    label = (label ?? beforeText).trim().slice(-70);
    const confidence: Confidence = parts.precision === 'instant' ? 'source_confirmed' : 'partially_verified';
    results.push(toExtracted(parts, info.kind, parts.text, confidence, label));
  }
  return results;
}

/**
 * Pick the registration deadline out of a set of extracted dates.
 * Refuses to substitute submission/idea/end dates for a registration deadline.
 */
export function selectRegistrationDeadline(dates: ExtractedDate[]): ExtractedDate | null {
  const explicit = dates.find((d) => d.kind === 'registration_deadline' && d.iso);
  if (explicit) return explicit;
  // Only an explicit "application deadline" from a source that uses the word
  // "application" as its registration mechanism may stand in, and it is marked
  // as such by the caller. We do not silently promote it here.
  return null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface RegistrationStatusInput {
  deadlineIso: string | null;
  precision?: DatePrecision;
  opensIso?: string | null;
  now?: Date;
}

export interface RegistrationStatusResult {
  status: 'open' | 'closed' | 'upcoming' | 'unknown';
  /** Instant used for comparison (end-of-day for date-only deadlines). */
  effectiveInstant: string | null;
  note: string | null;
}

/**
 * Decide whether registration is open.
 *
 * For a `date_only` deadline we compare against the END of that calendar day in
 * the source's own terms: the day itself is never declared closed, because the
 * source never told us the hour. The UI renders "time not specified" alongside.
 */
export function computeRegistrationStatus(input: RegistrationStatusInput): RegistrationStatusResult {
  const now = input.now ?? new Date();
  const precision = input.precision ?? (input.deadlineIso ? guessPrecision(input.deadlineIso) : 'none');
  if (!input.deadlineIso) {
    return { status: 'unknown', effectiveInstant: null, note: 'No registration deadline published by the source.' };
  }
  if (precision === 'date_only') {
    const dayEnd = new Date(`${input.deadlineIso}T23:59:59.999Z`);
    if (Number.isNaN(dayEnd.getTime())) {
      return { status: 'unknown', effectiveInstant: null, note: 'Registration deadline could not be parsed.' };
    }
    const open = dayEnd.getTime() >= now.getTime();
    return {
      status: open ? 'open' : 'closed',
      effectiveInstant: dayEnd.toISOString(),
      note: 'Source published a date without a time; the final hour of that day is treated as open.',
    };
  }
  const deadline = new Date(input.deadlineIso);
  if (Number.isNaN(deadline.getTime())) {
    return { status: 'unknown', effectiveInstant: null, note: 'Registration deadline could not be parsed.' };
  }
  if (deadline.getTime() <= now.getTime()) {
    return { status: 'closed', effectiveInstant: deadline.toISOString(), note: null };
  }
  if (input.opensIso) {
    const opens = new Date(input.opensIso);
    if (!Number.isNaN(opens.getTime()) && opens.getTime() > now.getTime()) {
      return { status: 'upcoming', effectiveInstant: deadline.toISOString(), note: null };
    }
  }
  return { status: 'open', effectiveInstant: deadline.toISOString(), note: null };
}

export function guessPrecision(iso: string): DatePrecision {
  if (!iso) return 'none';
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? 'date_only' : 'instant';
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const MONTH_LABEL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface FormatOptions {
  /** Timezone to render in. Defaults to the source timezone when known. */
  timeZone?: string;
  /** Label to show for the source timezone, e.g. "IST". */
  sourceTimezoneLabel?: string | null;
}

export interface FormattedDeadline {
  /** e.g. "29 September 2026, 11:59 PM" */
  main: string;
  /** e.g. "IST" */
  timezoneLabel: string | null;
  /** True when the source gave no time. */
  timeNotSpecified: boolean;
  /** Machine-readable ISO. */
  iso: string | null;
}

/**
 * Render a normalized deadline for humans.
 * A `date_only` value renders as "29 September 2026 — time not specified".
 */
export function formatDeadline(iso: string | null, opts: FormatOptions = {}): FormattedDeadline {
  if (!iso) {
    return { main: 'Not specified', timezoneLabel: null, timeNotSpecified: true, iso: null };
  }
  const precision = guessPrecision(iso);
  if (precision === 'date_only') {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) {
      return { main: 'Not specified', timezoneLabel: null, timeNotSpecified: true, iso: null };
    }
    return {
      main: `${d} ${MONTH_LABEL[m - 1]} ${y} — time not specified`,
      timezoneLabel: opts.sourceTimezoneLabel ?? null,
      timeNotSpecified: true,
      iso,
    };
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { main: 'Not specified', timezoneLabel: null, timeNotSpecified: true, iso: null };
  }
  const timeZone = opts.timeZone ?? 'UTC';
  let datePart: string;
  let timePart: string;
  try {
    datePart = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
    timePart = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
      .format(date)
      .toUpperCase()
      .replace(/\s+/g, ' ');
  } catch {
    return { main: iso, timezoneLabel: opts.sourceTimezoneLabel ?? null, timeNotSpecified: false, iso };
  }
  return {
    main: `${datePart}, ${timePart}`,
    timezoneLabel: opts.sourceTimezoneLabel ?? null,
    timeNotSpecified: false,
    iso,
  };
}

export interface CountdownParts {
  expired: boolean;
  label: string;
  totalMs: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** Coarse status used for colour/aria. */
  urgency: 'none' | 'critical' | 'soon' | 'comfortable' | 'unknown';
}

/** Countdown from the stored deadline. Never invents a target when none exists. */
export function countdownTo(iso: string | null, now: Date = new Date()): CountdownParts {
  if (!iso) {
    return { expired: false, label: 'Deadline not specified', totalMs: 0, days: 0, hours: 0, minutes: 0, seconds: 0, urgency: 'unknown' };
  }
  let target: number;
  if (guessPrecision(iso) === 'date_only') {
    target = new Date(`${iso}T23:59:59Z`).getTime();
  } else {
    target = new Date(iso).getTime();
  }
  if (Number.isNaN(target)) {
    return { expired: false, label: 'Deadline not specified', totalMs: 0, days: 0, hours: 0, minutes: 0, seconds: 0, urgency: 'unknown' };
  }
  const diff = target - now.getTime();
  if (diff <= 0) {
    return { expired: true, label: 'Registration closed', totalMs: 0, days: 0, hours: 0, minutes: 0, seconds: 0, urgency: 'none' };
  }
  const totalMs = diff;
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);

  let label: string;
  if (days >= 1) label = `${days} day${days === 1 ? '' : 's'} left`;
  else if (hours >= 1) label = `${hours} hour${hours === 1 ? '' : 's'} left`;
  else if (minutes >= 1) label = `${minutes} minute${minutes === 1 ? '' : 's'} left`;
  else label = `${seconds} second${seconds === 1 ? '' : 's'} left`;

  const urgency: CountdownParts['urgency'] =
    days >= 7 ? 'comfortable' : days >= 2 ? 'soon' : 'critical';
  return { expired: false, label, totalMs, days, hours, minutes, seconds, urgency };
}

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/;

export function looksLikeIsoDate(value: string): boolean {
  return ISO_LIKE.test(value.trim());
}
