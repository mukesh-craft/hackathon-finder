/**
 * Standalone refresh worker.
 *
 * Run this as a separate process from the API in production so a long crawl can
 * never compete with user requests for the Node event loop:
 *
 *   node --experimental-strip-types workers/refresh-worker.ts
 *   # or, after `npm run build -w backend`:
 *   node dist/workers/refresh-worker.js
 */
import { getDb, runMigrations } from '../backend/src/db/client.js';
import { CrawlService } from '../backend/src/services/crawl.js';
import { refreshStatuses, dueForVerification } from '../backend/src/workers/scheduler.js';
import { ADAPTERS } from '../backend/src/adapters/index.js';
import { config } from '../backend/src/config.js';
import { logger } from '../backend/src/logger.js';

const db = await getDb();
await runMigrations(db);

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('worker shutdown requested', { signal });
    controller.abort();
  });
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await refreshStatuses(db, logger);
    const due = await dueForVerification(db, config.refresh.batchSize);
    logger.info('refresh tick', { due: due.length });
    const crawl = new CrawlService(db, logger);
    for (const adapter of ADAPTERS) {
      if (controller.signal.aborted) break;
      if (!adapter.enabled) {
        logger.info('skipping disabled source', { source: adapter.id });
        continue;
      }
      try {
        const summary = await crawl.crawl({ sources: [adapter.id], geocodeVenues: false, logger, signal: controller.signal });
        const result = summary.results[0];
        logger.info('source refreshed', {
          source: adapter.id,
          ok: result?.ok ?? false,
          records: result?.records ?? 0,
          merged: result?.merged ?? 0,
          error: result?.error ?? null,
        });
      } catch (err) {
        logger.warn('source refresh failed', { source: adapter.id, error: (err as Error).message });
      }
    }
  } catch (err) {
    logger.error('worker tick failed', { error: (err as Error).message });
  } finally {
    running = false;
  }
}

logger.info('refresh worker started', { intervalMs: config.refresh.intervalMs });
void tick();
const timer = setInterval(() => void tick(), config.refresh.intervalMs);

const shutdown = () => {
  clearInterval(timer);
  void db.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
