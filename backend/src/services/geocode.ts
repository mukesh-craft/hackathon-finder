/**
 * Geocoding backed by a real provider, cached in PostgreSQL.
 *
 * No coordinate in this project is hand-written. Every latitude/longitude the
 * application uses comes from a provider response stored in `geocode_cache`
 * together with the provider name and the raw payload, so a coordinate can always
 * be traced to its origin.
 *
 * Provider: Photon (https://photon.komoot.io), an OpenStreetMap-based geocoder.
 * Nominatim is the other common option but its public instance refuses traffic
 * from many cloud/hosting IP ranges, which is why it is not the default here.
 */
import type { Db } from '../db/client.js';
import { config } from '../config.js';
import { safeFetchJson } from '../http/safe-fetch.js';
import { isValidLatLon } from '@hf/shared';

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName: string | null;
  provider: string;
  /** True when the answer came from the cache rather than the network. */
  cached: boolean;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    type?: string;
    osm_type?: string;
    osm_key?: string;
    extent?: { south?: number; north?: number; west?: number; east?: number };
  };
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

let lastCallAt = 0;

async function throttle(): Promise<void> {
  const wait = config.geocoder.minIntervalMs - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function cacheKey(query: string, countryCode?: string | null): string {
  return `${config.geocoder.provider}:${countryCode ?? ''}:${query.trim().toLowerCase()}`;
}

export class Geocoder {
  constructor(private readonly db: Db) {}

  async geocode(query: string, opts: { countryCode?: string | null; fresh?: boolean } = {}): Promise<GeocodeResult | null> {
    const trimmed = query.trim();
    if (!trimmed) return null;
    const key = cacheKey(trimmed, opts.countryCode);

    if (!opts.fresh) {
      const cached = await this.db.query<{
        latitude: string | number | null;
        longitude: string | number | null;
        display_name: string | null;
        provider: string;
      }>('SELECT latitude, longitude, display_name, provider FROM geocode_cache WHERE cache_key = $1', [key]);
      const row = cached.rows[0];
      if (row && isValidLatLon(Number(row.latitude), Number(row.longitude))) {
        return {
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          displayName: row.display_name,
          provider: row.provider,
          cached: true,
        };
      }
    }

    if (!config.geocoder.enabled || config.isTest) {
      // Offline / test: no coordinates invented, simply unresolved.
      return null;
    }

    await throttle();
    let response: PhotonResponse;
    try {
      const params = new URLSearchParams({ q: trimmed, limit: '5' });
      if (opts.countryCode) params.set('countrycode', opts.countryCode.toLowerCase());
      response = await safeFetchJson<PhotonResponse>(`${config.geocoder.endpoint}?${params.toString()}`, {
        timeoutMs: config.geocoder.timeoutMs,
        retries: 2,
        accept: 'application/json',
      });
    } catch {
      return null;
    }

    const best = pickBest(response.features ?? []);
    if (!best) {
      await this.db.query(
        'INSERT INTO geocode_cache (cache_key, provider, display_name, raw) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [key, config.geocoder.provider, null, JSON.stringify({ query: trimmed, features: [] })],
      );
      return null;
    }

    const coords = best.geometry?.coordinates;
    if (!coords) return null;
    const [lon, lat] = coords;
    if (!isValidLatLon(lat, lon)) return null;

    await this.db.query(
      `INSERT INTO geocode_cache (cache_key, provider, display_name, latitude, longitude, raw)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (cache_key) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
                                             display_name = EXCLUDED.display_name, raw = EXCLUDED.raw`,
      [
        key,
        config.geocoder.provider,
        `${best.properties?.name ?? trimmed}, ${best.properties?.state ?? ''}, ${best.properties?.country ?? ''}`.replace(/,\s*,/g, ','),
        lat,
        lon,
        JSON.stringify(best),
      ],
    );

    return {
      latitude: lat,
      longitude: lon,
      displayName: `${best.properties?.name ?? trimmed}, ${best.properties?.state ?? ''}, ${best.properties?.country ?? ''}`.replace(/,\s*,/g, ','),
      provider: config.geocoder.provider,
      cached: false,
    };
  }
}

const TYPE_RANK: Record<string, number> = {
  city: 0,
  town: 1,
  village: 2,
  county: 3,
  state: 4,
  district: 5,
  locality: 6,
  suburb: 6,
  neighbourhood: 7,
  quarter: 7,
  city_district: 5,
  municipality: 1,
  borough: 2,
};

function pickBest(features: PhotonFeature[]): PhotonFeature | null {
  const usable = features.filter((f) => {
    const c = f.geometry?.coordinates;
    return Array.isArray(c) && isValidLatLon(c[1], c[0]);
  });
  if (usable.length === 0) return null;
  const ranked = usable
    .map((f) => ({ f, rank: TYPE_RANK[f.properties?.type ?? ''] ?? 8 }))
    .sort((a, b) => a.rank - b.rank);
  return ranked[0].f;
}
