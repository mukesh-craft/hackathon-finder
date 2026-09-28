/**
 * Date extraction / classification / status tests.
 *
 * The formats in here are transcribed from the live sources this system ingests
 * (Unstop's public API, Devpost listing pages, MLH event pages) plus the
 * canonical example from the product brief.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyLabel,
  computeRegistrationStatus,
  countdownTo,
  extractDeadlinesFromText,
  formatDeadline,
  parseDateExpression,
  selectRegistrationDeadline,
} from '../src/dates.js';

describe('parseDateExpression — structured inputs', () => {
  it('parses a full ISO-8601 instant with an explicit offset (Unstop shape)', () => {
    const d = parseDateExpression('2026-09-27T23:59:00+05:30');
    expect(d).not.toBeNull();
    expect(d!.iso).toBe('2026-09-27T23:59:00+05:30');
    expect(d!.precision).toBe('instant');
  });

  it('parses Z-suffixed timestamps as UTC (normalised to a +00:00 offset)', () => {
    const d = parseDateExpression('2026-10-01T06:45:00Z');
    expect(d!.iso).toBe('2026-10-01T06:45:00+00:00');
    expect(d!.offsetMinutes).toBe(0);
    expect(d!.sourceTimezone).toBe('UTC');
  });

  it('returns null for text with no date at all', () => {
    expect(parseDateExpression('Registration deadline will be announced soon')).toBeNull();
    expect(parseDateExpression('')).toBeNull();
    expect(parseDateExpression(null)).toBeNull();
  });
});

describe('parseDateExpression — natural language', () => {
  it('parses "Registration Deadline 29 Sep 2026, 11:59 PM IST" with time and zone', () => {
    const d = parseDateExpression('Registration Deadline 29 Sep 2026, 11:59 PM IST');
    expect(d!.iso).toBe('2026-09-29T23:59:00+05:30');
    expect(d!.precision).toBe('instant');
    expect(d!.sourceTimezone).toBe('IST');
    expect(d!.offsetMinutes).toBe(330);
  });

  it('parses the Devpost display format "Sep 30, 2026 @ 11:45pm PDT"', () => {
    const d = parseDateExpression('Deadline: Sep 30, 2026 @ 11:45pm PDT');
    expect(d!.iso).toBe('2026-09-30T23:45:00-07:00');
    expect(d!.sourceTimezone).toBe('PDT');
  });

  it('does NOT invent a time when the source gives only a date', () => {
    const d = parseDateExpression('Registration closes on September 29');
    expect(d!.iso).toBe('2026-09-29');
    expect(d!.precision).toBe('date_only');
    expect(d!.iso).not.toContain('T');
  });

  it('handles a date with no year by assuming the current year', () => {
    const d = parseDateExpression('Deadline: Sep 30', { assumeYear: 2026 });
    expect(d!.iso).toBe('2026-09-30');
    expect(d!.precision).toBe('date_only');
  });

  it('handles ordinal day suffixes', () => {
    expect(parseDateExpression('29th September 2026')!.iso).toBe('2026-09-29');
    expect(parseDateExpression('1st October 2026')!.iso).toBe('2026-10-01');
  });

  it('handles 24-hour times and numeric date formats', () => {
    expect(parseDateExpression('Registration closes 2026-10-08T23:59:00+05:30')!.iso).toBe('2026-10-08T23:59:00+05:30');
    expect(parseDateExpression('Deadline 28/09/2026')!.iso).toBe('2026-09-28');
  });

  it('treats an invalid calendar date as unparseable rather than rolling over', () => {
    expect(parseDateExpression('2026-02-31')).toBeNull();
    expect(parseDateExpression('31 February 2026')).toBeNull();
  });
});

describe('classifyLabel — semantic meaning of a milestone', () => {
  it('classifies a registration deadline', () => {
    expect(classifyLabel('Registration Deadline').kind).toBe('registration_deadline');
    expect(classifyLabel('Registration closes on').kind).toBe('registration_deadline');
    expect(classifyLabel('Register before').kind).toBe('registration_deadline');
    expect(classifyLabel('Last date to register').kind).toBe('registration_deadline');
  });

  it('classifies submission milestones separately from registration', () => {
    expect(classifyLabel('Submission Deadline').kind).toBe('submission_deadline');
    expect(classifyLabel('PPT Submission').kind).toBe('project_submission_deadline');
    expect(classifyLabel('Project submission deadline').kind).toBe('project_submission_deadline');
    expect(classifyLabel('Idea submission deadline').kind).toBe('idea_submission_deadline');
    expect(classifyLabel('Source code submission closes').kind).toBe('project_submission_deadline');
  });

  it('never lets a submission label become a registration deadline', () => {
    for (const label of ['Submission Deadline', 'PPT Submission', 'Project submission', 'Idea Submission']) {
      expect(classifyLabel(label).kind).not.toBe('registration_deadline');
    }
  });

  it('classifies the remaining lifecycle milestones', () => {
    expect(classifyLabel('Registration opens').kind).toBe('registration_opens');
    expect(classifyLabel('Application deadline').kind).toBe('application_deadline');
    expect(classifyLabel('Shortlisting').kind).toBe('shortlisting');
    expect(classifyLabel('Final presentation').kind).toBe('final_presentation');
    expect(classifyLabel('Results announced').kind).toBe('result_announcement');
  });

  it('marks a phrase naming two milestones as ambiguous rather than guessing', () => {
    const v = classifyLabel('Registration and submission deadline');
    expect(v.ambiguous).toBe(true);
    expect(v.kind).toBe('unknown');
  });
});

describe('extractDeadlinesFromText — multi-milestone timelines', () => {
  const timeline = `
    Important Dates
    Registration Deadline -> 29 Sep 2026, 11:59 PM IST
    PPT Submission -> 5 Oct 2026
    Offline Round -> 24 Oct 2026
  `;

  it('finds every date in the timeline', () => {
    const found = extractDeadlinesFromText(timeline, { defaultTimezone: 'Asia/Kolkata' });
    expect(found.length).toBe(3);
  });

  it('picks 29 Sep as the registration deadline, not 5 Oct or 24 Oct', () => {
    const found = extractDeadlinesFromText(timeline, { defaultTimezone: 'Asia/Kolkata' });
    const reg = selectRegistrationDeadline(found);
    expect(reg).not.toBeNull();
    expect(reg!.iso).toBe('2026-09-29T23:59:00+05:30');
    expect(reg!.kind).toBe('registration_deadline');
  });

  it('classifies the other two dates as non-registration milestones', () => {
    const found = extractDeadlinesFromText(timeline, { defaultTimezone: 'Asia/Kolkata' });
    const byIso = new Map(found.map((d) => [d.iso, d.kind]));
    expect(byIso.get('2026-10-05')).not.toBe('registration_deadline');
    expect(byIso.get('2026-10-05')).toBe('project_submission_deadline');
    // "Offline Round" names a phase but not a deadline: it stays unclassified
    // rather than being promoted into a registration or submission deadline.
    expect(byIso.get('2026-10-24')).toBe('unknown');
    expect(byIso.get('2026-10-24')).not.toBe('registration_deadline');
  });

  it('classifies an explicitly labelled event end', () => {
    const found = extractDeadlinesFromText('Hackathon ends on 24 Oct 2026');
    expect(found[0].kind).toBe('hackathon_end');
    expect(selectRegistrationDeadline(found)).toBeNull();
  });

  it('returns no registration deadline when the source only lists submissions', () => {
    const found = extractDeadlinesFromText('Submission deadline: 5 Oct 2026. Idea submission: 1 Oct 2026.');
    expect(selectRegistrationDeadline(found)).toBeNull();
  });

  it('preserves the verbatim source wording', () => {
    const found = extractDeadlinesFromText('Registration Deadline 29 Sep 2026, 11:59 PM IST');
    expect(found[0].raw).toBe('29 Sep 2026, 11:59 PM IST');
    expect(found[0].label).toContain('Registration Deadline');
  });

  it('reads a date range and keeps the end date', () => {
    const found = extractDeadlinesFromText('Submissions: Jul 31 - Oct 01, 2026');
    const isos = found.map((d) => d.iso);
    expect(isos).toContain('2026-10-01');
  });
});

describe('computeRegistrationStatus', () => {
  const now = new Date('2026-09-26T00:00:00Z');

  it('is OPEN when the deadline is in the future', () => {
    const r = computeRegistrationStatus({ deadlineIso: '2026-09-29T23:59:00+05:30', now });
    expect(r.status).toBe('open');
  });

  it('is CLOSED when the deadline has passed', () => {
    const r = computeRegistrationStatus({ deadlineIso: '2026-09-20T23:59:00+05:30', now });
    expect(r.status).toBe('closed');
  });

  it('is UNKNOWN when no deadline was published — never guessed', () => {
    const r = computeRegistrationStatus({ deadlineIso: null, now });
    expect(r.status).toBe('unknown');
    expect(r.note).toMatch(/no registration deadline/i);
  });

  it('is UPCOMING when registration has not opened yet', () => {
    const r = computeRegistrationStatus({
      deadlineIso: '2026-11-01T00:00:00+05:30',
      opensIso: '2026-10-20T00:00:00+05:30',
      now,
    });
    expect(r.status).toBe('upcoming');
  });

  it('treats the final day of a date-only deadline as still open', () => {
    const r = computeRegistrationStatus({
      deadlineIso: '2026-09-26',
      precision: 'date_only',
      now: new Date('2026-09-26T12:00:00Z'),
    });
    expect(r.status).toBe('open');
  });

  it('closes a date-only deadline once the day has fully passed', () => {
    const r = computeRegistrationStatus({
      deadlineIso: '2026-09-25',
      precision: 'date_only',
      now: new Date('2026-09-26T00:30:00Z'),
    });
    expect(r.status).toBe('closed');
  });
});

describe('countdownTo', () => {
  const now = new Date('2026-09-26T00:00:00Z');

  it('counts days', () => {
    const c = countdownTo('2026-09-29T23:59:00+05:30', now);
    expect(c.label).toBe('3 days left');
    expect(c.expired).toBe(false);
  });

  it('counts hours', () => {
    const c = countdownTo('2026-09-26T14:00:00Z', now);
    expect(c.label).toBe('14 hours left');
  });

  it('counts minutes', () => {
    const c = countdownTo('2026-09-26T00:42:00Z', now);
    expect(c.label).toBe('42 minutes left');
  });

  it('reports closed once the deadline passes', () => {
    const c = countdownTo('2026-09-25T00:00:00Z', now);
    expect(c.expired).toBe(true);
    expect(c.label).toBe('Registration closed');
  });

  it('reports "not specified" rather than a fake countdown when there is no deadline', () => {
    const c = countdownTo(null, now);
    expect(c.label).toBe('Deadline not specified');
    expect(c.urgency).toBe('unknown');
  });
});

describe('formatDeadline', () => {
  it('renders an instant in the source timezone', () => {
    const f = formatDeadline('2026-09-29T23:59:00+05:30', { timeZone: 'Asia/Kolkata', sourceTimezoneLabel: 'IST' });
    expect(f.main).toBe('29 September 2026, 11:59 PM');
    expect(f.timezoneLabel).toBe('IST');
    expect(f.timeNotSpecified).toBe(false);
  });

  it('says "time not specified" for a date-only deadline instead of inventing 23:59', () => {
    const f = formatDeadline('2026-09-29');
    expect(f.main).toBe('29 September 2026 — time not specified');
    expect(f.timeNotSpecified).toBe(true);
  });

  it('renders "Not specified" for a missing deadline', () => {
    expect(formatDeadline(null).main).toBe('Not specified');
  });
});

describe('extractDeadlinesFromText — event-date ranges', () => {
  it('splits "Date: 7–8 October 2026" into event start and end', () => {
    const found = extractDeadlinesFromText(
      'Event Details Team Size: 4-6 Members Date: 7–8 October 2026 Duration: 24 Hours',
      { assumeYear: 2026 },
    );
    expect(found.map((d) => [d.kind, d.iso])).toEqual([
      ['hackathon_start', '2026-10-07'],
      ['hackathon_end', '2026-10-08'],
    ]);
    expect(found[0].precision).toBe('date_only');
    expect(found[0].confidence).toBe('partially_verified');
  });

  it('leaves a lone "Date: 5 Oct" unclassified rather than guessing start vs end', () => {
    const found = extractDeadlinesFromText('Date: 5 Oct 2026', { assumeYear: 2026 });
    expect(found.length).toBe(1);
    expect(found[0].kind).toBe('unknown');
  });

  it('refuses cross-month ranges instead of inventing the start month', () => {
    const found = extractDeadlinesFromText('Event dates: 30 Sep - 2 Oct 2026', { assumeYear: 2026 });
    expect(found.every((d) => d.kind === 'unknown')).toBe(true);
  });

  it('does not treat deadline labels as event dates', () => {
    const found = extractDeadlinesFromText('Registration closes 29–30 Sep 2026', { assumeYear: 2026 });
    expect(found.some((d) => d.kind === 'hackathon_start')).toBe(false);
  });
});

describe('formatSourceWallClock', () => {
  it('renders the source wall clock, mapping +05:30 to IST', async () => {
    const { formatSourceWallClock } = await import('../src/dates.js');
    const f = formatSourceWallClock('2026-09-27T23:59:00+05:30', 'UTC+05:30');
    expect(f.main).toBe('27 September 2026, 11:59 PM');
    expect(f.timezoneLabel).toBe('IST');
    expect(f.timeNotSpecified).toBe(false);
  });

  it('never UTC-normalizes: the same instant keeps its published wall time', async () => {
    const { formatSourceWallClock } = await import('../src/dates.js');
    // 18:29 UTC is 23:59 IST — the organizer wrote 23:59, so 23:59 it is.
    const f = formatSourceWallClock('2026-09-27T18:29:00Z', 'UTC');
    expect(f.main).toBe('27 September 2026, 06:29 PM');
    expect(f.timezoneLabel).toBe('UTC');
  });

  it('says time-not-specified for bare dates', async () => {
    const { formatSourceWallClock } = await import('../src/dates.js');
    const f = formatSourceWallClock('2026-09-29', null);
    expect(f.main).toContain('time not specified');
    expect(f.timeNotSpecified).toBe(true);
  });
});

describe('partsToIso — seconds fidelity', () => {
  it('preserves non-zero seconds the source stated', async () => {
    const { parseDateExpression } = await import('../src/dates.js');
    expect(parseDateExpression('2026-10-08T12:00:35+05:30')?.iso).toBe('2026-10-08T12:00:35+05:30');
  });

  it('emits :00 only when the source gave no seconds', async () => {
    const { parseDateExpression } = await import('../src/dates.js');
    expect(parseDateExpression('29 Sep 2026, 11:59 PM IST')?.iso).toBe('2026-09-29T23:59:00+05:30');
  });
});
