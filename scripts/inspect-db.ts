/** Ad-hoc database inspection used during development and demos. */
import { getDb } from '../backend/src/db/client.js';

const db = await getDb();
const tables = await db.query<{ table_name: string }>(
  "select table_name from information_schema.tables where table_schema='public' order by 1",
);
console.log('tables:', tables.rows.map((r) => r.table_name).join(', '));
const indexes = await db.query<{ indexname: string }>(
  "select indexname from pg_indexes where schemaname='public' order by 1",
);
console.log('index count:', indexes.rows.length);
const counts = await db.query<{ table_name: string; n: string }>(`
  SELECT 'cities' AS table_name, count(*)::text AS n FROM cities
  UNION ALL SELECT 'hackathons', count(*)::text FROM hackathons
  UNION ALL SELECT 'hackathon_sources', count(*)::text FROM hackathon_sources
  UNION ALL SELECT 'field_provenance', count(*)::text FROM field_provenance
  UNION ALL SELECT 'crawl_runs', count(*)::text FROM crawl_runs
  UNION ALL SELECT 'geocode_cache', count(*)::text FROM geocode_cache
`);
console.log('row counts:', counts.rows.map((r) => `${r.table_name}=${r.n}`).join(' '));
await db.close();
