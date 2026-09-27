/**
 * Crawl orchestration.
 *
 * Runs each adapter in isolation and records what happened. A source that
 * throws, times out or returns garbage is marked unhealthy and skipped; the
 * other sources still deliver data and the API keeps serving.
 */
import type { SourceId } from '@hf/shared';
import type { Db } from '../db/client.js';
import { newId } from '../db/client.js';
import { ADAPTERS, getAdapter } from '../adapters/index.js';
import type { AdapterLogger, SourceAdapter } from '../adapters/types.js';
import { IngestService } from './ingest.js';
import { refreshStatuses } from './status-refresh.js';
import { CityService } from './cities.js';

export interface CrawlOptions {
  sources?: SourceId[];
  geocodeVenues?: boolean;
  logger: AdapterLogger;
  signal?: AbortSignal;
}

export interface SourceCrawlResult {
  source: SourceId;
  ok: boolean;
  records: number;
  failed: number;
  inserted: number;
  updated: number;
  merged: number;
  duplicates: number;
  durationMs: number;
  error?: string;
  skipped?: string;
}

export interface CrawlSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: SourceCrawlResult[];
  totals: { records: number; inserted: number; updated: number; merged: number; failed: number };
}

export class CrawlService {
  private readonly ingest: IngestService;

  constructor(private readonly db: Db, private readonly logger: AdapterLogger) {
    this.ingest = new IngestService(db, { logger, geocodeVenues: true, maxVenueGeocodes: 400 });
  }

  async crawl(options: CrawlOptions): Promise<CrawlSummary> {
    const startedAt = new Date();
    const wanted = options.sources?.length
      ? options.sources.map((id) => getAdapter(id)).filter((a): a is SourceAdapter => Boolean(a))
      : ADAPTERS;

    const cities = new CityService(this.db);
    await cities.seedRegistry();

    const results: SourceCrawlResult[] = [];
    for (const adapter of wanted) {
      results.push(await this.crawlOne(adapter, options));
    }

    // Newly ingested deadlines can flip other rows' effective status (and the
    // crawl itself takes minutes), so reconcile the cached status column before
    // returning. Search filters derive status live in SQL regardless.
    try {
      await refreshStatuses(this.db, this.logger);
    } catch (err) {
      this.logger.warn('post-crawl status refresh failed', { error: (err as Error).message });
    }

    const finishedAt = new Date();
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      results,
      totals: {
        records: results.reduce((s, r) => s + r.records, 0),
        inserted: results.reduce((s, r) => s + r.inserted, 0),
        updated: results.reduce((s, r) => s + r.updated, 0),
        merged: results.reduce((s, r) => s + r.merged, 0),
        failed: results.reduce((s, r) => s + r.failed, 0),
      },
    };
  }

  private async crawlOne(adapter: SourceAdapter, options: CrawlOptions): Promise<SourceCrawlResult> {
    const runId = newId();
    const started = Date.now();
    const base: SourceCrawlResult = {
      source: adapter.id,
      ok: false,
      records: 0,
      failed: 0,
      inserted: 0,
      updated: 0,
      merged: 0,
      duplicates: 0,
      durationMs: 0,
    };

    if (!adapter.enabled) {
      const skipped: SourceCrawlResult = { ...base, ok: true, skipped: 'disabled by configuration/policy', durationMs: 0 };
      await this.recordRun(runId, adapter.id, { status: 'skipped', error: skipped.skipped, durationMs: 0 });
      await this.recordHealth(adapter.id, { enabled: false });
      this.logger.info('adapter skipped', { source: adapter.id, reason: skipped.skipped });
      return skipped;
    }

    await this.db.query(
      'INSERT INTO crawl_runs (id, source, status) VALUES ($1,$2,$3)',
      [runId, adapter.id, 'running'],
    );

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const counters = { records: 0, failed: 0, inserted: 0, updated: 0, merged: 0, duplicates: 0 };

    try {
      const outcome = await adapter.run({
        signal: controller.signal,
        log: this.logger,
        onRecord: async (record) => {
          try {
            const stats = await this.ingest.ingest(record, { geocodeVenues: options.geocodeVenues });
            counters.records += stats.seen;
            counters.inserted += stats.inserted;
            counters.updated += stats.updated;
            counters.merged += stats.merged;
            counters.duplicates += stats.duplicates;
            counters.failed += stats.rejected;
          } catch (err) {
            counters.failed += 1;
            this.logger.warn('record failed to persist', {
              source: adapter.id,
              id: record.sourceRecordId,
              error: (err as Error).message,
            });
          }
        },
      });
      counters.records = outcome.records;
      counters.failed += outcome.failed;
      const durationMs = Date.now() - started;
      const ok = counters.failed === 0 || counters.records > 0;
      await this.recordRun(runId, adapter.id, {
        status: ok ? 'ok' : 'failed',
        recordsSeen: outcome.records,
        recordsUpserted: counters.inserted + counters.updated,
        recordsFailed: counters.failed,
        durationMs,
        error: ok ? null : `${counters.failed} records failed`,
      });
      await this.recordHealth(adapter.id, { enabled: true, ok: true, durationMs });
      return { ...base, ok, ...counters, durationMs };
    } catch (err) {
      const durationMs = Date.now() - started;
      const message = (err as Error).message;
      await this.recordRun(runId, adapter.id, {
        status: 'failed',
        recordsSeen: counters.records,
        recordsUpserted: counters.inserted + counters.updated,
        recordsFailed: counters.failed + 1,
        durationMs,
        error: message,
      });
      await this.recordHealth(adapter.id, { enabled: true, ok: false, durationMs, error: message });
      this.logger.error('adapter crawl failed', { source: adapter.id, error: message });
      return { ...base, ...counters, ok: false, durationMs, error: message };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async recordRun(
    runId: string,
    source: SourceId,
    data: {
      status: string;
      error?: string | null;
      recordsSeen?: number;
      recordsUpserted?: number;
      recordsFailed?: number;
      durationMs?: number;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE crawl_runs SET finished_at = now(), status = $2, records_seen = $3, records_upserted = $4,
              records_failed = $5, duration_ms = $6, error = $7
       WHERE id = $1`,
      [
        runId,
        data.status,
        data.recordsSeen ?? 0,
        data.recordsUpserted ?? 0,
        data.recordsFailed ?? 0,
        data.durationMs ?? 0,
        data.error ?? null,
      ],
    );
  }

  private async recordHealth(
    source: SourceId,
    data: { enabled: boolean; ok?: boolean; durationMs?: number; error?: string },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO source_health (source, enabled, last_ok_at, last_error_at, consecutive_failures, last_error, avg_duration_ms, success_count, failure_count, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (source) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         last_ok_at = CASE WHEN $10::boolean THEN now() ELSE source_health.last_ok_at END,
         last_error_at = CASE WHEN $10::boolean THEN source_health.last_error_at ELSE now() END,
         consecutive_failures = CASE WHEN $10::boolean THEN 0 ELSE source_health.consecutive_failures + 1 END,
         last_error = CASE WHEN $10::boolean THEN source_health.last_error ELSE EXCLUDED.last_error END,
         avg_duration_ms = CASE WHEN $10::boolean THEN EXCLUDED.avg_duration_ms
                                ELSE COALESCE(source_health.avg_duration_ms, EXCLUDED.avg_duration_ms) END,
         success_count = source_health.success_count + CASE WHEN $10::boolean THEN 1 ELSE 0 END,
         failure_count = source_health.failure_count + CASE WHEN $10::boolean THEN 0 ELSE 1 END,
         updated_at = now()`,
      [
        source,
        data.enabled,
        data.ok ? new Date().toISOString() : null,
        data.ok ? null : new Date().toISOString(),
        data.ok ? 0 : 1,
        data.ok ? null : (data.error ?? 'unknown error'),
        data.durationMs ?? null,
        data.ok ? 1 : 0,
        data.ok ? 0 : 1,
        Boolean(data.ok),
      ],
    );
  }
}
