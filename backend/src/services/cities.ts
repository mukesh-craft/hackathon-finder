/**
 * City resolution against the database.
 *
 * Two jobs:
 *  1. `resolveQuery` — turn what a user typed into a canonical city plus the set
 *     of place keys that count as "in" that city (canonical + metro area).
 *  2. `ensureCityForRecord` — give an ingested event a `cities` row, mapping
 *     "Bangalore Urban" onto Bengaluru and "Karjat" onto itself within the Mumbai
 *     metro, without ever moving an event to its organizer's city.
 */
import type { Db } from '../db/client.js';
import type { CityDefinition, ResolvedCity } from '@hf/shared';
import {
  CITY_INDEX,
  matchCity,
  metroMembersFor,
  metroLabel,
  normalizeKey,
  stripRegionSuffixes,
  stripDiacritics,
} from '@hf/shared';
import { Geocoder } from './geocode.js';

export interface CityRow {
  id: string;
  name: string;
  normalized_name: string;
  state: string | null;
  country: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  metro: string | null;
  is_locality: boolean;
  geocode_source: string | null;
}

function slugifyCity(name: string): string {
  return (
    stripDiacritics(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unknown'
  );
}

export class CityService {
  private readonly geocoder: Geocoder;

  constructor(private readonly db: Db) {
    this.geocoder = new Geocoder(db);
  }

  /** Register every city in the static registry so autocomplete and joins work. */
  async seedRegistry(): Promise<number> {
    let count = 0;
    for (const def of CITY_INDEX.all) {
      const normalized = normalizeKey(def.name);
      await this.db.query(
        `INSERT INTO cities (id, name, normalized_name, state, country, country_code, metro, is_locality, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name,
                                        state = EXCLUDED.state, country = EXCLUDED.country,
                                        country_code = EXCLUDED.country_code, metro = EXCLUDED.metro,
                                        is_locality = EXCLUDED.is_locality, updated_at = now()`,
        [def.slug, def.name, normalized, def.state ?? null, def.country, def.countryCode, def.metro ?? null, def.locality ?? false],
      );
      count += 1;
    }
    return count;
  }

  async getById(id: string): Promise<CityRow | null> {
    const res = await this.db.query<CityRow>('SELECT * FROM cities WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }

  async findByNormalized(name: string, state?: string | null): Promise<CityRow | null> {
    const normalized = stripRegionSuffixes(name);
    const res = await this.db.query<CityRow>(
      `SELECT * FROM cities
       WHERE normalized_name = $1 AND (state IS NOT DISTINCT FROM $2)
       ORDER BY is_locality ASC LIMIT 1`,
      [normalized, state ?? null],
    );
    if (res.rows[0]) return res.rows[0];
    const any = await this.db.query<CityRow>(
      'SELECT * FROM cities WHERE normalized_name = $1 ORDER BY is_locality ASC LIMIT 1',
      [normalized],
    );
    return any.rows[0] ?? null;
  }

  /**
   * Resolve a user query. Falls back to geocoding when the place is not in the
   * registry, so a city we have never heard of still produces a radius search.
   */
  async resolveQuery(query: string, opts: { includeMetro?: boolean } = {}): Promise<ResolvedCity> {
    const trimmed = query.trim();
    const notes: string[] = [];
    const match = matchCity(trimmed, { includeMetro: opts.includeMetro ?? true });

    if (match.primary) {
      const def = match.primary;
      const row = await this.getById(def.slug);
      const members = metroMembersFor(def.metro);
      notes.push(...match.notes);
      return {
        query: trimmed,
        name: def.name,
        slug: def.slug,
        state: def.state ?? row?.state ?? null,
        country: def.country,
        countryCode: def.countryCode,
        latitude: row?.latitude ?? null,
        longitude: row?.longitude ?? null,
        match: match.match,
        notes,
        aliases: def.aliases ?? [],
        metroMembers: members.map((m: CityDefinition) => m.name),
        geocodeSource: row?.geocode_source ?? null,
      };
    }

    // Unknown to the registry: geocode the raw text.
    const bare = stripRegionSuffixes(trimmed) || trimmed;
    const geo = await this.geocoder.geocode(trimmed);
    if (geo) {
      notes.push(`"${trimmed}" is not in our city list; matched by geocoding to ${geo.displayName ?? bare}.`);
      const cityRow = await this.upsertCity({
        name: bare,
        state: null,
        country: null,
        latitude: geo.latitude,
        longitude: geo.longitude,
        geocodeSource: geo.provider,
      });
      return {
        query: trimmed,
        name: cityRow.name,
        slug: cityRow.id,
        state: cityRow.state,
        country: cityRow.country,
        countryCode: cityRow.country_code,
        latitude: geo.latitude,
        longitude: geo.longitude,
        match: 'exact',
        notes,
        aliases: [],
        metroMembers: [],
        geocodeSource: geo.provider,
      };
    }

    notes.push(`Could not resolve "${trimmed}" to a known city.`);
    return {
      query: trimmed,
      name: null,
      slug: null,
      state: null,
      country: null,
      countryCode: null,
      latitude: null,
      longitude: null,
      match: 'unknown',
      notes,
      aliases: [],
      metroMembers: [],
      geocodeSource: null,
    };
  }

  /**
   * Place keys a search should accept. Includes the canonical city, its aliases
   * and its metro siblings so "Chennai" finds an event in Ambattur.
   */
  async searchKeysFor(query: string, includeMetro: boolean): Promise<{ keys: string[]; metro: string | null }> {
    const match = matchCity(query, { includeMetro: includeMetro });
    if (match.primary) {
      const defs = includeMetro ? [match.primary, ...metroMembersFor(match.primary.metro)] : [match.primary];
      const keys = new Set<string>();
      for (const def of defs) {
        keys.add(def.slug);
        keys.add(normalizeKey(def.name));
        for (const alias of def.aliases ?? []) keys.add(normalizeKey(alias));
      }
      return { keys: [...keys], metro: defs[0].metro ?? null };
    }
    const bare = stripRegionSuffixes(query) || normalizeKey(query);
    return { keys: bare ? [bare, slugifyCity(bare)] : [], metro: null };
  }

  /**
   * Map an ingested event's own city text onto a cities row.
   * The event's location is authoritative; the organizer is never consulted.
   */
  async ensureCityForRecord(input: {
    city: string | null;
    state?: string | null;
    country?: string | null;
  }): Promise<CityRow | null> {
    const rawCity = (input.city ?? '').trim();
    if (!rawCity) return null;

    // 1. Known canonical city or alias ("Bangalore" -> Bengaluru, "Madras" -> Chennai).
    const match = matchCity(rawCity, { includeMetro: false });
    if (match.primary) {
      const existing = await this.getById(match.primary.slug);
      if (existing) return existing;
    }

    // 2. Exact normalized match on a city we have already stored.
    const found = await this.findByNormalized(rawCity, input.state ?? null);
    if (found) return found;

    // 3. Unknown locality: store it under its own id but inherit the metro when
    //    the text places it inside a known metro area.
    const normalized = normalizeKey(rawCity);
    const inherited = match.primary?.metro ?? metroForLocality(rawCity) ?? null;
    const isLocality = match.primary?.locality ?? true;
    const definition = CITY_INDEX.all.find((d) => normalizeKey(d.name) === normalized);

    return this.upsertCity({
      name: definition?.name ?? rawCity,
      state: input.state ?? definition?.state ?? null,
      country: input.country ?? definition?.country ?? null,
      countryCode: definition?.countryCode ?? null,
      metro: inherited,
      isLocality,
      latitude: null,
      longitude: null,
      geocodeSource: null,
    });
  }

  /** Geocode a city row that has no coordinates yet. Never fabricates. */
  async ensureCoordinates(city: CityRow): Promise<CityRow> {
    if (isFiniteCoord(city.latitude, city.longitude)) return city;
    const query = [city.name, city.state, city.country].filter(Boolean).join(', ');
    const geo = await this.geocoder.geocode(query, { countryCode: city.country_code });
    if (!geo) return city;
    await this.db.query(
      'UPDATE cities SET latitude = $1, longitude = $2, geocode_source = $3, geocoded_at = now(), updated_at = now() WHERE id = $4',
      [geo.latitude, geo.longitude, geo.provider, city.id],
    );
    return { ...city, latitude: geo.latitude, longitude: geo.longitude, geocode_source: geo.provider };
  }

  /**
   * Geocode a specific venue address, so distance to the searched city reflects
   * the actual campus rather than the city centroid.
   */
  async geocodeVenue(venue: string, cityName?: string | null, country?: string | null): Promise<{ lat: number; lon: number; source: string } | null> {
    const query = [venue, cityName, country].filter(Boolean).join(', ');
    if (query.length < 8) return null;
    const geo = await this.geocoder.geocode(query);
    if (!geo) return null;
    return { lat: geo.latitude, lon: geo.longitude, source: geo.provider };
  }

  async upsertCity(input: {
    name: string;
    state?: string | null;
    country?: string | null;
    countryCode?: string | null;
    metro?: string | null;
    isLocality?: boolean;
    latitude?: number | null;
    longitude?: number | null;
    geocodeSource?: string | null;
  }): Promise<CityRow> {
    const id = slugifyCity(input.name);
    const normalized = normalizeKey(input.name);
    await this.db.query(
      `INSERT INTO cities (id, name, normalized_name, state, country, country_code, metro, is_locality, latitude, longitude, geocode_source, geocoded_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $9::float8 IS NULL THEN NULL ELSE now() END, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         normalized_name = EXCLUDED.normalized_name,
         state = COALESCE(EXCLUDED.state, cities.state),
         country = COALESCE(EXCLUDED.country, cities.country),
         country_code = COALESCE(EXCLUDED.country_code, cities.country_code),
         metro = COALESCE(EXCLUDED.metro, cities.metro),
         is_locality = EXCLUDED.is_locality,
         latitude = COALESCE(cities.latitude, EXCLUDED.latitude),
         longitude = COALESCE(cities.longitude, EXCLUDED.longitude),
         geocode_source = COALESCE(cities.geocode_source, EXCLUDED.geocode_source),
         updated_at = now()`,
      [
        id,
        input.name,
        normalized,
        input.state ?? null,
        input.country ?? null,
        input.countryCode ?? null,
        input.metro ?? null,
        input.isLocality ?? false,
        input.latitude ?? null,
        input.longitude ?? null,
        input.geocodeSource ?? null,
      ],
    );
    const row = await this.getById(id);
    if (!row) throw new Error(`Failed to upsert city ${id}`);
    return row;
  }

  async listCitiesWithEvents(limit = 50): Promise<Array<{ id: string; name: string; state: string | null; country: string | null; latitude: number | null; longitude: number | null; event_count: number; open_count: number }>> {
    const res = await this.db.query<{
      id: string;
      name: string;
      state: string | null;
      country: string | null;
      latitude: number | null;
      longitude: number | null;
      event_count: string;
      open_count: string;
    }>(
      `SELECT c.id, c.name, c.state, c.country, c.latitude, c.longitude,
              count(h.id) FILTER (WHERE h.id IS NOT NULL) AS event_count,
              count(h.id) FILTER (WHERE h.registration_status = 'open') AS open_count
       FROM cities c
       LEFT JOIN hackathons h ON h.city_id = c.id
       GROUP BY c.id
       HAVING count(h.id) > 0
       ORDER BY open_count DESC, event_count DESC, c.name
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      ...r,
      event_count: Number(r.event_count),
      open_count: Number(r.open_count),
    }));
  }
}

function isFiniteCoord(lat: unknown, lon: unknown): boolean {
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon);
}

/**
 * Infer the metro of a locality we do not have in the registry, using the
 * registry's own alias and compound-name knowledge. Returns null rather than
 * guessing when nothing matches.
 */
function metroForLocality(rawCity: string): string | null {
  const key = stripRegionSuffixes(rawCity);
  for (const def of CITY_INDEX.all) {
    const name = normalizeKey(def.name);
    if (!name) continue;
    if (key === name || key.startsWith(`${name} `) || key.endsWith(` ${name}`)) {
      return def.metro ?? null;
    }
    for (const alias of def.aliases ?? []) {
      const a = normalizeKey(alias);
      if (a && (key === a || key.startsWith(`${a} `) || key.endsWith(` ${a}`))) return def.metro ?? null;
    }
  }
  return null;
}

export { metroLabel };
