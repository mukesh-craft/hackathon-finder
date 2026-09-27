import { getDb, runMigrations } from './client.js';
import { logger } from '../logger.js';

const db = await getDb();
try {
  const ran = await runMigrations(db);
  if (ran.length === 0) logger.info('migrations already up to date');
  else for (const m of ran) logger.info('applied migration', { migration: m });
} finally {
  await db.close();
}
