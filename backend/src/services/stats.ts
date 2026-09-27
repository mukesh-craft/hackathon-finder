import type { PipelineStats, SourceId } from '@hf/shared';
import { ADAPTERS } from '../adapters/index.js';
import { LIVE_STATUS } from './search.js';
import type { Db } from '../db/client.js';

interface CountRow {
  total?: string;
  open?: string;
  closed?: string;
  unknown?: string;
  conflicts?: string;
  missing?: string;
  updated_today?: string;
  city_count?: string;
}

export async function pipelineStats(db: Db): Promise<PipelineStats> {
  const [counts, health, lastRun, dupes] = await Promise.all([
    db.query<CountRow>(`
      SELECT
        count(*)::text AS total,
        count(*) FILTER (WHERE ${LIVE_STATUS} = 'open')::text AS open,
        count(*) FILTER (WHERE ${LIVE_STATUS} = 'closed')::text AS closed,
        count(*) FILTER (WHERE ${LIVE_STATUS} NOT IN ('open','closed'))::text AS unknown,
        count(*) FILTER (WHERE deadline_conflict)::text AS conflicts,
        count(*) FILTER (WHERE registration_deadline IS NULL)::text AS missing,
        count(*) FILTER (WHERE updated_at > date_trunc('day', now()))::text AS updated_today
      FROM hackathons h`),
    db.query<{
      source: SourceId;
      enabled: boolean;
      last_ok_at: Date | null;
      last_error_at: Date | null;
      consecutive_failures: number;
      last_error: string | null;
      avg_duration_ms: number | null;
      success_count: number;
      failure_count: number;
    }>(`SELECT source, enabled, last_ok_at, last_error_at, consecutive_failures, last_error,
                 avg_duration_ms, success_count, failure_count
          FROM source_health`),
    db.query<{ at: Date | null }>(`SELECT MAX(started_at) AS at FROM crawl_runs WHERE status <> 'skipped'`),
    db.query<{ dupes: string }>(`SELECT count(*)::text AS dupes FROM hackathons WHERE is_merged`),
  ]);

  const recordCounts = await db.query<{ source: SourceId; n: string }>(
    'SELECT source, count(*)::text AS n FROM hackathons GROUP BY source',
  );
  const bySource = new Map(recordCounts.rows.map((r) => [r.source, Number(r.n)]));
  const c = counts.rows[0] ?? {};

  const healthBySource = new Map(health.rows.map((r) => [r.source, r]));
  const sources = ADAPTERS.map((adapter) => {
    const row = healthBySource.get(adapter.id);
    let health: PipelineStats['sources'][number]['health'];
    if (!adapter.enabled) health = 'disabled';
    else if (!row || (!row.last_ok_at && !row.last_error_at)) health = 'unknown';
    else if (row.consecutive_failures >= 3) health = 'failing';
    else if (row.consecutive_failures > 0) health = 'degraded';
    else health = 'healthy';
    return {
      source: adapter.id,
      lastOkAt: row?.last_ok_at ? new Date(row.last_ok_at).toISOString() : null,
      lastErrorAt: row?.last_error_at ? new Date(row.last_error_at).toISOString() : null,
      consecutiveFailures: row?.consecutive_failures ?? 0,
      lastError: row?.last_error ?? null,
      successCount: row?.success_count ?? 0,
      failureCount: row?.failure_count ?? 0,
      avgDurationMs: row?.avg_duration_ms ?? null,
      records: bySource.get(adapter.id) ?? 0,
      health,
    };
  });

  return {
    totals: {
      hackathons: Number(c.total ?? 0),
      openRegistrations: Number(c.open ?? 0),
      closedRegistrations: Number(c.closed ?? 0),
      unknownRegistration: Number(c.unknown ?? 0),
      deadlineConflicts: Number(c.conflicts ?? 0),
      missingDeadlines: Number(c.missing ?? 0),
      duplicateCandidates: Number(dupes.rows[0]?.dupes ?? 0),
      updatedToday: Number(c.updated_today ?? 0),
    },
    sources,
    lastCrawlAt: lastRun.rows[0]?.at ? new Date(lastRun.rows[0].at as Date).toISOString() : null,
    cityCount: Number(
      (await db.query<CountRow>('SELECT count(*)::text AS city_count FROM cities WHERE event_count > 0')).rows[0]?.city_count ?? 0,
    ),
  };
}

export interface RecentCrawlRow {
  id: string;
  source: SourceId;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  records_seen: number;
  records_upserted: number;
  records_failed: number;
  duration_ms: number | null;
  error: string | null;
}

export async function recentCrawls(db: Db, limit = 25): Promise<RecentCrawlRow[]> {
  const res = await db.query<RecentCrawlRow>(
    `SELECT id, source, started_at, finished_at, status, records_seen, records_upserted, records_failed, duration_ms, error
     FROM crawl_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}
