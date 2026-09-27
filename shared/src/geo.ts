/** Great-circle distance helpers (portable haversine, no PostGIS dependency). */

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Cheap index-friendly pre-filter before the exact haversine comparison. */
export function boundingBox(lat: number, lon: number, radiusKm: number): BoundingBox {
  const latDelta = radiusKm / 111.32;
  const cos = Math.cos(toRad(lat));
  const lonDelta = Math.abs(cos) < 1e-6 ? 180 : radiusKm / (111.32 * Math.abs(cos));
  return {
    minLat: Math.max(-90, lat - latDelta),
    maxLat: Math.min(90, lat + latDelta),
    minLon: Math.max(-180, lon - lonDelta),
    maxLon: Math.min(180, lon + lonDelta),
  };
}

export function isValidLatLon(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}
