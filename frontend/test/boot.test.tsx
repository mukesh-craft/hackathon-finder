import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App.js';

function mockAppApis() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/cities/suggest')) return { ok: true, json: async () => ({ results: [] }) };
      if (u.includes('/api/cities')) return { ok: true, json: async () => ({ count: 0, cities: [], popular: ['Chennai'] }) };
      if (u.includes('/api/top-cities')) return { ok: true, json: async () => ({ cities: [] }) };
      if (u.includes('/api/hackathons/slug/')) {
        return {
          ok: true,
          json: async () => ({
            hackathon: {
              id: '1', slug: 'x', title: 'X Fest', description: null, organizer: null,
              source: 'unstop', sourceUrl: 'https://unstop.com/x', registrationUrl: null,
              locationText: null, cityId: null, city: null, cityCanonical: null, state: null,
              country: null, venue: null, latitude: null, longitude: null, eventType: 'hackathon',
              onlineOrOffline: 'online', registrationOpensAt: null, registrationDeadline: null,
              registrationDeadlinePrecision: 'none', registrationDeadlineTimezone: null,
              registrationDeadlineBasis: 'unknown', registrationStatus: 'unknown',
              hackathonStart: null, hackathonEnd: null, submissionDeadline: null,
              ideaSubmissionDeadline: null, finalPresentation: null, resultAnnouncement: null,
              teamSizeMin: null, teamSizeMax: null, eligibility: null, themes: [], technologies: [],
              prizeAmount: null, prizeCurrency: null, prizeDetails: null, freeOrPaid: 'unknown',
              registrationFee: null, registrationFeeCurrency: null, dataQuality: 'unknown',
              deadlineConflict: false, deadlineConflictDetail: null, sourceDeadlineText: null,
              lastVerifiedAt: new Date().toISOString(), nextVerificationAt: null,
              updatedAt: new Date().toISOString(), distanceKm: null, sources: [], provenance: [],
            },
            provenance: [],
            generatedAt: new Date().toISOString(),
          }),
        };
      }
      if (u.includes('/api/hackathons')) {
        return {
          ok: true,
          json: async () => ({
            city: { query: '', name: null, slug: null, state: null, country: null, countryCode: null, latitude: null, longitude: null, match: 'unknown', notes: [], aliases: [], metroMembers: [], geocodeSource: null },
            count: 0, total: 0, page: 1, limit: 10, hasMore: false, results: [], online: null,
            facets: { themes: [], technologies: [], eligibility: [], online: 0, offline: 0, withPrize: 0, withDeadline: 0, withConflict: 0 },
            dataFreshness: { lastIngestAt: null, lastIngestSource: null, sourcesWithData: [] },
            generatedAt: new Date().toISOString(), refreshing: false,
          }),
        };
      }
      if (u.includes('/api/admin/stats')) {
        return { ok: true, json: async () => ({ totals: { hackathons: 0, openRegistrations: 0, closedRegistrations: 0, unknownRegistration: 0, deadlineConflicts: 0, missingDeadlines: 0, duplicateCandidates: 0, updatedToday: 0 }, sources: [], lastCrawlAt: null, cityCount: 0 }) };
      }
      if (u.includes('/api/admin/crawls')) return { ok: true, json: async () => ({ runs: [] }) };
      if (u.includes('/api/hackathons/slug/')) {
        return { ok: true, json: async () => ({ hackathon: null, provenance: [], generatedAt: new Date().toISOString() }) };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }) as unknown as typeof fetch,
  );
}

describe('full app boot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = '';
  });

  for (const path of ['/', '/hackathons/chennai', '/hackathon/x', '/saved', '/health', '/admin']) {
    it(`renders without crashing at ${path}`, async () => {
      mockAppApis();
      let crashed: unknown = null;
      try {
        render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );
        await act(async () => {});
      } catch (err) {
        crashed = err;
      }
      expect(crashed).toBeNull();
      expect(document.body.innerHTML.length).toBeGreaterThan(100);
    });
  }
});
