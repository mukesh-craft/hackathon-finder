import { describe, expect, it } from 'vitest';
import {
  CITY_INDEX,
  exactCityKeys,
  matchCity,
  normalizeKey,
  suggestCities,
  stripRegionSuffixes,
} from '../src/cities.js';
import { boundingBox, haversineKm, isValidLatLon } from '../src/geo.js';

describe('normalizeKey / stripRegionSuffixes', () => {
  it('lowercases, de-accents and strips punctuation', () => {
    expect(normalizeKey('Köln')).toBe('koln');
    expect(normalizeKey('New  York, NY')).toBe('new york ny');
  });

  it('drops trailing state and country tokens', () => {
    expect(stripRegionSuffixes('Chennai, Tamil Nadu')).toBe('chennai');
    expect(stripRegionSuffixes('Bengaluru, Karnataka, India')).toBe('bengaluru');
    expect(stripRegionSuffixes('Mumbai')).toBe('mumbai');
  });
});

describe('matchCity — alternate and historical spellings', () => {
  const cases: Array<[string, string]> = [
    ['Bangalore', 'Bengaluru'],
    ['bangalore urban', 'Bengaluru'],
    ['Bangalore Urban District', 'Bengaluru'],
    ['Bombay', 'Mumbai'],
    ['Madras', 'Chennai'],
    ['New Delhi', 'Delhi'],
    ['Gurgaon', 'Gurugram'],
    ['Calcutta', 'Kolkata'],
    ['Cochin', 'Kochi'],
    ['Trivandrum', 'Thiruvananthapuram'],
    ['Bangalore, Karnataka', 'Bengaluru'],
    ['Chennai, Tamil Nadu', 'Chennai'],
    ['Pune, Maharashtra', 'Pune'],
  ];

  for (const [input, expected] of cases) {
    it(`resolves "${input}" to ${expected}`, () => {
      const m = matchCity(input);
      expect(m.primary?.name).toBe(expected);
    });
  }

  it('reports how the query was understood', () => {
    expect(matchCity('Chennai').match).toBe('exact');
    expect(matchCity('Bombay').match).toBe('alias');
  });
});

describe('matchCity — metro / locality matching', () => {
  it('treats Chennai suburbs as the same metro area', () => {
    const keys = matchCity('Chennai').equivalentKeys;
    for (const suburb of ['ambattur', 'velachery', 'sholinganallur', 'porur', 'guindy']) {
      expect(keys).toContain(suburb);
    }
  });

  it('resolves a suburb name to its parent city', () => {
    expect(matchCity('OMR').primary?.name).toBe('Sholinganallur');
    expect(matchCity('Pimpri-Chinchwad').primary?.name).toBe('Pimpri-Chinchwad');
    // "Sion Mumbai" is a precise reference to the Sion locality of Mumbai, so it
    // resolves there; either way it lands in the Mumbai metro for search.
    expect(matchCity('Sion Mumbai').primary?.metro).toBe('mumbai');
    expect(matchCity('Sion Mumbai').equivalentKeys).toContain('mumbai');
    expect(matchCity('HITEC City').primary?.name).toBe('Gachibowli');
  });

  it('folds Noida and Greater Noida into Delhi searches', () => {
    const keys = matchCity('Delhi').equivalentKeys;
    expect(keys).toContain('noida');
    expect(keys).toContain('greater-noida');
    expect(keys).toContain('ghaziabad');
  });

  it('folds Navi Mumbai into Mumbai searches', () => {
    const keys = matchCity('Mumbai').equivalentKeys;
    expect(keys).toContain('navi-mumbai');
    expect(keys).toContain('thane');
  });

  it('excludes metro siblings when an exact city match is requested', () => {
    const keys = matchCity('Mumbai', { includeMetro: false }).equivalentKeys;
    expect(keys).toContain('mumbai');
    expect(keys).not.toContain('navi-mumbai');
  });
});

describe('matchCity — avoiding overmatching', () => {
  it('returns unknown for a place it does not know', () => {
    expect(matchCity('Atlantis').match).toBe('unknown');
    expect(matchCity('Zzzzz').primary).toBeNull();
  });

  it('returns unknown for empty input', () => {
    expect(matchCity('').match).toBe('unknown');
  });

  it('does not match one city name inside another', () => {
    // "Pune" must not pull in Pimpri-Chinchwad as an exact city, and
    // "Delhi" must not match "Delhi NCR" as an unrelated city.
    expect(matchCity('Pune').primary?.name).toBe('Pune');
    expect(matchCity('Chennai').primary?.name).toBe('Chennai');
  });

  it('does not invent a match from a partial token', () => {
    expect(matchCity('chen').primary).toBeNull();
  });
});

describe('exactCityKeys / suggestCities', () => {
  it('produces exact keys without metro expansion', () => {
    expect(exactCityKeys('Bangalore')).toContain('bengaluru');
    expect(exactCityKeys('Bangalore')).not.toContain('whitefield');
  });

  it('ranks the canonical city first in suggestions', () => {
    const s = suggestCities('banga');
    expect(s[0].name).toBe('Bengaluru');
  });

  it('suggests real cities when the box is empty', () => {
    const s = suggestCities('');
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((d) => typeof d.name === 'string')).toBe(true);
  });
});

describe('city registry integrity', () => {
  it('has no duplicate canonical names', () => {
    const names = CITY_INDEX.all.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not ship hard-coded coordinates', () => {
    // Coordinates must come from the geocoder and be persisted with provenance.
    for (const def of CITY_INDEX.all) {
      expect(Object.keys(def)).not.toContain('lat');
      expect(Object.keys(def)).not.toContain('lon');
      expect(Object.keys(def)).not.toContain('latitude');
      expect(Object.keys(def)).not.toContain('longitude');
    }
  });
});

describe('geo', () => {
  it('computes a plausible great-circle distance', () => {
    // Chennai -> Bengaluru is roughly 290 km.
    const d = haversineKm(13.0827, 80.2707, 12.9716, 77.5946);
    expect(d).toBeGreaterThan(270);
    expect(d).toBeLessThan(320);
  });

  it('returns zero for identical points', () => {
    expect(haversineKm(19.076, 72.8777, 19.076, 72.8777)).toBe(0);
  });

  it('builds a bounding box that contains the circle', () => {
    const box = boundingBox(13.0827, 80.2707, 50);
    expect(box.minLat).toBeLessThan(13.0827);
    expect(box.maxLat).toBeGreaterThan(13.0827);
    expect(box.minLon).toBeLessThan(80.2707);
    expect(box.maxLon).toBeGreaterThan(80.2707);
  });

  it('rejects invalid coordinates including the null island', () => {
    expect(isValidLatLon(0, 0)).toBe(false);
    expect(isValidLatLon(91, 0)).toBe(false);
    expect(isValidLatLon(null, 20)).toBe(false);
    expect(isValidLatLon(13.08, 80.27)).toBe(true);
  });
});
