import { getDb, runMigrations } from './db/client.js';
import { buildServer } from './http/server.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { startRefreshScheduler } from './workers/scheduler.js';

const db = await getDb();
const applied = await runMigrations(db);
for (const m of applied) logger.info('applied migration', { migration: m });

const app = await buildServer(db);

const close = async (signal: string) => {
  logger.info('shutting down', { signal });
  stopScheduler();
  await app.close();
  await db.close();
  process.exit(0);
};

let stopScheduler: () => void = () => {};
if (config.refresh.enabled) {
  stopScheduler = startRefreshScheduler(db, logger).stop;
}

process.on('SIGINT', () => void close('SIGINT'));
process.on('SIGTERM', () => void close('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  logger.info('server listening', {
    url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
    driver: db.driver,
  });
  void maybeSeedOnBoot(db);
} catch (err) {
  logger.error('failed to start', { error: (err as Error).message });
  process.exit(1);
}

/**
 * First-boot seeding for fresh deploys (e.g. free-tier hosts with no shell
 * access handy). Only fires on a completely empty database, runs behind
 * listen(), and failures only log — the API serves whatever exists.
 */
async function maybeSeedOnBoot(db: import('./db/client.js').Db): Promise<void> {
  const { maybeSeedOnBoot: seed } = await import('./boot-seed.js');
  await seed({
    db,
    logger,
    onBoot: config.ingest.onBoot,
    crawl: async (crawlDb, crawlLogger) => {
      const { CrawlService } = await import('./services/crawl.js');
      // Light profile only: fast sources, no venue geocoding. Devpost detail
      // enrichment joins in via the scheduled refresh afterwards.
      await new CrawlService(crawlDb, crawlLogger).crawl({
        sources: ['unstop', 'mlh'],
        geocodeVenues: false,
        logger: crawlLogger,
      });
    },
  });
}
