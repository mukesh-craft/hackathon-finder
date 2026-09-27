import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { requestRefresh, searchHackathons } from '../api.js';
import { useAsync, useDebouncedValue, useRefetchOnVisible, useServerClock } from '../hooks.js';
import { SearchBar } from '../components/SearchBar.js';
import { HackathonCard } from '../components/HackathonCard.js';
import { DEFAULT_FILTERS, FilterSheet, type FilterState } from '../components/FilterPanel.js';
import { EmptyState, ErrorState, SkeletonList } from '../components/States.js';

const PAGE_SIZE = 10;

export function SearchResults() {
  const { city: citySlug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const browseAll = citySlug.toLowerCase() === 'all' && !params.get('city');
  const city = browseAll ? '' : (params.get('city') ?? denormalize(citySlug));
  const modeParam = params.get('mode');
  const openParam = params.get('open');

  const SORTS = ['relevance', 'deadline', 'event_date', 'distance', 'prize', 'recently_updated'] as const;

  const [filters, setFilters] = useState<FilterState>(() => {
    // Every filter is deep-linkable, so AI search (and shares/bookmarks) can
    // land on an exact filtered view. Unknown values fall back to defaults.
    const sortParam = params.get('sort');
    const teamParam = params.get('teamSize');
    const teamN = teamParam !== null && /^\d{1,2}$/.test(teamParam) ? teamParam : '';
    return {
      ...DEFAULT_FILTERS,
      mode: modeParam === 'online' || modeParam === 'offline' ? modeParam : 'all',
      openOnly: openParam === 'true',
      sort: (SORTS as readonly string[]).includes(sortParam ?? '') ? (sortParam as FilterState['sort']) : 'relevance',
      theme: (params.get('theme') ?? '').slice(0, 60),
      tech: (params.get('tech') ?? '').slice(0, 60),
      teamSize: teamN,
    };
  });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [page, setPage] = useState(1);

  const debouncedTeamSize = useDebouncedValue(filters.teamSize, 400);

  useEffect(() => {
    setPage(1);
  }, [city, filters.openOnly, filters.mode, filters.radius, filters.sort, filters.prizeOnly, filters.freeOnly, filters.theme, filters.tech, debouncedTeamSize]);

  const query = useMemo(
    () => ({
      city: city || undefined,
      open: filters.openOnly || undefined,
      radius: filters.mode === 'online' ? undefined : filters.radius,
      mode: filters.mode,
      prize: filters.prizeOnly || undefined,
      free: filters.freeOnly || undefined,
      theme: filters.theme ? [filters.theme] : undefined,
      tech: filters.tech ? [filters.tech] : undefined,
      teamSize: debouncedTeamSize ? Number(debouncedTeamSize) : undefined,
      sort: filters.sort,
      page,
      limit: PAGE_SIZE,
    }),
    [city, filters, page, debouncedTeamSize],
  );

  const result = useAsync(
    () => searchHackathons(query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [city, filters.openOnly, filters.mode, filters.radius, filters.sort, filters.prizeOnly, filters.freeOnly, filters.theme, filters.tech, debouncedTeamSize, page],
  );
  useRefetchOnVisible(result.reload);
  const now = useServerClock(result.data?.generatedAt ?? null);

  // Manual refresh: ask the server for a background crawl, then pick up the
  // fresh data when it lands. Never blocks the UI.
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (result.data?.refreshing) setUpdating(true);
  }, [result.data?.refreshing]);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);
  const doRefresh = async () => {
    setRefreshMsg(null);
    try {
      const r = await requestRefresh();
      if (r.started) {
        setUpdating(true);
        setRefreshMsg('Refreshing listings in the background — fresh results appear automatically.');
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          result.reload();
          setUpdating(false);
        }, 75_000);
      } else if (r.retryAfterMs > 0) {
        setRefreshMsg(`Already fresh — try again in about ${Math.max(1, Math.ceil(r.retryAfterMs / 60_000))} min.`);
      } else {
        setRefreshMsg('Already up to date.');
      }
    } catch {
      setRefreshMsg('Refresh failed — check your connection and try again.');
    }
  };

  const activeCount =
    (filters.openOnly ? 1 : 0) +
    (filters.mode !== 'all' ? 1 : 0) +
    (filters.prizeOnly ? 1 : 0) +
    (filters.freeOnly ? 1 : 0) +
    (filters.theme ? 1 : 0) +
    (filters.tech ? 1 : 0) +
    (debouncedTeamSize ? 1 : 0);

  return (
    <div>
      <h1 style={{ fontSize: '1.35rem', margin: '0.2rem 0 0.6rem' }}>
        {city ? `Hackathons in ${result.data?.city.name ?? city}` : 'Browse hackathons'}
      </h1>
      {result.data?.city.notes.map((n) => (
        <p key={n} className="muted" style={{ margin: '0 0 0.6rem' }}>
          {n}
        </p>
      ))}
      <SearchBar initialCity={city} />

      <div className="toolbar">
        <span className="count" aria-live="polite">
          {result.data ? `${result.data.total} result${result.data.total === 1 ? '' : 's'}` : '…'}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={doRefresh} aria-label="Refresh listings now">
          ↻
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setSheetOpen(true)}>
          Filters{activeCount > 0 ? ` (${activeCount})` : ''}
        </button>
      </div>
      {refreshMsg ? (
        <p className="muted" role="status" style={{ margin: '-0.3rem 0 0.6rem' }}>
          {refreshMsg}
        </p>
      ) : null}

      {sheetOpen ? (
        <FilterSheet
          filters={result.data ? { ...filters, facets: { themes: result.data.facets.themes, technologies: result.data.facets.technologies } } : filters}
          onChange={(f) => setFilters({ ...f, facets: filters.facets })}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}

      {result.loading ? <SkeletonList count={4} /> : null}
      {result.error ? <ErrorState message={result.error.message} onRetry={result.reload} /> : null}
      {result.data && result.data.total === 0 ? (
        <EmptyState
          city={city}
          onClear={() => {
            setFilters({ ...DEFAULT_FILTERS, facets: filters.facets });
            setParams({});
          }}
        />
      ) : null}
      {result.data && result.data.total > 0 ? (
        <>
          <div className="cards">
            {result.data.results.map((h) => (
              <HackathonCard key={h.id} hackathon={h} now={now} showDistance />
            ))}
          </div>
          <nav className="toolbar" aria-label="Search result pages" style={{ justifyContent: 'center' }}>
            <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
            <span className="count" aria-live="polite">
              {page} / {Math.max(1, Math.ceil(result.data.total / PAGE_SIZE))}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!result.data.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </nav>
        </>
      ) : null}

      {result.data && result.data.online && result.data.online.total > 0 ? (
        <section aria-labelledby="online-heading">
          <div className="section-head">
            <h2 id="online-heading">Online — join from {result.data.city.name ?? city}</h2>
          </div>
          <p className="muted" style={{ margin: '-0.3rem 0 0.7rem' }}>
            {result.data.online.total} open online {result.data.online.total === 1 ? 'listing' : 'listings'}.
          </p>
          <div className="cards">
            {result.data.online.results.map((h) => (
              <HackathonCard key={h.id} hackathon={h} now={now} />
            ))}
          </div>
        </section>
      ) : null}

      {result.data?.dataFreshness.lastIngestAt ? (
        <p className="muted freshness">
          Updated {relativeTime(result.data.generatedAt)}
          {updating || result.data.refreshing ? ' · Updating latest listings…' : ''}
          {' · '}sources: {result.data.dataFreshness.sourcesWithData.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

function denormalize(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
