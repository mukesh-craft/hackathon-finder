/**
 * Data-quality grading and refresh scheduling.
 *
 * The grade is derived from how a value was obtained, not from how complete the
 * record looks. A record with an explicit registration deadline published by the
 * event's own platform is `verified`; one whose deadline was inferred from a
 * submission window is `partially_verified`; one with no deadline at all is
 * `unknown` regardless of how many other fields it has.
 */
import type { DataQuality, ExtractedDate, RegistrationStatus, SourceId } from '@hf/shared';
import { SOURCE_TRUST } from '@hf/shared';

export interface QualityInput {
  registrationDeadline: ExtractedDate | null;
  source: SourceId;
  /** True when the deadline value was derived rather than published. */
  deadlineInferred: boolean;
  /** True when sources disagree about the deadline. */
  deadlineConflict: boolean;
  /** Number of populated, provenance-tracked fields. */
  populatedFieldCount: number;
  organizer?: string | null;
  city?: string | null;
  onlineOrOffline?: string | null;
}

export interface QualityVerdict {
  dataQuality: DataQuality;
  reasons: string[];
}

export function computeDataQuality(input: QualityInput): QualityVerdict {
  const reasons: string[] = [];

  if (input.deadlineConflict) {
    return {
      dataQuality: 'partially_verified',
      reasons: ['Sources disagree about the registration deadline; shown with a conflict warning.'],
    };
  }

  const deadline = input.registrationDeadline;
  if (!deadline) {
    if (input.populatedFieldCount >= 6) {
      reasons.push('No registration deadline is published by the source.');
      return { dataQuality: 'unknown', reasons };
    }
    return { dataQuality: 'unknown', reasons: ['Very little information is published for this event.'] };
  }

  if (input.deadlineInferred || deadline.confidence === 'inferred') {
    reasons.push('Registration deadline is inferred from the source\'s submission deadline, not published as a registration deadline.');
    return { dataQuality: 'partially_verified', reasons };
  }

  if (deadline.confidence === 'unknown' || deadline.kind === 'unknown') {
    reasons.push('The deadline text was too ambiguous to classify.');
    return { dataQuality: 'partially_verified', reasons };
  }

  const trust = SOURCE_TRUST[input.source] ?? 0;
  const structured = deadline.precision === 'instant' && deadline.confidence === 'verified';
  if (trust >= 4 && structured) {
    reasons.push(`Registration deadline published as a structured field by ${input.source}.`);
    return { dataQuality: 'verified', reasons };
  }
  if (trust >= 4) {
    reasons.push(`Registration deadline published by ${input.source} as a date without an explicit time.`);
    return { dataQuality: 'source_confirmed', reasons };
  }
  reasons.push(`Registration deadline read from a ${input.source} page.`);
  return { dataQuality: 'partially_verified', reasons };
}

export interface RefreshPolicyInput {
  status: RegistrationStatus;
  deadlineIso: string | null;
  eventStartIso: string | null;
  now?: Date;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * How soon this record should be re-checked.
 * Open and imminent records refresh fastest; finished events are left alone.
 */
export function nextVerificationAt(input: RefreshPolicyInput): Date {
  const now = input.now ?? new Date();

  if (input.deadlineIso) {
    const deadline = new Date(input.deadlineIso);
    const ms = deadline.getTime() - now.getTime();
    if (!Number.isNaN(ms)) {
      if (ms <= 0) return new Date(now.getTime() + 7 * DAY);            // closed: weekly
      if (ms <= 2 * DAY) return new Date(now.getTime() + HOUR);         // <2 days: hourly
      if (ms <= 7 * DAY) return new Date(now.getTime() + 3 * HOUR);     // <7 days: every 3h
      if (ms <= 30 * DAY) return new Date(now.getTime() + 12 * HOUR);   // <30 days: twice a day
      return new Date(now.getTime() + DAY);                             // open, far away: daily
    }
  }

  if (input.eventStartIso) {
    const start = new Date(input.eventStartIso).getTime();
    if (!Number.isNaN(start)) {
      const until = start - now.getTime();
      if (until > 0 && until <= 7 * DAY) return new Date(now.getTime() + 12 * HOUR);
      if (until > 0) return new Date(now.getTime() + 2 * DAY);
    }
  }

  switch (input.status) {
    case 'open':
      return new Date(now.getTime() + DAY);
    case 'upcoming':
      return new Date(now.getTime() + 12 * HOUR);
    case 'closed':
      return new Date(now.getTime() + 7 * DAY);
    default:
      return new Date(now.getTime() + 2 * DAY);
  }
}
