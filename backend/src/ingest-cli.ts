/**
 * Ingestion CLI: `npm run ingest -- --sources unstop,devpost --venues`
 */
import { getDb, runMigrations } from './db/client.js';
import { CrawlService } from './services/crawl.js';
import { logger } from './logger.js';
import type { SourceId } from '@hf/shared';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const sources = value('sources')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean) as SourceId[] | undefined;

const db = await getDb();
await runMigrations(db);
const service = new CrawlService(db, logger);

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

try {
  logger.info('starting crawl', { sources: sources ?? 'all enabled', venues: flag('venues') });
  const summary = await service.crawl({
    sources,
    geocodeVenues: flag('venues'),
    logger,
    signal: controller.signal,
  });
  for (const r of summary.results) {
    logger.info('source result', {
      source: r.source,
      ok: r.ok,
      records: r.records,
      inserted: r.inserted,
      updated: r.updated,
      merged: r.merged,
      failed: r.failed,
      ms: r.durationMs,
      error: r.error ?? r.skipped ?? null,
    });
  }
  logger.info('crawl complete', summary.totals as unknown as Record<string, unknown>);
} catch (err) {
  logger.error('crawl failed', { error: (err as Error).message });
  process.exitCode = 1;
} finally {
  await db.close();
}
