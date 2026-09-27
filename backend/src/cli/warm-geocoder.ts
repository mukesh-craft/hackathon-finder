/**
 * Warm the geocode cache for every city that has events, so search can offer
 * distance filters. Uses the real geocoder; nothing is invented offline.
 */
import { getDb, runMigrations } from '../db/client.js';
import { CityService } from '../services/cities.js';
import { logger } from '../logger.js';

const db = await getDb();
await runMigrations(db);
const cities = new CityService(db);
await cities.seedRegistry();

const rows = await db.query<{ id: string }>(
  `SELECT DISTINCT c.id FROM cities c JOIN hackathons h ON h.city_id = c.id
   WHERE c.latitude IS NULL ORDER BY c.id`,
);

let done = 0;
for (const row of rows.rows) {
  const city = await cities.getById(row.id);
  if (!city) continue;
  await cities.ensureCoordinates(city);
  done += 1;
  logger.info('geocoded city', { city: city.name, done, total: rows.rows.length });
}
logger.info('geocoder warm-up complete', { cities: done });
await db.close();
