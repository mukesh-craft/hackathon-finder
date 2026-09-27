import { describe, expect, it } from 'vitest';
import { computeDataQuality, nextVerificationAt } from '../src/services/quality.js';
import type { ExtractedDate } from '@hf/shared';

function extracted(over: Partial<ExtractedDate> = {}): ExtractedDate {
  return {
    iso: '2026-09-29T23:59:00+05:30',
    kind: 'registration_deadline',
    precision: 'instant',
    sourceTimezone: 'IST',
    offsetMinutes: 330,
    raw: '29 Sep 2026, 11:59 PM IST',
    label: 'Registration Deadline',
    confidence: 'verified',
    ...over,
  };
}

describe('computeDataQuality', () => {
  it('grades a structured platform deadline as verified', () => {
    const v = computeDataQuality({
      registrationDeadline: extracted(),
      source: 'unstop',
      deadlineInferred: false,
      deadlineConflict: false,
      populatedFieldCount: 12,
    });
    expect(v.dataQuality).toBe('verified');
  });

  it('grades a date-only deadline as source_confirmed', () => {
    const v = computeDataQuality({
      registrationDeadline: extracted({ iso: '2026-09-29', precision: 'date_only', confidence: 'source_confirmed' }),
      source: 'unstop',
      deadlineInferred: false,
      deadlineConflict: false,
      populatedFieldCount: 12,
    });
    expect(v.dataQuality).toBe('source_confirmed');
  });

  it('grades an inferred deadline as partially_verified', () => {
    const v = computeDataQuality({
      registrationDeadline: extracted({ confidence: 'inferred' }),
      source: 'devpost',
      deadlineInferred: true,
      deadlineConflict: false,
      populatedFieldCount: 10,
    });
    expect(v.dataQuality).toBe('partially_verified');
    expect(v.reasons.join(' ')).toMatch(/inferred/i);
  });

  it('grades a deadline conflict as partially_verified', () => {
    const v = computeDataQuality({
      registrationDeadline: extracted(),
      source: 'unstop',
      deadlineInferred: false,
      deadlineConflict: true,
      populatedFieldCount: 12,
    });
    expect(v.dataQuality).toBe('partially_verified');
  });

  it('grades a missing deadline as unknown — never upgraded by other fields', () => {
    const v = computeDataQuality({
      registrationDeadline: null,
      source: 'mlh',
      deadlineInferred: false,
      deadlineConflict: false,
      populatedFieldCount: 20,
    });
    expect(v.dataQuality).toBe('unknown');
  });
});

describe('nextVerificationAt — refresh policy', () => {
  const now = new Date('2026-09-26T12:00:00Z');

  it('refreshes hourly when the deadline is within 2 days', () => {
    const next = nextVerificationAt({ status: 'open', deadlineIso: '2026-09-27T23:59:00+05:30', eventStartIso: null, now });
    expect(next.getTime() - now.getTime()).toBe(3_600_000);
  });

  it('refreshes every 3 hours when the deadline is within a week', () => {
    const next = nextVerificationAt({ status: 'open', deadlineIso: '2026-09-30T00:00:00+05:30', eventStartIso: null, now });
    expect(next.getTime() - now.getTime()).toBe(3 * 3_600_000);
  });

  it('backs off to weekly once the deadline has passed', () => {
    const next = nextVerificationAt({ status: 'closed', deadlineIso: '2026-09-20T00:00:00+05:30', eventStartIso: null, now });
    expect(next.getTime() - now.getTime()).toBe(7 * 86_400_000);
  });

  it('rechecks unknown-deadline records every 2 days', () => {
    const next = nextVerificationAt({ status: 'unknown', deadlineIso: null, eventStartIso: null, now });
    expect(next.getTime() - now.getTime()).toBe(2 * 86_400_000);
  });

  it('watches an upcoming event start twice daily', () => {
    const next = nextVerificationAt({ status: 'unknown', deadlineIso: null, eventStartIso: '2026-09-29T00:00:00Z', now });
    expect(next.getTime() - now.getTime()).toBe(12 * 3_600_000);
  });
});
