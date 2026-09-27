/**
 * Ingestion pipeline: adapter output -> normalized, deduplicated, verified rows.
 *
 * Responsibilities, in order:
 *   1. resolve the event's own city to a `cities` row (never the organizer's)
 *   2. geocode city and venue through a real provider, with caching
 *   3. find an existing record for this source id, or a duplicate across sources
 *   4. merge, reconciling disagreements by source authority and flagging
 *      unresolved conflicts
 *   5. persist the record plus per-field provenance, and schedule the next check
 *
 * Every write is idempotent, so re-running a crawl updates rather than duplicates.
 */
import type {
  Confidence,
  DeadlineConflict,
  ExtractedDate,
  FieldProvenance,
  Hackathon,
  RawHackathon,
  SourceId,
} from '@hf/shared';
import {
  SOURCE_TRUST,
  computeRegistrationStatus,
  guessPrecision,
  isDuplicate,
  normalizeTitle,
  reconcile,
  slugify,
} from '@hf/shared';
import type { Db } from '../db/client.js';
import { newId } from '../db/client.js';
import { CityService } from './cities.js';
import { computeDataQuality, nextVerificationAt } from './quality.js';
import type { AdapterLogger } from '../adapters/types.js';

/**
 * Every field that can be contributed by a source.
 *
 * The `column` is the database column. `snapshot` maps an adapter record
 * (camelCase, dates as ExtractedDate) onto that column's value (snake_case,
 * dates as ISO text). Keeping the mapping in one table is what makes
 * cross-source reconciliation correct: a date-only deadline reported by one
 * source and a full instant reported by another are compared on the same basis.
 */
interface FieldSpec {
  column: string;
  snapshot: (record: RawHackathon) => unknown;
}

const iso = (d: ExtractedDate | null | undefined): string | null => d?.iso ?? null;

const FIELD_SPECS: FieldSpec[] = [
  { column: 'title', snapshot: (r) => r.title },
  { column: 'description', snapshot: (r) => r.description },
  { column: 'organizer', snapshot: (r) => r.organizer },
  { column: 'source_url', snapshot: (r) => r.sourceUrl },
  { column: 'registration_url', snapshot: (r) => r.registrationUrl },
  { column: 'location_text', snapshot: (r) => r.locationText },
  { column: 'city', snapshot: (r) => r.city },
  { column: 'state', snapshot: (r) => r.state },
  { column: 'country', snapshot: (r) => r.country },
  { column: 'venue', snapshot: (r) => r.venue },
  { column: 'online_or_offline', snapshot: (r) => r.onlineOrOffline },
  { column: 'registration_opens_at', snapshot: (r) => iso(r.registrationOpensAt) },
  { column: 'registration_deadline', snapshot: (r) => iso(r.registrationDeadline) },
  { column: 'hackathon_start', snapshot: (r) => iso(r.hackathonStart) },
  { column: 'hackathon_end', snapshot: (r) => iso(r.hackathonEnd) },
  { column: 'submission_deadline', snapshot: (r) => iso(r.submissionDeadline) },
  { column: 'idea_submission_deadline', snapshot: (r) => iso(r.ideaSubmissionDeadline) },
  { column: 'final_presentation', snapshot: (r) => iso(r.finalPresentation) },
  { column: 'result_announcement', snapshot: (r) => iso(r.resultAnnouncement) },
  { column: 'team_size_min', snapshot: (r) => r.teamSizeMin },
  { column: 'team_size_max', snapshot: (r) => r.teamSizeMax },
  { column: 'eligibility', snapshot: (r) => r.eligibility },
  { column: 'themes', snapshot: (r) => r.themes },
  { column: 'technologies', snapshot: (r) => r.technologies },
  { column: 'prize_amount', snapshot: (r) => r.prizeAmount },
  { column: 'prize_currency', snapshot: (r) => r.prizeCurrency },
  { column: 'prize_details', snapshot: (r) => r.prizeDetails },
  { column: 'free_or_paid', snapshot: (r) => r.freeOrPaid },
  { column: 'registration_fee', snapshot: (r) => r.registrationFee },
  { column: 'registration_fee_currency', snapshot: (r) => r.registrationFeeCurrency },
  // Metadata used when reconciling; carried on the snapshot, not stored raw.
  { column: 'registration_deadline_timezone', snapshot: (r) => r.registrationDeadline?.sourceTimezone ?? null },
  { column: 'registration_deadline_precision', snapshot: (r) => r.registrationDeadline?.precision ?? 'none' },
  { column: 'registration_deadline_confidence', snapshot: (r) => r.registrationDeadline?.confidence ?? 'unknown' },
];

const REFRESHABLE_FIELDS = FIELD_SPECS.map((f) => f.column);
type FieldName = string;

function snapshotOf(record: RawHackathon): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of FIELD_SPECS) out[spec.column] = spec.snapshot(record);
  return out;
}

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Comparable instant for a stored ISO value. Date-only values run to end of day. */
function comparableTs(iso: string | null | undefined): string | null {
  if (!iso) return null;
  if (guessPrecision(iso) === 'date_only') {
    const d = new Date(`${iso}T23:59:59Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export interface IngestOptions {
  /** Geocode individual venue addresses (rate-limited; cached). */
  geocodeVenues?: boolean;
  /** Cap on venue geocoding per run. */
  maxVenueGeocodes?: number;
  logger: AdapterLogger;
}

export interface IngestStats {
  seen: number;
  inserted: number;
  updated: number;
  merged: number;
  rejected: number;
  duplicates: number;
}

export class IngestService {
  private readonly cities: CityService;
  private venueGeocodes = 0;

  constructor(private readonly db: Db, private readonly opts: IngestOptions) {
    this.cities = new CityService(db);
  }

  async ingest(record: RawHackathon, options: { geocodeVenues?: boolean } = {}): Promise<IngestStats> {
    const stats: IngestStats = { seen: 1, inserted: 0, updated: 0, merged: 0, rejected: 0, duplicates: 0 };
    if (!record?.title || !record.source || !record.sourceRecordId || !record.sourceUrl) {
      stats.rejected += 1;
      return stats;
    }

    // ---- 1. Where does the event happen? ---------------------------------
    const city = await this.cities.ensureCityForRecord({
      city: record.city ?? null,
      state: record.state ?? null,
      country: record.country ?? null,
    });
    const cityRow = city ? await this.cities.ensureCoordinates(city) : null;

    let latitude = cityRow?.latitude ?? null;
    let longitude = cityRow?.longitude ?? null;
    let geocodeSource = cityRow?.geocode_source ?? null;

    const wantVenueGeo = options.geocodeVenues ?? this.opts.geocodeVenues ?? false;
    if (wantVenueGeo && record.venue && this.venueGeocodes < (this.opts.maxVenueGeocodes ?? 300)) {
      this.venueGeocodes += 1;
      const geo = await this.cities.geocodeVenue(record.venue, record.city, record.country);
      if (geo) {
        latitude = geo.lat;
        longitude = geo.lon;
        geocodeSource = geo.source;
      }
    }

    // ---- 2. Find the row this record belongs to ---------------------------
    const bySourceId = await this.findBySourceId(record.source, record.sourceRecordId);
    const duplicate = bySourceId ? null : await this.findDuplicate(record, cityRow?.id ?? null);
    const targetId = bySourceId?.id ?? duplicate?.id ?? null;

    if (duplicate && !bySourceId) {
      stats.merged += 1;
      stats.duplicates += 1;
      this.opts.logger.info('merged duplicate listing', {
        title: record.title,
        into: duplicate?.title,
        hackathon_id: duplicate?.id,
        from_source: record.source,
      });
    }

    const hackathonId = targetId ?? newId();
    const isNew = !targetId;

    // ---- 3. Assemble the merged field values ------------------------------
    const existingSources = targetId
      ? await this.loadSiblingSources(hackathonId, record.source, record.sourceRecordId)
      : [];

    const snapshot = snapshotOf(record);
    const reportsFor = (field: FieldName) => {
      const list: Array<{ value: unknown; source: SourceId; sourceUrl: string }> = [];
      for (const sibling of existingSources) {
        const value = sibling.values[field];
        if (value !== undefined && value !== null) {
          list.push({ value, source: sibling.source, sourceUrl: sibling.sourceUrl });
        }
      }
      list.push({ value: snapshot[field], source: record.source, sourceUrl: record.sourceUrl });
      return list;
    };

    const merged: Record<string, unknown> = {};
    let deadlineConflict: DeadlineConflict | null = null;
    const fieldConflicts: DeadlineConflict[] = [];

    const toConflict = (field: string, result: { reports: Array<{ source: SourceId; value: string; sourceUrl: string }> }, note: string): DeadlineConflict => ({
      field,
      values: result.reports.map((rep) => ({
        value: rep.value,
        source: rep.source,
        sourceUrl: rep.sourceUrl,
        trust: SOURCE_TRUST[rep.source] ?? 0,
      })),
      resolvedFrom: null,
      resolutionNote: note,
    });

    for (const field of REFRESHABLE_FIELDS) {
      if (field.startsWith('registration_deadline_')) {
        // Metadata travels with the value; see below.
        merged[field] = (record as unknown as Record<string, unknown>)[field] ?? null;
        continue;
      }
      const result = reconcile(
        reportsFor(field).map((r) => ({ value: scalar(r.value), source: r.source, sourceUrl: r.sourceUrl })),
        SOURCE_TRUST,
      );
      if (result.conflict) {
        if (field === 'registration_deadline') {
          deadlineConflict = toConflict(
            field,
            result,
            'Sources of comparable authority report different dates. Verify on the official page.',
          );
        } else {
          // A title variation is normal across sources; it is recorded for audit
          // but never raises the deadline banner or degrades data quality.
          fieldConflicts.push(toConflict(field, result, 'Sources disagree.'));
        }
      }
      merged[field] = result.value;
    }

    // Deadline metadata follows the winning value: prefer the report whose value
    // won reconciliation, and the strongest confidence among its reporters.
    const deadlineReports = reportsFor('registration_deadline').filter(
      (rep) => scalar(rep.value) === (merged.registration_deadline as string | null),
    );
    const CONFIDENCE_RANK: Record<string, number> = {
      verified: 4,
      source_confirmed: 3,
      partially_verified: 2,
      inferred: 1,
      unknown: 0,
    };
    const confidenceOf = (source: SourceId): string => {
      if (source === record.source) return record.registrationDeadline?.confidence ?? 'unknown';
      const sib = existingSources.find((s) => s.source === source);
      return String(sib?.values.registration_deadline_confidence ?? 'unknown');
    };
    const ranked = [...deadlineReports].sort((a, b) => {
      const conf = (CONFIDENCE_RANK[confidenceOf(b.source)] ?? 0) - (CONFIDENCE_RANK[confidenceOf(a.source)] ?? 0);
      if (conf !== 0) return conf;
      return (SOURCE_TRUST[b.source] ?? 0) - (SOURCE_TRUST[a.source] ?? 0);
    });
    const metadataSource = ranked[0] ?? null;
    const metadataSnapshot =
      metadataSource?.source === record.source
        ? snapshot
        : (existingSources.find((s) => s.source === metadataSource?.source)?.values ?? {});
    merged.registration_deadline_timezone =
      (metadataSnapshot.registration_deadline_timezone as string | null) ?? null;
    merged.registration_deadline_precision =
      (metadataSnapshot.registration_deadline_precision as string) ?? 'none';
    merged.registration_deadline_confidence =
      (metadataSnapshot.registration_deadline_confidence as string) ?? 'unknown';

    // Numeric fields come back as strings from reconcile(); coerce them back.
    merged.team_size_min = numeric(merged.team_size_min);
    merged.team_size_max = numeric(merged.team_size_max);
    merged.prize_amount = numeric(merged.prize_amount);
    merged.registration_fee = numeric(merged.registration_fee);
    merged.themes = Array.isArray(record.themes) ? record.themes : splitList(merged.themes);
    merged.technologies = Array.isArray(record.technologies) ? record.technologies : splitList(merged.technologies);
    if (!Array.isArray(merged.themes) || (merged.themes as string[]).length === 0) {
      merged.themes = unionList(existingSources.flatMap((s) => s.values.themes as string[]), record.themes);
    }
    if (!Array.isArray(merged.technologies) || (merged.technologies as string[]).length === 0) {
      merged.technologies = unionList(existingSources.flatMap((s) => s.values.technologies as string[]), record.technologies);
    }

    // ---- 4. Deadline metadata --------------------------------------------
    // The winning value's evidence travels with it: timezone, precision and the
    // strongest confidence reported for that exact value.
    const deadlineIso = (merged.registration_deadline as string | null) ?? null;
    const opensIso = (merged.registration_opens_at as string | null) ?? null;
    const deadlinePrecision = (merged.registration_deadline_precision as string) ?? 'none';
    const deadlineTimezone = (merged.registration_deadline_timezone as string | null) ?? null;
    const deadlineConfidence = (merged.registration_deadline_confidence as Confidence) ?? 'unknown';
    const deadlineDate: ExtractedDate | null = deadlineIso
      ? {
          iso: deadlineIso,
          kind: 'registration_deadline',
          precision:
            deadlinePrecision === 'instant' || deadlinePrecision === 'date_only'
              ? deadlinePrecision
              : guessPrecision(deadlineIso),
          sourceTimezone: deadlineTimezone,
          offsetMinutes: null,
          raw: deadlineIso,
          label: 'Registration Deadline',
          confidence: deadlineConfidence,
        }
      : null;
    const precision = deadlineIso ? guessPrecision(deadlineIso) : 'none';
    const status = computeRegistrationStatus({
      deadlineIso,
      precision,
      opensIso,
      now: new Date(),
    });
    const basis: Hackathon['registrationDeadlineBasis'] = deadlineConfidence === 'inferred'
      ? 'inferred_from_submission_deadline'
      : deadlineIso
        ? 'source_explicit'
        : 'unknown';

    const quality = computeDataQuality({
      registrationDeadline: deadlineDate,
      source: record.source,
      deadlineInferred: basis !== 'source_explicit',
      deadlineConflict: deadlineConflict !== null,
      populatedFieldCount: Object.values(merged).filter((v) => v !== null && v !== undefined && v !== '').length,
      organizer: record.organizer ?? null,
      city: record.city ?? null,
      onlineOrOffline: record.onlineOrOffline ?? null,
    });

    const now = new Date();
    const nextCheck = nextVerificationAt({
      status: status.status,
      deadlineIso,
      eventStartIso: (merged.hackathon_start as string | null) ?? null,
      now,
    });

    const slug = targetId
      ? await this.uniqueSlug(merged.title as string, hackathonId)
      : await this.uniqueSlug(merged.title as string, null);

    const row = {
      id: hackathonId,
      slug,
      title: (merged.title as string) ?? record.title,
      description: (merged.description as string | null) ?? null,
      organizer: (merged.organizer as string | null) ?? null,
      source: record.source,
      source_url: sanitizeHttpUrl((merged.source_url as string) ?? record.sourceUrl) ?? record.sourceUrl,
      registration_url: sanitizeHttpUrl((merged.registration_url as string | null) ?? null),
      location_text: (merged.location_text as string | null) ?? null,
      city_id: cityRow?.id ?? null,
      city_name: cityRow?.name ?? null,
      city_key: cityRow?.normalized_name ?? null,
      metro: cityRow?.metro ?? null,
      state: (merged.state as string | null) ?? cityRow?.state ?? null,
      country: (merged.country as string | null) ?? cityRow?.country ?? null,
      venue: (merged.venue as string | null) ?? null,
      latitude,
      longitude,
      geocode_source: geocodeSource,
      event_type: record.eventType ?? 'hackathon',
      online_or_offline: (merged.online_or_offline as string) ?? record.onlineOrOffline ?? 'unknown',
      registration_opens_at: opensIso,
      registration_opens_ts: comparableTs(opensIso),
      registration_deadline: deadlineIso,
      registration_deadline_ts: comparableTs(deadlineIso),
      registration_deadline_precision: deadlineDate?.precision ?? 'none',
      registration_deadline_timezone: deadlineTimezone,
      registration_deadline_basis: basis,
      registration_status: status.status,
      registration_status_note: status.note,
      hackathon_start: (merged.hackathon_start as string | null) ?? null,
      hackathon_start_ts: comparableTs(merged.hackathon_start as string | null),
      hackathon_end: (merged.hackathon_end as string | null) ?? null,
      hackathon_end_ts: comparableTs(merged.hackathon_end as string | null),
      submission_deadline: (merged.submission_deadline as string | null) ?? null,
      submission_deadline_ts: comparableTs(merged.submission_deadline as string | null),
      idea_submission_deadline: (merged.idea_submission_deadline as string | null) ?? null,
      idea_submission_deadline_ts: comparableTs(merged.idea_submission_deadline as string | null),
      final_presentation: (merged.final_presentation as string | null) ?? null,
      final_presentation_ts: comparableTs(merged.final_presentation as string | null),
      result_announcement: (merged.result_announcement as string | null) ?? null,
      result_announcement_ts: comparableTs(merged.result_announcement as string | null),
      team_size_min: merged.team_size_min as number | null,
      team_size_max: merged.team_size_max as number | null,
      eligibility: (merged.eligibility as string | null) ?? null,
      themes: merged.themes as string[],
      technologies: merged.technologies as string[],
      prize_amount: merged.prize_amount as number | null,
      prize_currency: (merged.prize_currency as string | null) ?? null,
      prize_details: (merged.prize_details as string | null) ?? null,
      free_or_paid: (merged.free_or_paid as string) ?? record.freeOrPaid ?? 'unknown',
      registration_fee: merged.registration_fee as number | null,
      registration_fee_currency: (merged.registration_fee_currency as string | null) ?? record.registrationFeeCurrency ?? null,
      data_quality: quality.dataQuality,
      deadline_conflict: deadlineConflict !== null,
      deadline_conflict_detail: deadlineConflict,
      field_conflicts: fieldConflicts.length > 0 ? fieldConflicts : null,
      source_deadline_text: record.sourceDeadlineText ?? null,
      last_verified_at: now.toISOString(),
      next_verification_at: nextCheck.toISOString(),
      updated_at: now.toISOString(),
      is_merged: targetId ? true : false,
    };

    await this.persist(row, record, quality.reasons, isNew);

    if (isNew) stats.inserted += 1;
    else stats.updated += 1;
    return stats;
  }

  // -------------------------------------------------------------------------

  private async persist(
    row: Record<string, unknown>,
    record: RawHackathon,
    qualityReasons: string[],
    isNew: boolean,
  ): Promise<void> {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const updates = columns
      .filter((c) => c !== 'id' && c !== 'slug' && c !== 'first_seen_at')
      .map((c) => `${c} = EXCLUDED.${c}`);

    await this.db.query(
      `INSERT INTO hackathons (${columns.join(', ')}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}`,
      columns.map((c) => row[c]),
    );

    // Per-source link, so a merged event keeps every original listing.
    await this.db.query(
      `INSERT INTO hackathon_sources
         (id, hackathon_id, source, source_record_id, source_url, registration_url, title_raw, organizer_raw, city_raw,
          is_primary, fetch_status, fetched_at, raw, source_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (source, source_record_id) DO UPDATE SET
         hackathon_id = EXCLUDED.hackathon_id,
         source_url = EXCLUDED.source_url,
         registration_url = EXCLUDED.registration_url,
         title_raw = EXCLUDED.title_raw,
         organizer_raw = EXCLUDED.organizer_raw,
         city_raw = EXCLUDED.city_raw,
         fetch_status = EXCLUDED.fetch_status,
         fetched_at = EXCLUDED.fetched_at,
         raw = EXCLUDED.raw,
         source_payload = EXCLUDED.source_payload`,
      [
        newId(),
        row.id,
        record.source,
        record.sourceRecordId,
        record.sourceUrl,
        record.registrationUrl ?? null,
        record.title,
        record.organizer ?? null,
        record.city ?? null,
        // Exactly one listing is flagged primary: the record's own source.
        record.source === row.source,
        'ok',
        new Date().toISOString(),
        JSON.stringify(snapshotOf(record)),
        JSON.stringify(record.raw ?? null),
      ],
    );

    // Field-level provenance, refreshed each time we see the record.
    await this.db.query('DELETE FROM field_provenance WHERE hackathon_id = $1 AND source = $2', [
      row.id,
      record.source,
    ]);
    const entries: FieldProvenance[] = record.provenance.map((p) => ({
      field: p.field,
      value: p.value,
      source: p.source,
      sourceUrl: p.sourceUrl,
      retrievedAt: p.retrievedAt,
      confidence: p.confidence,
    }));
    if (entries.length === 0) {
      entries.push({
        field: 'title',
        value: record.title,
        source: record.source,
        sourceUrl: record.sourceUrl,
        retrievedAt: record.retrievedAt,
        confidence: 'verified',
      });
    }
    for (const entry of entries) {
      await this.db.query(
        `INSERT INTO field_provenance (hackathon_id, field, value, source, source_url, retrieved_at, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          row.id,
          entry.field,
          entry.value === null ? null : String(entry.value),
          entry.source,
          entry.sourceUrl,
          entry.retrievedAt,
          entry.confidence,
        ],
      );
    }

    if (qualityReasons.length > 0 && isNew) {
      this.opts.logger.info('data quality', { title: row.title, quality: row.data_quality, reasons: qualityReasons });
    }
  }

  private async findBySourceId(source: SourceId, sourceRecordId: string): Promise<{ id: string; title: string } | null> {
    const res = await this.db.query<{ hackathon_id: string; title_raw: string | null }>(
      'SELECT hackathon_id, title_raw FROM hackathon_sources WHERE source = $1 AND source_record_id = $2',
      [source, sourceRecordId],
    );
    if (res.rows[0]) return { id: res.rows[0].hackathon_id, title: res.rows[0].title_raw ?? '' };
    return null;
  }

  /**
   * Look for the same event under a different source.
   * Candidates are narrowed in SQL by distinctive title tokens and city, then
   * judged by the multi-signal duplicate check.
   */
  private async findDuplicate(record: RawHackathon, cityId: string | null): Promise<{ id: string; title: string } | null> {
    const tokens = normalizeTitle(record.title)
      .split(' ')
      .filter((t) => t.length >= 4)
      .slice(0, 3);
    const urlIdentity = urlKey(record.registrationUrl ?? record.sourceUrl);

    // Build clauses and parameters together: a parameter that is never referenced
    // makes PostgreSQL fail with "could not determine data type", which happens
    // for short titles that carry no distinctive token.
    const params: unknown[] = [];
    const clauses: string[] = [];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (tokens.length > 0) {
      clauses.push(`(${tokens.map((t) => `lower(h.title) LIKE ${bind(`%${t}%`)}`).join(' OR ')})`);
    }
    if (cityId) clauses.push(`h.city_id = ${bind(cityId)}`);
    if (urlIdentity) clauses.push(`h.registration_url ILIKE ${bind(`%${urlIdentity}%`)}`);
    if (clauses.length === 0) return null;

    const sql = `
      SELECT h.id, h.title, h.organizer, h.city_id, h.source, h.source_url, h.registration_url,
             h.registration_deadline, h.hackathon_start, h.online_or_offline, h.country, h.city_name
      FROM hackathons h
      WHERE ${clauses.join(' OR ')}
      LIMIT 60`;

    const res = await this.db.query<DuplicateCandidateRow>(sql, params);
    for (const row of res.rows) {
      const candidate: RawHackathon = {
        source: row.source as SourceId,
        sourceRecordId: row.id,
        title: row.title,
        organizer: row.organizer,
        sourceUrl: row.source_url,
        registrationUrl: row.registration_url,
        city: row.city_name,
        country: row.country,
        onlineOrOffline: (row.online_or_offline as RawHackathon['onlineOrOffline']) ?? 'unknown',
        hackathonStart: row.hackathon_start
          ? { iso: row.hackathon_start, kind: 'hackathon_start', precision: guessPrecision(row.hackathon_start), sourceTimezone: null, offsetMinutes: null, raw: row.hackathon_start, label: null, confidence: 'source_confirmed' }
          : null,
        registrationDeadline: row.registration_deadline
          ? { iso: row.registration_deadline, kind: 'registration_deadline', precision: guessPrecision(row.registration_deadline), sourceTimezone: null, offsetMinutes: null, raw: row.registration_deadline, label: null, confidence: 'source_confirmed' }
          : null,
        provenance: [],
        retrievedAt: new Date().toISOString(),
      };
      if (isDuplicate(record, candidate).duplicate) {
        return { id: row.id, title: row.title };
      }
    }
    return null;
  }

  private async loadSiblingSources(
    hackathonId: string,
    excludeSource: SourceId,
    excludeRecordId: string,
  ): Promise<Array<{ source: SourceId; sourceUrl: string; values: Record<string, unknown> }>> {
    const rows = await this.db.query<{
      source: SourceId;
      source_url: string;
      raw: Record<string, unknown> | null;
    }>(
      `SELECT hs.source, hs.source_url, hs.raw
       FROM hackathon_sources hs
       JOIN hackathons h ON h.id = hs.hackathon_id
       WHERE hs.hackathon_id = $1 AND NOT (hs.source = $2 AND hs.source_record_id = $3)`,
      [hackathonId, excludeSource, excludeRecordId],
    );
    return rows.rows.map((r) => ({ source: r.source, sourceUrl: r.source_url, values: r.raw ?? {} }));
  }

  private async uniqueSlug(title: string, keepId: string | null): Promise<string> {
    const base = slugify(title);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const res = await this.db.query<{ id: string }>('SELECT id FROM hackathons WHERE slug = $1', [candidate]);
      if (res.rows.length === 0 || (keepId && res.rows[0].id === keepId)) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

interface DuplicateCandidateRow {
  id: string;
  title: string;
  organizer: string | null;
  city_id: string | null;
  source: string;
  source_url: string;
  registration_url: string | null;
  registration_deadline: string | null;
  hackathon_start: string | null;
  online_or_offline: string | null;
  country: string | null;
  city_name: string | null;
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function unionList(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])].filter(Boolean);
}

/**
 * Only http(s) URLs are stored or rendered. Anything else (javascript:, data:,
 * malformed) becomes null so a hostile ingested value can never become a
 * clickable link in the UI.
 */
function sanitizeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function urlKey(url: string): string | null {  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}`;
  } catch {
    return null;
  }
}
