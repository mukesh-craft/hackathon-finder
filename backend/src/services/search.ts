/**
 * Search over the ingested database.
 *
 * No network access happens here. Search is a set of indexed PostgreSQL queries
 * against rows the ingestion pipeline has already verified, so a user request
 * never triggers a crawl and the page stays fast.
 */
import type { Db } from '../db/client.js';
import type { Hackathon, HackathonSourceRef, ResolvedCity, SearchQuery, SearchResponse, SortOption, SourceId } from '@hf/shared';
import { boundingBox, haversineKm, computeRegistrationStatus, guessPrecision } from '@hf/shared';
import { CityService } from './cities.js';

interface HackathonRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  organizer: string | null;
  source: SourceId;
  source_url: string;
  registration_url: string | null;
  location_text: string | null;
  city_id: string | null;
  city_name: string | null;
  city_key: string | null;
  state: string | null;
  country: string | null;
  venue: string | null;
  latitude: number | null;
  longitude: number | null;
  event_type: string;
  online_or_offline: string;
  registration_opens_at: string | null;
  registration_deadline: string | null;
  registration_deadline_precision: string;
  registration_deadline_timezone: string | null;
  registration_deadline_basis: string;
  registration_status: string;
  registration_status_note: string | null;
  hackathon_start: string | null;
  hackathon_end: string | null;
  submission_deadline: string | null;
  idea_submission_deadline: string | null;
  final_presentation: string | null;
  result_announcement: string | null;
  team_size_min: number | null;
  team_size_max: number | null;
  eligibility: string | null;
  themes: string[] | null;
  technologies: string[] | null;
  prize_amount: string | number | null;
  prize_currency: string | null;
  prize_details: string | null;
  free_or_paid: string;
  registration_fee: string | number | null;
  registration_fee_currency: string | null;
  data_quality: string;
  deadline_conflict: boolean;
  deadline_conflict_detail: unknown;
  field_conflicts: unknown;
  source_deadline_text: string | null;
  last_verified_at: Date | string;
  next_verification_at: Date | string | null;
  updated_at: Date | string;
  distance_km?: number | null;
}

/**
 * Registration status derived at query time from the stored deadline
 * timestamps. This is the single source of truth for filtering; the
 * `registration_status` column is a cached copy refreshed by the worker.
 * Semantics mirror computeRegistrationStatus() in @hf/shared.
 */
export const LIVE_STATUS = `CASE
  WHEN h.registration_deadline_ts IS NULL THEN 'unknown'
  WHEN h.registration_deadline_ts <= now() THEN 'closed'
  WHEN h.registration_opens_ts IS NOT NULL AND h.registration_opens_ts > now() THEN 'upcoming'
  ELSE 'open'
END`;

/** Cap for the online companion section so it never overwhelms city results. */
export const ONLINE_SECTION_LIMIT = 12;

const SELECT_COLUMNS = `  h.id, h.slug, h.title, h.description, h.organizer, h.source, h.source_url, h.registration_url,
  h.location_text, h.city_id, h.city_name, h.city_key, h.state, h.country, h.venue,
  h.latitude, h.longitude, h.event_type, h.online_or_offline,
  h.registration_opens_at, h.registration_deadline, h.registration_deadline_precision,
  h.registration_deadline_timezone, h.registration_deadline_basis, h.registration_status,
  h.registration_status_note,
  h.hackathon_start, h.hackathon_end, h.submission_deadline, h.idea_submission_deadline,
  h.final_presentation, h.result_announcement,
  h.team_size_min, h.team_size_max, h.eligibility, h.themes, h.technologies,
  h.prize_amount, h.prize_currency, h.prize_details, h.free_or_paid,
  h.registration_fee, h.registration_fee_currency,
  h.data_quality, h.deadline_conflict, h.deadline_conflict_detail, h.field_conflicts, h.source_deadline_text,
  h.last_verified_at, h.next_verification_at, h.updated_at
`;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class SearchService {
  private readonly cities: CityService;

  constructor(private readonly db: Db) {
    this.cities = new CityService(db);
  }

  async search(query: SearchQuery, now = new Date()): Promise<SearchResponse> {
    const resolvedCity = query.city ? await this.cities.resolveQuery(query.city) : null;

    // A city search returns physical events as the main list. Online events —
    // joinable from anywhere — go in a separate section rather than competing
    // with the city ranking. When the user explicitly asks for online only,
    // the main list itself is the online list and no second section is needed.
    const cityOnlineMode = Boolean(query.city) && query.mode === 'online';
    const wantOnlineSection = Boolean(query.city) && query.mode !== 'offline' && !cityOnlineMode;

    const mainKeys = await this.placeKeys(query);
    const [main, online] = await Promise.all([
      this.runList(query, now, { onlineOnly: cityOnlineMode, resolvedCity, keys: mainKeys.keys, metro: mainKeys.metro }),
      wantOnlineSection
        ? this.runList(
            { ...query, city: undefined, radiusKm: null, mode: 'online', limit: ONLINE_SECTION_LIMIT, page: 1 },
            now,
            { onlineOnly: true, resolvedCity: null, keys: [], metro: null },
          )
        : Promise.resolve(null),
    ]);

    return {
      city: resolvedCity ?? {
        query: '',
        name: null,
        slug: null,
        state: null,
        country: null,
        countryCode: null,
        latitude: null,
        longitude: null,
        match: 'unknown',
        notes: [],
        aliases: [],
        metroMembers: [],
        geocodeSource: null,
      },
      count: main.results.length,
      total: main.total,
      page: query.page,
      limit: main.limit,
      hasMore: main.hasMore,
      results: main.results,
      online: online ? { total: online.total, results: online.results } : null,
      facets: await this.facets(main.whereSql, main.filterParams),
      dataFreshness: await this.freshness(),
      generatedAt: now.toISOString(),
      // The HTTP layer overwrites this with the real visit-refresh outcome.
      refreshing: false,
    };
  }

  /**
   * Place keys for a query. Kept separate so the main list and the online
   * section share one resolution instead of geocoding twice.
   */
  private async placeKeys(query: SearchQuery): Promise<{ keys: string[]; metro: string | null }> {
    if (!query.city) return { keys: [], metro: null };
    return this.cities.searchKeysFor(
      query.city,
      query.radiusKm === null || query.radiusKm === undefined || query.radiusKm > 0,
    );
  }

  /**
   * Run one filtered, sorted, paginated list query. `onlineOnly` drops every
   * place constraint and forces the online format — used for the online
   * section and for city+online-mode searches alike.
   */
  private async runList(
    query: SearchQuery,
    now: Date,
    opts: { onlineOnly: boolean; resolvedCity: ResolvedCity | null; keys: string[]; metro: string | null },
  ): Promise<{
    results: Hackathon[];
    total: number;
    hasMore: boolean;
    limit: number;
    whereSql: string;
    filterParams: unknown[];
  }> {
    const { resolvedCity, keys, metro } = opts;

    const where: string[] = [];
    const params: unknown[] = [];
    /**
     * Append a value and return its 1-based PostgreSQL placeholder. This is the
     * only way parameters are bound in this query, so a placeholder can never be
     * numbered out of step with the value it refers to.
     */
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // `add` takes a SQL fragment with `?` placeholders and the matching values.
    const add = (clause: string, ...values: unknown[]) => {
      let i = 0;
      where.push(clause.replace(/\?/g, () => bind(values[i++])));
    };

    // ---- location -----------------------------------------------------------
    // Skipped entirely for online-only lists: an online event has no city and
    // must never be filtered out for lacking one.
    let distanceExpr: string | null = null;
    const originLat = !opts.onlineOnly ? (resolvedCity?.latitude ?? null) : null;
    const originLon = !opts.onlineOnly ? (resolvedCity?.longitude ?? null) : null;
    const wantDistance = originLat !== null && originLon !== null;

    if (!opts.onlineOnly && query.city && keys.length > 0) {
      // A metro search accepts sibling cities; an exact-city search does not.
      const placeClauses = [`lower(h.city_key) IN (${keys.map((k) => bind(k)).join(', ')})`];
      if (metro) {
        placeClauses.push(
          `lower(COALESCE(h.location_text, '')) LIKE ANY (${bind(keys.map((k) => `%${k}%`))})`,
        );
        placeClauses.push(`h.metro = ${bind(metro)}`);
      }
      where.push(`(${placeClauses.join(' OR ')})`);
    }

    if (wantDistance) {
      const box = boundingBox(originLat as number, originLon as number, Math.max(query.radiusKm ?? 50, 1));
      // Bounding box first so the composite index on (latitude, longitude) is used.
      where.push(
        `(h.latitude IS NULL OR (h.latitude BETWEEN ${bind(box.minLat)} AND ${bind(box.maxLat)} AND h.longitude BETWEEN ${bind(box.minLon)} AND ${bind(box.maxLon)}))`,
      );
      const latP = bind(originLat);
      const lonP = bind(originLon);
      distanceExpr = `
        CASE WHEN h.latitude IS NULL OR h.longitude IS NULL THEN NULL
        ELSE 6371.0088 * 2 * asin(sqrt(
          power(sin(radians(h.latitude - ${latP}) / 2), 2) +
          cos(radians(${latP})) * cos(radians(h.latitude)) *
          power(sin(radians(h.longitude - ${lonP}) / 2), 2)
        )) END`;
      // Exact radius check; events without coordinates are kept because the
      // place match above already established they belong to the searched city.
      if (typeof query.radiusKm === 'number' && query.radiusKm > 0) {
        where.push(`(${distanceExpr} IS NULL OR ${distanceExpr} <= ${bind(query.radiusKm)})`);
      }
    }

    // ---- status -------------------------------------------------------------
    // Status is derived from the stored deadline timestamps at query time, not
    // from the `registration_status` column, so a deadline that passed since
    // ingestion immediately stops matching — even if no refresh has run yet.
    // Mirrors computeRegistrationStatus(): unknown when no deadline was ever
    // published, closed once it passes, upcoming while registration hasn't
    // opened, open otherwise. Date-only deadlines are stored as end-of-day in
    // `registration_deadline_ts`, so the final stated day still counts as open.
    if (query.openOnly) {
      add(`${LIVE_STATUS} = 'open'`);
    } else {
      // Default: hide registrations that have already closed. Records with no
      // published deadline stay visible and are labelled "Not specified".
      add(`${LIVE_STATUS} <> 'closed'`);
    }

    // ---- mode ---------------------------------------------------------------
    if (opts.onlineOnly) {
      add(`h.online_or_offline = 'online'`);
    } else if (query.mode === 'online') {
      add(`h.online_or_offline = 'online'`);
    } else if (query.mode === 'offline') {
      add(`h.online_or_offline IN ('offline','hybrid')`);
    }

    // ---- money --------------------------------------------------------------
    if (query.freeOnly) add(`(h.free_or_paid = 'free' OR h.registration_fee IS NULL OR h.registration_fee = 0)`);
    if (query.paidOnly) add(`h.free_or_paid = 'paid'`);
    if (query.prizeOnly) add(`h.prize_amount IS NOT NULL AND h.prize_amount > 0`);

    // ---- team size ----------------------------------------------------------
    // The user's team spans N..M members. An event overlaps when its own
    // accepted range intersects: event.min <= M AND event.max >= N.
    // A null bound on either side is treated as unbounded.
    const userMin = query.teamSizeMin ?? null;
    const userMax = query.teamSizeMax ?? null;
    if (userMin !== null && userMax !== null) {
      add(`(h.team_size_min IS NULL OR h.team_size_min <= ?)`, userMax);
      add(`(h.team_size_max IS NULL OR h.team_size_max >= ?)`, userMin);
    } else if (userMax !== null) {
      add(`(h.team_size_min IS NULL OR h.team_size_min <= ?)`, userMax);
    } else if (userMin !== null) {
      add(`(h.team_size_max IS NULL OR h.team_size_max >= ?)`, userMin);
    }

    // ---- taxonomy -----------------------------------------------------------
    if (query.themes && query.themes.length > 0) {
      add(`h.themes && ?::text[]`, query.themes);
    }
    if (query.technologies && query.technologies.length > 0) {
      add(`h.technologies && ?::text[]`, query.technologies);
    }
    if (query.eligibility && query.eligibility.length > 0) {
      const clause = query.eligibility
        .map(() => `lower(COALESCE(h.eligibility, '')) LIKE ?`)
        .join(' OR ');
      add(`(${clause})`, ...query.eligibility.map((e) => `%${e.toLowerCase()}%`));
    }

    // ---- event dates --------------------------------------------------------
    if (query.eventFrom) add(`h.hackathon_start_ts >= ?::timestamptz`, query.eventFrom);
    if (query.eventTo) add(`h.hackathon_start_ts <= ?::timestamptz`, query.eventTo);

    // ---- free text ----------------------------------------------------------
    if (query.q && query.q.trim()) {
      add(
        `(lower(h.title) LIKE ? OR lower(COALESCE(h.organizer, '')) LIKE ? OR lower(COALESCE(h.description, '')) LIKE ?)`,
        `%${query.q.trim().toLowerCase()}%`,
        `%${query.q.trim().toLowerCase()}%`,
        `%${query.q.trim().toLowerCase()}%`,
      );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = buildOrderBy(query.sort ?? 'relevance', distanceExpr !== null);

    // Filters reference parameters 1..filterParamCount; the count and facet
    // queries reuse that prefix and must not receive the paging parameters.
    const filterParams = [...params];

    const limit = Math.min(Math.max(query.limit, 1), 100);
    const offset = Math.max(query.page - 1, 0) * limit;
    // Paging parameters are bound last, after every filter parameter.
    const limitParam = bind(limit);
    const offsetParam = bind(offset);

    const rowsRes = await this.db.query<HackathonRow>(
      `SELECT ${SELECT_COLUMNS}${distanceExpr ? `, ${distanceExpr} AS distance_km` : ''}
       FROM hackathons h
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params],
    );
    const countRes = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM hackathons h ${whereSql}`,
      filterParams,
    );

    const total = Number(countRes.rows[0]?.total ?? 0);
    const sourcesById = await this.loadSources(rowsRes.rows.map((r) => r.id));
    const results = rowsRes.rows.map((row) => this.toHackathon(row, sourcesById.get(row.id) ?? [], now));

    return {
      results,
      total,
      hasMore: offset + results.length < total,
      limit,
      whereSql,
      filterParams,
    };
  }

  async getBySlug(slug: string, now = new Date()): Promise<Hackathon | null> {
    const res = await this.db.query<HackathonRow>(
      `SELECT ${SELECT_COLUMNS} FROM hackathons h WHERE h.slug = $1`,
      [slug],
    );
    const row = res.rows[0];
    if (!row) return null;
    const sources = await this.loadSources([row.id]);
    return this.toHackathon(row, sources.get(row.id) ?? [], now);
  }

  async getById(id: string, now = new Date()): Promise<Hackathon | null> {
    const res = await this.db.query<HackathonRow>(`SELECT ${SELECT_COLUMNS} FROM hackathons h WHERE h.id = $1`, [id]);
    const row = res.rows[0];
    if (!row) return null;
    const sources = await this.loadSources([row.id]);
    return this.toHackathon(row, sources.get(row.id) ?? [], now);
  }

  async provenance(hackathonId: string): Promise<Array<{ field: string; value: string | null; source: string; sourceUrl: string; retrievedAt: string; confidence: string }>> {
    const res = await this.db.query<{ field: string; value: string | null; source: string; source_url: string; retrieved_at: Date; confidence: string }>(
      `SELECT field, value, source, source_url, retrieved_at, confidence
       FROM field_provenance WHERE hackathon_id = $1 ORDER BY field, retrieved_at DESC`,
      [hackathonId],
    );
    return res.rows.map((r) => ({
      field: r.field,
      value: r.value,
      source: r.source,
      sourceUrl: r.source_url,
      retrievedAt: toIso(r.retrieved_at) ?? '',
      confidence: r.confidence,
    }));
  }

  /**
   * A few cities with the most live registrations, used to seed the homepage.
   */
  async topCities(limit = 8): Promise<Array<{ name: string; slug: string; openCount: number; totalCount: number }>> {
    const res = await this.db.query<{ name: string; id: string; open: string; total: string }>(
      `SELECT c.name, c.id,
              count(*) FILTER (WHERE ${LIVE_STATUS} = 'open') AS open,
              count(*) AS total
       FROM hackathons h JOIN cities c ON c.id = h.city_id
       WHERE ${LIVE_STATUS} <> 'closed'
       GROUP BY c.id, c.name
       ORDER BY open DESC, total DESC, c.name
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({ name: r.name, slug: r.id, openCount: Number(r.open), totalCount: Number(r.total) }));
  }

  private async facets(whereSql: string, params: unknown[]): Promise<SearchResponse['facets']> {
    const [themes, technologies, eligibility, counts] = await Promise.all([
      this.db.query<{ value: string; count: string }>(
        `SELECT t AS value, count(*)::text AS count FROM hackathons h, unnest(h.themes) AS t ${whereSql} GROUP BY t ORDER BY count(*) DESC LIMIT 20`,
        params,
      ),
      this.db.query<{ value: string; count: string }>(
        `SELECT t AS value, count(*)::text AS count FROM hackathons h, unnest(h.technologies) AS t ${whereSql} GROUP BY t ORDER BY count(*) DESC LIMIT 20`,
        params,
      ),
      this.db.query<{ value: string; count: string }>(
        `SELECT value, count(*)::text AS count FROM (
           SELECT unnest(string_to_array(lower(COALESCE(h.eligibility,'')), ',')) AS value FROM hackathons h ${whereSql}
         ) t WHERE value <> '' GROUP BY value ORDER BY count(*) DESC LIMIT 20`,
        params,
      ),
      this.db.query<{ online: string; offline: string; with_prize: string; with_deadline: string; with_conflict: string }>(
        `SELECT
           count(*) FILTER (WHERE h.online_or_offline = 'online')::text AS online,
           count(*) FILTER (WHERE h.online_or_offline IN ('offline','hybrid'))::text AS offline,
           count(*) FILTER (WHERE h.prize_amount > 0)::text AS with_prize,
           count(*) FILTER (WHERE h.registration_deadline IS NOT NULL)::text AS with_deadline,
           count(*) FILTER (WHERE h.deadline_conflict)::text AS with_conflict
         FROM hackathons h ${whereSql}`,
        params,
      ),
    ]);
    const c = counts.rows[0];
    return {
      themes: themes.rows.map((r) => ({ value: r.value, count: Number(r.count) })),
      technologies: technologies.rows.map((r) => ({ value: r.value, count: Number(r.count) })),
      eligibility: eligibility.rows.map((r) => ({ value: r.value.trim(), count: Number(r.count) })),
      online: Number(c?.online ?? 0),
      offline: Number(c?.offline ?? 0),
      withPrize: Number(c?.with_prize ?? 0),
      withDeadline: Number(c?.with_deadline ?? 0),
      withConflict: Number(c?.with_conflict ?? 0),
    };
  }

  private async freshness(): Promise<SearchResponse['dataFreshness']> {
    const res = await this.db.query<{ source: SourceId; at: Date | null }>(
      `SELECT source, MAX(last_verified_at) AS at FROM hackathons GROUP BY source`,
    );
    const sourcesWithData = res.rows.map((r) => r.source);
    const dates = res.rows.map((r) => toIso(r.at)).filter((d): d is string => Boolean(d)).sort();
    return {
      lastIngestAt: dates.length > 0 ? dates[dates.length - 1] : null,
      lastIngestSource: sourcesWithData.length > 0 ? sourcesWithData[0] : null,
      sourcesWithData,
    };
  }

  private async loadSources(ids: string[]): Promise<Map<string, HackathonSourceRef[]>> {
    const out = new Map<string, HackathonSourceRef[]>();
    if (ids.length === 0) return out;
    const res = await this.db.query<{
      hackathon_id: string;
      source: SourceId;
      source_record_id: string;
      source_url: string;
      registration_url: string | null;
      title_raw: string | null;
      organizer_raw: string | null;
      fetch_status: string;
      fetched_at: Date;
    }>(
      `SELECT hackathon_id, source, source_record_id, source_url, registration_url, title_raw, organizer_raw, fetch_status, fetched_at
       FROM hackathon_sources WHERE hackathon_id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of res.rows) {
      const list = out.get(row.hackathon_id) ?? [];
      list.push({
        source: row.source,
        sourceRecordId: row.source_record_id,
        sourceUrl: row.source_url,
        registrationUrl: row.registration_url,
        title: row.title_raw ?? '',
        organizer: row.organizer_raw,
        fetchedAt: toIso(row.fetched_at) ?? '',
        fetchStatus: (row.fetch_status as HackathonSourceRef['fetchStatus']) ?? 'ok',
      });
      out.set(row.hackathon_id, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.source.localeCompare(b.source));
    return out;
  }

  private toHackathon(row: HackathonRow, sources: HackathonSourceRef[], now: Date): Hackathon {
    // The backend recomputes status on every read so a deadline that has since
    // passed flips the row to closed without waiting for a refresh job.
    const recomputed = computeRegistrationStatus({
      deadlineIso: row.registration_deadline,
      precision: guessPrecision(row.registration_deadline ?? '') as never,
      opensIso: row.registration_opens_at,
      now,
    });

    let distance: number | null = null;
    if (typeof row.distance_km === 'number' && Number.isFinite(row.distance_km)) {
      distance = Math.round(row.distance_km * 10) / 10;
    }

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      organizer: row.organizer,
      source: row.source,
      sourceUrl: row.source_url,
      registrationUrl: row.registration_url,
      locationText: row.location_text,
      cityId: row.city_id,
      city: row.city_name,
      cityCanonical: row.city_key,
      state: row.state,
      country: row.country,
      venue: row.venue,
      latitude: toNumber(row.latitude),
      longitude: toNumber(row.longitude),
      eventType: (row.event_type as Hackathon['eventType']) ?? 'hackathon',
      onlineOrOffline: (row.online_or_offline as Hackathon['onlineOrOffline']) ?? 'unknown',
      registrationOpensAt: row.registration_opens_at,
      registrationDeadline: row.registration_deadline,
      registrationDeadlinePrecision: (row.registration_deadline_precision as Hackathon['registrationDeadlinePrecision']) ?? 'none',
      registrationDeadlineTimezone: row.registration_deadline_timezone,
      registrationDeadlineBasis: (row.registration_deadline_basis as Hackathon['registrationDeadlineBasis']) ?? 'unknown',
      registrationStatus: recomputed.status,
      hackathonStart: row.hackathon_start,
      hackathonEnd: row.hackathon_end,
      submissionDeadline: row.submission_deadline,
      ideaSubmissionDeadline: row.idea_submission_deadline,
      finalPresentation: row.final_presentation,
      resultAnnouncement: row.result_announcement,
      teamSizeMin: row.team_size_min,
      teamSizeMax: row.team_size_max,
      eligibility: row.eligibility,
      themes: row.themes ?? [],
      technologies: row.technologies ?? [],
      prizeAmount: toNumber(row.prize_amount),
      prizeCurrency: row.prize_currency,
      prizeDetails: row.prize_details,
      freeOrPaid: (row.free_or_paid as Hackathon['freeOrPaid']) ?? 'unknown',
      registrationFee: toNumber(row.registration_fee),
      registrationFeeCurrency: row.registration_fee_currency,
      dataQuality: (row.data_quality as Hackathon['dataQuality']) ?? 'unknown',
      deadlineConflict: row.deadline_conflict,
      deadlineConflictDetail: (row.deadline_conflict_detail as Hackathon['deadlineConflictDetail']) ?? null,
      fieldConflicts: (row.field_conflicts as Hackathon['fieldConflicts']) ?? null,
      sourceDeadlineText: row.source_deadline_text,
      lastVerifiedAt: toIso(row.last_verified_at) ?? '',
      nextVerificationAt: toIso(row.next_verification_at),
      updatedAt: toIso(row.updated_at) ?? '',
      distanceKm: distance,
      sources,
      provenance: [],
    };
  }
}

function buildOrderBy(sort: SortOption, hasDistance: boolean): string {
  switch (sort) {
    case 'deadline':
      return `h.registration_deadline_ts ASC NULLS LAST, h.hackathon_start_ts ASC NULLS LAST, h.title ASC`;
    case 'event_date':
      return `h.hackathon_start_ts ASC NULLS LAST, h.registration_deadline_ts ASC NULLS LAST, h.title ASC`;
    case 'distance':
      return hasDistance
        ? `distance_km ASC NULLS LAST, h.registration_deadline_ts ASC NULLS LAST`
        : `h.registration_deadline_ts ASC NULLS LAST`;
    case 'prize':
      return `h.prize_amount DESC NULLS LAST, h.registration_deadline_ts ASC NULLS LAST`;
    case 'recently_updated':
      return `h.last_verified_at DESC, h.registration_deadline_ts ASC NULLS LAST`;
    case 'relevance':
    default:
      // Default: still-open registrations first, then the nearest deadline.
      // Records with no deadline sink to the bottom rather than being faked.
      return `CASE ${LIVE_STATUS} WHEN 'open' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END ASC,
              h.registration_deadline_ts ASC NULLS LAST,
              h.hackathon_start_ts ASC NULLS LAST,
              h.last_verified_at DESC,
              h.title ASC`;
  }
}

export { haversineKm };
