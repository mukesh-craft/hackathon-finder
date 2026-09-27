/** Verify real search results straight from the database. */
import { getDb } from '../backend/src/db/client.js';
import { SearchService } from '../backend/src/services/search.js';
import { CityService } from '../backend/src/services/cities.js';
import { formatDeadline, countdownTo } from '@hf/shared';

const db = await getDb();
const search = new SearchService(db);
const cities = new CityService(db);

const counts = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM hackathons');
const byStatus = await db.query<{ registration_status: string; n: string }>(
  'SELECT registration_status, count(*)::text AS n FROM hackathons GROUP BY 1 ORDER BY 2 DESC',
);
const byQuality = await db.query<{ data_quality: string; n: string }>(
  'SELECT data_quality, count(*)::text AS n FROM hackathons GROUP BY 1 ORDER BY 2 DESC',
);
const bySource = await db.query<{ source: string; n: string }>('SELECT source, count(*)::text AS n FROM hackathons GROUP BY 1');
const geocoded = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM hackathons WHERE latitude IS NOT NULL');

console.log('total:', counts.rows[0].n);
console.log('by status:', byStatus.rows.map((r) => `${r.registration_status}=${r.n}`).join(' '));
console.log('by quality:', byQuality.rows.map((r) => `${r.data_quality}=${r.n}`).join(' '));
console.log('by source:', bySource.rows.map((r) => `${r.source}=${r.n}`).join(' '));
console.log('with coordinates:', geocoded.rows[0].n);

for (const city of ['Chennai', 'Bangalore', 'Mumbai', 'Delhi', 'Hyderabad', 'Pune']) {
  const resolved = await cities.resolveQuery(city);
  const res = await search.search({ city, page: 1, limit: 50, openOnly: false, radiusKm: 50, mode: 'all', sort: 'relevance' });
  console.log(`\n### ${city} -> ${resolved.name} (match=${resolved.match}, total=${res.total})`);
  for (const h of res.results.slice(0, 5)) {
    const dl = formatDeadline(h.registrationDeadline, { sourceTimezoneLabel: h.registrationDeadlineTimezone });
    const cd = countdownTo(h.registrationDeadline);
    console.log(
      `  - ${h.title.slice(0, 40).padEnd(42)} | ${String(h.city).padEnd(14)} | ${h.registrationStatus.padEnd(8)} | ${dl.main} | ${cd.label} | q=${h.dataQuality} | prize=${h.prizeAmount ?? '-'}${h.prizeCurrency ?? ''} | team=${h.teamSizeMin ?? '?'}-${h.teamSizeMax ?? '?'}`,
    );
  }
}
await db.close();
