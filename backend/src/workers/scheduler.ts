/**
 * Background refresh.
 *
 * Freshness policy lives in services/quality.ts; this module only decides *when*
 * to act and makes sure work is spread out. It runs two kinds of job:
 *
 *   1. status refresh — recompute open/closed for every record, so a deadline
 *      that has since passed flips the row to "closed" even if no source changed
 *   2. source crawl — periodic, per-source, with an in-flight guard so two ticks
 *      can never overlap
 *
 * A crawl that fails leaves the previous data in place and is recorded as failed;
 * search keeps serving stale-but-labelled data rather than failing.
 */
import type { Db } from '../db/client.js';
import { CrawlService } from '../services/crawl.js';
import { refreshStatuses } from '../services/status-refresh.js';
import { ADAPTERS } from '../adapters/index.js';
import { config } from '../config.js';
import { logger as rootLogger } from '../logger.js';
import type { AdapterLogger } from '../adapters/types.js';

export interface SchedulerHandle {
  stop: () => void;
}

export { refreshStatuses };

/** Records whose next verification time has arrived, most urgent first. */
export async function dueForVerification(db: Db, limit: number): Promise<Array<{ id: string; slug: string; source: string }>> {
  const res = await db.query<{ id: string; slug: string; source: string }>(
    `SELECT id, slug, source FROM hackathons
     WHERE next_verification_at IS NOT NULL AND next_verification_at <= now()
     ORDER BY next_verification_at ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}

export function startRefreshScheduler(db: Db, logger: AdapterLogger = rootLogger): SchedulerHandle {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await refreshStatuses(db, logger);
      const due = await dueForVerification(db, config.refresh.batchSize);
      if (due.length > 0) {
        logger.info('due for verification', { count: due.length });
      }
      // Full re-crawl of each enabled source, staggered. CRAWL_ON_START lets a
      // fresh deployment populate itself without waiting a full interval.
      const service = new CrawlService(db, logger);
      for (const adapter of ADAPTERS) {
        if (stopped) break;
        if (!adapter.enabled) continue;
        try {
          await service.crawl({ sources: [adapter.id], geocodeVenues: false, logger });
        } catch (err) {
          logger.warn('scheduled crawl failed', { source: adapter.id, error: (err as Error).message });
        }
      }
    } catch (err) {
      logger.error('scheduler tick failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.refresh.intervalMs);
  timer.unref?.();

  if (!config.isTest) {
    // Small delay so the HTTP server is listening before the first crawl.
    setTimeout(() => void tick(), 2_000).unref?.();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
