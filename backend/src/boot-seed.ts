/**
 * First-boot seeding. Extracted from the server entrypoint so the decision
 * logic is unit-testable without booting anything.
 */
import type { Db } from './db/client.js';
import { logger as rootLogger } from './logger.js';
import type { AdapterLogger } from './adapters/types.js';

export type SeedOutcome = 'seeded' | 'skipped-disabled' | 'skipped-nonempty' | 'failed';

export async function maybeSeedOnBoot(opts: {
  db: Db;
  logger?: AdapterLogger;
  onBoot: boolean;
  crawl: (db: Db, logger: AdapterLogger) => Promise<unknown>;
}): Promise<SeedOutcome> {
  const logger = opts.logger ?? rootLogger;
  if (!opts.onBoot) return 'skipped-disabled';
  try {
    const count = await opts.db.query<{ n: string }>('SELECT count(*)::text AS n FROM hackathons');
    if (Number(count.rows[0]?.n ?? 0) > 0) {
      logger.info('boot seed skipped: database already has hackathons');
      return 'skipped-nonempty';
    }
    logger.info('boot seed starting: empty database, crawling in background');
    await opts.crawl(opts.db, logger);
    return 'seeded';
  } catch (err) {
    logger.warn('boot seed failed; API continues serving', { error: (err as Error).message });
    return 'failed';
  }
}
