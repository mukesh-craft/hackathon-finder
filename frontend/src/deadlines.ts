/**
 * Deadline presentation.
 *
 * The API returns the source's own wording as an ISO string that carries its
 * UTC offset, plus the source's timezone label ("IST", "EDT", "UTC+05:30").
 * These helpers render the instant in the source's own wall-clock terms and,
 * separately, in the viewer's local terms — never conflating the two.
 */
import { countdownTo, guessPrecision, type Hackathon } from '@hf/shared';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function offsetMinutesFromIso(iso: string): number | null {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Render "29 September 2026, 11:59 PM IST" from the stored value.
 * A date-only value renders as "29 September 2026 — time not specified".
 */
export function renderSourceDeadline(h: Pick<Hackathon, 'registrationDeadline' | 'registrationDeadlineTimezone'>): {
  main: string;
  tzLabel: string | null;
  timeNotSpecified: boolean;
} {
  const iso = h.registrationDeadline;
  if (!iso) return { main: 'Not specified', tzLabel: null, timeNotSpecified: true };
  if (guessPrecision(iso) === 'date_only') {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return { main: 'Not specified', tzLabel: null, timeNotSpecified: true };
    return { main: `${d} ${MONTHS[m - 1]} ${y} — time not specified`, tzLabel: h.registrationDeadlineTimezone, timeNotSpecified: true };
  }
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return { main: 'Not specified', tzLabel: null, timeNotSpecified: true };
  const offset = offsetMinutesFromIso(iso);
  // Shift the instant by its own offset so UTC getters read the source wall-clock.
  const shifted = offset === null ? instant : new Date(instant.getTime() + offset * 60_000);
  const d = offset === null ? instant.getUTCDate() : shifted.getUTCDate();
  const mo = offset === null ? instant.getUTCMonth() : shifted.getUTCMonth();
  const y = offset === null ? instant.getUTCFullYear() : shifted.getUTCFullYear();
  let hh = offset === null ? instant.getUTCHours() : shifted.getUTCHours();
  const mm = offset === null ? instant.getUTCMinutes() : shifted.getUTCMinutes();
  const suffix = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 === 0 ? 12 : hh % 12;
  return {
    main: `${d} ${MONTHS[mo]} ${y}, ${hh}:${String(mm).padStart(2, '0')} ${suffix}`,
    tzLabel: friendlyTzLabel(h.registrationDeadlineTimezone, offset),
    timeNotSpecified: false,
  };
}

/**
 * Render "IST" instead of "UTC+05:30": +05:30 year-round is India/Sri Lanka,
 * and this product's sources write it for Indian events. Only offsets with an
 * unambiguous mapping are translated; anything else keeps its UTC form rather
 * than risking a wrong abbreviation (e.g. -04:00 could be EDT or AST).
 */
export function friendlyTzLabel(stored: string | null | undefined, offsetMinutes: number | null): string | null {
  if (stored && !/^UTC[+-]\d{2}:?\d{2}$/.test(stored)) return stored;
  if (offsetMinutes === 330) return 'IST';
  if (offsetMinutes === 0) return 'UTC';
  if (stored) return stored;
  return offsetMinutes !== null ? formatOffset(offsetMinutes) : null;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** "29 Sep 2026, 11:59 PM IST (your time: 29 Sep, 6:29 PM)". Empty when unknown. */
export function renderLocalEquivalent(iso: string | null): string {
  if (!iso || guessPrecision(iso) === 'date_only') return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  try {
    const local = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(instant);
    return `your time: ${local}`;
  } catch {
    return '';
  }
}

export interface DeadlineView {
  status: Hackathon['registrationStatus'];
  main: string;
  tzLabel: string | null;
  local: string;
  countdown: string;
  expired: boolean;
  urgency: 'none' | 'critical' | 'soon' | 'comfortable' | 'unknown';
  /** Shown when the stored deadline is an inference, not a published fact. */
  inferenceNote: string | null;
}

export function deadlineView(h: Hackathon, now: Date = new Date()): DeadlineView {
  const rendered = renderSourceDeadline(h);
  const cd = countdownTo(h.registrationDeadline, now);
  return {
    status: h.registrationStatus,
    main: rendered.main,
    tzLabel: rendered.tzLabel,
    local: renderLocalEquivalent(h.registrationDeadline),
    countdown: cd.label,
    expired: cd.expired,
    urgency: cd.urgency,
    inferenceNote:
      h.registrationDeadlineBasis === 'inferred_from_submission_deadline'
        ? 'Devpost publishes one submission deadline; registration closes at the same time.'
        : null,
  };
}

export function formatPrize(amount: number | null, currency: string | null): string {
  if (amount === null || amount === undefined) return 'Not specified';
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  return `${symbol}${amount.toLocaleString('en-IN')}${currency && !symbol ? ` ${currency}` : ''}`;
}

export function formatTeamSize(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return min === max ? `${min}` : `${min}–${max}`;
  if (max !== null) return `up to ${max}`;
  if (min !== null) return `from ${min}`;
  return 'Not specified';
}
