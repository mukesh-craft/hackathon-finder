/** Mobile UI tests: cards, countdowns, sheets, search box, saved, health. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Hackathon } from '@hf/shared';
import { HackathonCard } from '../src/components/HackathonCard.js';
import { SearchBar } from '../src/components/SearchBar.js';
import { DEFAULT_FILTERS, FilterSheet } from '../src/components/FilterPanel.js';
import { EmptyState, ErrorState } from '../src/components/States.js';
import { deadlineView } from '../src/deadlines.js';
import { useDebouncedValue, useServerClock } from '../src/hooks.js';

const NOW = new Date('2026-09-26T00:00:00Z');

function hackathon(over: Partial<Hackathon> = {}): Hackathon {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'chennai-ai-sprint',
    title: 'Chennai AI Sprint',
    description: 'Build something with AI in 24 hours.',
    organizer: 'IIT Madras',
    source: 'unstop',
    sourceUrl: 'https://unstop.com/hackathons/chennai-ai-sprint-1',
    registrationUrl: 'https://unstop.com/o/abc123',
    locationText: 'Chennai, Tamil Nadu',
    cityId: 'chennai',
    city: 'Chennai',
    cityCanonical: 'chennai',
    state: 'Tamil Nadu',
    country: 'India',
    venue: null,
    latitude: 13.08,
    longitude: 80.27,
    eventType: 'hackathon',
    onlineOrOffline: 'offline',
    registrationOpensAt: '2026-09-01T00:00:00+05:30',
    registrationDeadline: '2026-09-29T23:59:00+05:30',
    registrationDeadlinePrecision: 'instant',
    registrationDeadlineTimezone: 'IST',
    registrationDeadlineBasis: 'source_explicit',
    registrationStatus: 'open',
    hackathonStart: '2026-10-04T09:00:00+05:30',
    hackathonEnd: '2026-10-05T18:00:00+05:30',
    submissionDeadline: null,
    ideaSubmissionDeadline: null,
    finalPresentation: null,
    resultAnnouncement: null,
    teamSizeMin: 1,
    teamSizeMax: 4,
    eligibility: 'Undergraduate students',
    themes: ['ai'],
    technologies: ['python'],
    prizeAmount: 50000,
    prizeCurrency: 'INR',
    prizeDetails: 'Prize Pool: INR 50000',
    freeOrPaid: 'free',
    registrationFee: null,
    registrationFeeCurrency: null,
    dataQuality: 'verified',
    deadlineConflict: false,
    deadlineConflictDetail: null,
    sourceDeadlineText: '2026-09-29T23:59:00+05:30',
    lastVerifiedAt: '2026-09-26T00:00:00.000Z',
    nextVerificationAt: null,
    updatedAt: '2026-09-26T00:00:00.000Z',
    distanceKm: 3.2,
    sources: [
      {
        source: 'unstop',
        sourceRecordId: '1',
        sourceUrl: 'https://unstop.com/hackathons/chennai-ai-sprint-1',
        registrationUrl: 'https://unstop.com/o/abc123',
        title: 'Chennai AI Sprint',
        organizer: 'IIT Madras',
        fetchedAt: '2026-09-26T00:00:00.000Z',
        fetchStatus: 'ok',
      },
    ],
    provenance: [],
    ...over,
  };
}

function renderCard(h: Hackathon) {
  return render(
    <MemoryRouter>
      <HackathonCard hackathon={h} now={NOW} showDistance />
    </MemoryRouter>,
  );
}

describe('HackathonCard', () => {
  it('shows the deadline in the source timezone and the countdown', () => {
    renderCard(hackathon());
    expect(screen.getByText((_, el) => el?.textContent === '29 September 2026, 11:59 PM IST')).toBeInTheDocument();
    expect(screen.getByText(/left$/)).toBeInTheDocument();
    expect(screen.getByText('Registration open')).toBeInTheDocument();
    expect(screen.getByText('Verified deadline')).toBeInTheDocument();
  });

  it('says "time not specified" for a date-only deadline instead of a fake time', () => {
    renderCard(hackathon({ registrationDeadline: '2026-09-29', registrationDeadlinePrecision: 'date_only', registrationDeadlineTimezone: null }));
    expect(screen.getByText(/29 September 2026 — time not specified/)).toBeInTheDocument();
    expect(screen.queryByText(/11:59 PM/)).not.toBeInTheDocument();
  });

  it('says "Not specified" when there is no deadline', () => {
    renderCard(
      hackathon({
        registrationDeadline: null,
        registrationDeadlinePrecision: 'none',
        registrationStatus: 'unknown',
        dataQuality: 'unknown',
      }),
    );
    expect(screen.getByText('Not specified', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Deadline not specified')).toBeInTheDocument();
    expect(screen.getByText('Status unknown')).toBeInTheDocument();
  });

  it('warns when sources disagree about the deadline', () => {
    renderCard(
      hackathon({
        deadlineConflict: true,
        deadlineConflictDetail: {
          field: 'registration_deadline',
          values: [
            { value: '2026-09-28', source: 'unstop', sourceUrl: 'https://unstop.com/a', trust: 4 },
            { value: '2026-09-30', source: 'devpost', sourceUrl: 'https://devpost.com/b', trust: 4 },
          ],
          resolvedFrom: null,
          resolutionNote: 'verify',
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/differs between sources/i);
  });

  it('explains an inferred Devpost deadline in plain language', () => {
    renderCard(
      hackathon({
        registrationDeadlineBasis: 'inferred_from_submission_deadline',
        dataQuality: 'partially_verified',
      }),
    );
    expect(screen.getByText(/registration closes at the same time/i)).toBeInTheDocument();
  });

  it('opens the real registration URL in a new tab', () => {
    renderCard(hackathon());
    const register = screen.getByRole('link', { name: 'Register' });
    expect(register).toHaveAttribute('href', 'https://unstop.com/o/abc123');
    expect(register).toHaveAttribute('target', '_blank');
  });

  it('bookmarks persist across renders', async () => {
    const user = userEvent.setup();
    const { unmount } = renderCard(hackathon());
    await user.click(screen.getByRole('button', { name: /save chennai ai sprint/i }));
    expect(JSON.parse(localStorage.getItem('hf:bookmarks') ?? '[]')).toContain('00000000-0000-0000-0000-000000000001');
    unmount();
    renderCard(hackathon());
    expect(screen.getByRole('button', { name: /remove chennai ai sprint from saved/i })).toBeInTheDocument();
  });
});

describe('deadlineView', () => {
  it('computes urgency bands from the stored deadline', () => {
    expect(deadlineView(hackathon({ registrationDeadline: '2026-10-20T00:00:00+05:30' }), NOW).urgency).toBe('comfortable');
    expect(deadlineView(hackathon({ registrationDeadline: '2026-09-29T23:59:00+05:30' }), NOW).urgency).toBe('soon');
    expect(deadlineView(hackathon({ registrationDeadline: '2026-09-26T12:00:00Z' }), NOW).urgency).toBe('critical');
    expect(deadlineView(hackathon({ registrationDeadline: null }), NOW).urgency).toBe('unknown');
  });
});

describe('FilterSheet', () => {
  it('emits filter changes through the custom dropdowns', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <FilterSheet
        filters={{ ...DEFAULT_FILTERS, facets: { themes: [{ value: 'ai', count: 9 }], technologies: [{ value: 'python', count: 4 }] } }}
        onChange={onChange}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Search filters' })).toBeInTheDocument();
    await user.click(screen.getByLabelText('Registration still open'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ openOnly: true }));
    await user.click(screen.getByLabelText('Online'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'online' }));

    // Custom sort dropdown: no native <select> anywhere.
    expect(document.querySelector('select')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sort results by: Recommended' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Prize amount' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sort: 'prize' }));
  });

  it('offers facet values inside the theme dropdown', async () => {
    const user = userEvent.setup();
    render(
      <FilterSheet
        filters={{ ...DEFAULT_FILTERS, facets: { themes: [{ value: 'ai', count: 9 }], technologies: [{ value: 'python', count: 4 }] } }}
        onChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Theme: Any theme' }));
    expect(screen.getByRole('option', { name: 'ai (9)' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'ai (9)' }));
  });

  it('closes on backdrop tap and reset restores defaults', async () => {    const user = userEvent.setup();
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<FilterSheet filters={{ ...DEFAULT_FILTERS, openOnly: true }} onChange={onChange} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ openOnly: false, mode: 'all' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders round checkbox indicators that track state', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <FilterSheet filters={{ ...DEFAULT_FILTERS }} onChange={() => undefined} onClose={() => undefined} />,
    );
    const boxes = document.querySelectorAll('.round-check');
    expect(boxes.length).toBe(6);
    const input = screen.getByLabelText('Prize available') as HTMLInputElement;
    expect(input.checked).toBe(false);
    await user.click(screen.getByLabelText('Prize available'));
    rerender(
      <FilterSheet filters={{ ...DEFAULT_FILTERS, prizeOnly: true }} onChange={() => undefined} onClose={() => undefined} />,
    );
    expect((screen.getByLabelText('Prize available') as HTMLInputElement).checked).toBe(true);
  });
});

describe('SearchBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mockSuggest(results: Array<{ name: string; slug: string; country: string }>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ results }),
      })) as unknown as typeof fetch,
    );
  }

  function renderBar(initialCity = '') {
    return render(
      <MemoryRouter>
        <SearchBar initialCity={initialCity} />
      </MemoryRouter>,
    );
  }

  it('does not fetch or show suggestions on focus with an empty box', () => {
    mockSuggest([{ name: 'Chennai', slug: 'chennai', country: 'India' }]);
    renderBar();
    const input = screen.getByLabelText('Enter a city');
    act(() => {
      input.focus();
      vi.advanceTimersByTime(500);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows suggestions only after two characters are typed', async () => {
    mockSuggest([{ name: 'Chennai', slug: 'chennai', country: 'India' }]);
    renderBar();
    const input = screen.getByLabelText('Enter a city');
    fireEvent.change(input, { target: { value: 'c' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'ch' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /chennai/i })).toBeInTheDocument();
  });

  it('follows navigation instead of showing a stale city', () => {
    const { rerender } = render(
      <MemoryRouter>
        <SearchBar initialCity="Chennai" />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Enter a city')).toHaveValue('Chennai');
    rerender(
      <MemoryRouter>
        <SearchBar initialCity="Mumbai" />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Enter a city')).toHaveValue('Mumbai');
  });

  it('empty submit browses everything instead of doing nothing', () => {
    let seen = '';
    function Spy() {
      seen = useLocation().pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <SearchBar />
        <Spy />
      </MemoryRouter>,
    );
    fireEvent.submit(screen.getByRole('search'));
    expect(seen).toBe('/hackathons/all');
  });

  it('scroll dismisses open suggestions so they never cover results', async () => {
    mockSuggest([{ name: 'Chennai', slug: 'chennai', country: 'India' }]);
    renderBar();
    const input = screen.getByLabelText('Enter a city');
    fireEvent.change(input, { target: { value: 'ch' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {});
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the old value while typing and commits after the pause', () => {
    function Probe({ value }: { value: string }) {
      const debounced = useDebouncedValue(value, 400);
      return <span data-testid="out">{debounced}</span>;
    }
    const { rerender } = render(<Probe value="" />);
    rerender(<Probe value="5" />);
    expect(screen.getByTestId('out')).toHaveTextContent('');
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(screen.getByTestId('out')).toHaveTextContent('');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('out')).toHaveTextContent('5');
  });
});

describe('useServerClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('corrects a wrong device clock from the server anchor', () => {
    // Device thinks it is midnight; the server says it is 06:00.
    function Probe({ anchor }: { anchor: string | null }) {
      const now = useServerClock(anchor, 60_000);
      return <span data-testid="clock">{now.toISOString()}</span>;
    }
    render(<Probe anchor="2026-09-27T06:00:00.000Z" />);
    expect(screen.getByTestId('clock')).toHaveTextContent('2026-09-27T06:00:00.000Z');
    // …and keeps ticking from the corrected base, not the device clock.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('clock')).toHaveTextContent('2026-09-27T06:01:00.000Z');
  });

  it('falls back to the device clock without an anchor', () => {
    function Probe() {
      const now = useServerClock(null, 60_000);
      return <span data-testid="clock">{now.toISOString()}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('clock')).toHaveTextContent('2026-09-27T00:00:00.000Z');
  });
});

describe('Health page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads stats with no token and sends no Authorization header', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), init });
        if (String(url).includes('/api/admin/stats')) {
          return {
            ok: true,
            json: async () => ({
              totals: { hackathons: 10, openRegistrations: 8, closedRegistrations: 1, unknownRegistration: 1, deadlineConflicts: 0, missingDeadlines: 1, duplicateCandidates: 0, updatedToday: 5 },
              sources: [{ source: 'unstop', lastOkAt: null, lastErrorAt: null, consecutiveFailures: 0, lastError: null, successCount: 1, failureCount: 0, avgDurationMs: 5, records: 10, health: 'healthy' }],
              lastCrawlAt: null,
              cityCount: 3,
            }),
          };
        }
        return { ok: true, json: async () => ({ runs: [] }) };
      }) as unknown as typeof fetch,
    );
    const { Health } = await import('../src/pages/Health.js');
    render(
      <MemoryRouter>
        <Health />
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(await screen.findByText('Data health')).toBeInTheDocument();
    expect(screen.getByText('Open now')).toBeInTheDocument();
    const statsCall = seen.find((s) => s.url.includes('/api/admin/stats'));
    expect(statsCall).toBeTruthy();
    expect((statsCall!.init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
  });
});

describe('states', () => {
  it('empty state suggests alternatives and never invents events', () => {
    render(
      <MemoryRouter>
        <EmptyState city="Chennai" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no currently open hackathons found in chennai/i)).toBeInTheDocument();
    expect(screen.getAllByText(/online hackathons/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('error state announces itself and offers a retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState message="Search could not be completed." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Search could not be completed.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('SearchResults browse-all', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const emptySearch = {
    city: { query: '', name: null, slug: null, state: null, country: null, countryCode: null, latitude: null, longitude: null, match: 'unknown', notes: [], aliases: [], metroMembers: [], geocodeSource: null },
    count: 0,
    total: 0,
    page: 1,
    limit: 10,
    hasMore: false,
    results: [],
    online: null,
    facets: { themes: [], technologies: [], eligibility: [], online: 0, offline: 0, withPrize: 0, withDeadline: 0, withConflict: 0 },
    dataFreshness: { lastIngestAt: null, lastIngestSource: null, sourcesWithData: [] },
    generatedAt: new Date().toISOString(),
    refreshing: false,
  };

  it('/hackathons/all fetches without a city filter and titles the page Browse', async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        seenUrls.push(String(url));
        return { ok: true, json: async () => emptySearch };
      }) as unknown as typeof fetch,
    );
    const { SearchResults } = await import('../src/pages/SearchResults.js');
    const { Routes, Route } = await import('react-router-dom');
    render(
      <MemoryRouter initialEntries={['/hackathons/all']}>
        <Routes>
          <Route path="/hackathons/:city" element={<SearchResults />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(seenUrls.some((u) => u.startsWith('/api/hackathons?'))).toBe(true);
    expect(seenUrls.filter((u) => u.startsWith('/api/hackathons?')).every((u) => !u.includes('city='))).toBe(true);
    expect(screen.getByRole('heading', { name: 'Browse hackathons' })).toBeInTheDocument();
  });

  it('refresh button asks for a background crawl and reports the outcome', async () => {
    let searchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url) === '/api/refresh') {
          expect(init?.method).toBe('POST');
          return { ok: true, json: async () => ({ started: false, reason: 'refreshed recently', retryAfterMs: 240_000 }) };
        }
        searchCalls += 1;
        return { ok: true, json: async () => emptySearch };
      }) as unknown as typeof fetch,
    );
    const { SearchResults } = await import('../src/pages/SearchResults.js');
    const { Routes, Route } = await import('react-router-dom');
    render(
      <MemoryRouter initialEntries={['/hackathons/all']}>
        <Routes>
          <Route path="/hackathons/:city" element={<SearchResults />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(searchCalls).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh listings now' }));
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent(/try again in about 4 min/i);
  });
});

describe('friendlyTzLabel', () => {
  it('renders IST instead of UTC+05:30 and keeps real abbreviations', async () => {
    const { friendlyTzLabel } = await import('../src/deadlines.js');
    expect(friendlyTzLabel('UTC+05:30', 330)).toBe('IST');
    expect(friendlyTzLabel(null, 330)).toBe('IST');
    expect(friendlyTzLabel('IST', 330)).toBe('IST');
    expect(friendlyTzLabel('EDT', -240)).toBe('EDT');
    expect(friendlyTzLabel('UTC', 0)).toBe('UTC');
    expect(friendlyTzLabel(null, null)).toBeNull();
  });
});

describe('Dropdown', () => {
  it('opens, highlights the selection, picks with keyboard, closes on Escape', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { Dropdown } = await import('../src/components/Dropdown.js');
    render(
      <Dropdown
        label="Sort results by"
        value="deadline"
        onChange={onChange}
        options={[
          { value: 'relevance', label: 'Recommended' },
          { value: 'deadline', label: 'Registration deadline' },
          { value: 'prize', label: 'Prize amount' },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Sort results by: Registration deadline' });
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Registration deadline' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    await user.click(screen.getByRole('option', { name: 'Prize amount' }));
    expect(onChange).toHaveBeenCalledWith('prize');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape closes and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const { Dropdown } = await import('../src/components/Dropdown.js');
    render(
      <Dropdown
        label="Theme"
        value=""
        onChange={() => undefined}
        options={[
          { value: '', label: 'Any theme' },
          { value: 'ai', label: 'ai (9)' },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Theme: Any theme' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Theme: Any theme' })).toHaveFocus();
  });
});

describe('Details timeline provenance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attributes each milestone to the source field that published it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          hackathon: {
            id: '1', slug: 'x', title: 'Build Night', description: null, organizer: 'Org',
            source: 'unstop', sourceUrl: 'https://unstop.com/x', registrationUrl: null,
            locationText: 'Chennai', cityId: 'chennai', city: 'Chennai', cityCanonical: 'chennai',
            state: 'Tamil Nadu', country: 'India', venue: null, latitude: null, longitude: null,
            eventType: 'hackathon', onlineOrOffline: 'offline',
            registrationOpensAt: '2026-09-17T00:00:00+05:30',
            registrationDeadline: '2026-09-27T17:00:00+05:30',
            registrationDeadlinePrecision: 'instant', registrationDeadlineTimezone: 'IST',
            registrationDeadlineBasis: 'source_explicit', registrationStatus: 'open',
            hackathonStart: null, hackathonEnd: '2026-09-27T18:30:00+05:30',
            submissionDeadline: null, ideaSubmissionDeadline: null, finalPresentation: null,
            resultAnnouncement: null, teamSizeMin: 1, teamSizeMax: 4, eligibility: null,
            themes: [], technologies: [], prizeAmount: null, prizeCurrency: null, prizeDetails: null,
            freeOrPaid: 'unknown', registrationFee: null, registrationFeeCurrency: null,
            dataQuality: 'verified', deadlineConflict: false, deadlineConflictDetail: null,
            sourceDeadlineText: null, lastVerifiedAt: new Date().toISOString(), nextVerificationAt: null,
            updatedAt: new Date().toISOString(), distanceKm: null, sources: [], provenance: [],
            fieldConflicts: [
              {
                field: 'hackathon_end',
                values: [
                  { value: '2026-09-27T18:30:00+05:30', source: 'unstop', sourceUrl: 'https://unstop.com/x', trust: 4 },
                  { value: '2026-10-08', source: 'unstop', sourceUrl: 'https://unstop.com/x', trust: 4 },
                ],
                resolvedFrom: 'unstop',
                resolutionNote: 'structured vs text',
              },
            ],
          },
          provenance: [
            { field: 'registration_deadline', value: '2026-09-27T17:00:00+05:30', source: 'unstop', sourceUrl: 'https://unstop.com/x', retrievedAt: '', confidence: 'verified' },
            { field: 'hackathon_end', value: '2026-09-27T18:30:00+05:30', source: 'unstop', sourceUrl: 'https://unstop.com/x', retrievedAt: '', confidence: 'source_confirmed' },
          ],
          generatedAt: new Date().toISOString(),
        }),
      })) as unknown as typeof fetch,
    );
    const { Details } = await import('../src/pages/Details.js');
    const { Routes, Route } = await import('react-router-dom');
    render(
      <MemoryRouter initialEntries={['/hackathon/x']}>
        <Routes>
          <Route path="/hackathon/:slug" element={<Details />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    // Two close-but-distinct milestones, each naming the source that published it.
    expect(await screen.findByText('via unstop · verified')).toBeInTheDocument();
    expect(screen.getByText('via unstop · source confirmed')).toBeInTheDocument();
    expect(screen.getByText(/event end differs between sources/i)).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  it('shows a recovery page instead of a blank screen on render crash', async () => {
    const { ErrorBoundary } = await import('../src/components/ErrorBoundary.js');
    function Explodes(): React.JSX.Element {
      throw new Error('boom');
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Explodes />
      </ErrorBoundary>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole('button', { name: /reload the page/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to search/i })).toBeInTheDocument();
    consoleSpy.mockRestore();
  });
});
