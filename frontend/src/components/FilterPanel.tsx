import { useEffect } from 'react';
import type { SearchParams } from '../api.js';
import { Dropdown } from './Dropdown.js';

export interface FilterState {
  openOnly: boolean;
  mode: 'all' | 'online' | 'offline';
  radius: number;
  sort: NonNullable<SearchParams['sort']>;
  prizeOnly: boolean;
  freeOnly: boolean;
  theme: string;
  tech: string;
  teamSize: string;
  facets: { themes: Array<{ value: string; count: number }>; technologies: Array<{ value: string; count: number }> };
}

export const DEFAULT_FILTERS: FilterState = {
  openOnly: false,
  mode: 'all',
  radius: 50,
  sort: 'relevance',
  prizeOnly: false,
  freeOnly: false,
  theme: '',
  tech: '',
  teamSize: '',
  facets: { themes: [], technologies: [] },
};

/** Filters live in a bottom sheet: full-screen on a phone, dismissible. */
export function FilterSheet({
  filters,
  onChange,
  onClose,
}: {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) => onChange({ ...filters, [key]: value });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Search filters"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <h2>Filters</h2>

        <fieldset>
          <legend>Registration</legend>
          <label className="check">
            <input type="checkbox" className="check-input" checked={filters.openOnly} onChange={(e) => set('openOnly', e.target.checked)} />
            <span className="round-check" aria-hidden="true">
              <svg viewBox="0 0 12 10" width="12" height="10">
                <path d="M1 5.5 4.5 9 11 1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Registration still open
          </label>
        </fieldset>

        <fieldset>
          <legend>Format</legend>
          {(['all', 'online', 'offline'] as const).map((m) => (
            <label key={m} className="check">
              <input type="radio" name="mode" value={m} className="check-input" checked={filters.mode === m} onChange={() => set('mode', m)} />
              <span className="round-check" aria-hidden="true">
                <svg viewBox="0 0 12 10" width="12" height="10">
                  <path d="M1 5.5 4.5 9 11 1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {m === 'all' ? 'All formats' : m === 'online' ? 'Online' : 'Offline'}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Distance</legend>
          <label className="field">
            <span>Within {filters.radius} km</span>
            <input
              type="range"
              min={5}
              max={500}
              step={5}
              value={filters.radius}
              onChange={(e) => set('radius', Number(e.target.value))}
              aria-valuetext={`${filters.radius} kilometres`}
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Sort by</legend>
          <Dropdown
            label="Sort results by"
            value={filters.sort}
            onChange={(v) => set('sort', v as FilterState['sort'])}
            options={[
              { value: 'relevance', label: 'Recommended' },
              { value: 'deadline', label: 'Registration deadline' },
              { value: 'event_date', label: 'Event date' },
              { value: 'distance', label: 'Distance' },
              { value: 'prize', label: 'Prize amount' },
              { value: 'recently_updated', label: 'Recently updated' },
            ]}
          />
        </fieldset>

        <fieldset>
          <legend>Money</legend>
          <label className="check">
            <input type="checkbox" className="check-input" checked={filters.prizeOnly} onChange={(e) => set('prizeOnly', e.target.checked)} />
            <span className="round-check" aria-hidden="true">
              <svg viewBox="0 0 12 10" width="12" height="10">
                <path d="M1 5.5 4.5 9 11 1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Prize available
          </label>
          <label className="check">
            <input type="checkbox" className="check-input" checked={filters.freeOnly} onChange={(e) => set('freeOnly', e.target.checked)} />
            <span className="round-check" aria-hidden="true">
              <svg viewBox="0 0 12 10" width="12" height="10">
                <path d="M1 5.5 4.5 9 11 1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Free entry
          </label>
        </fieldset>

        <fieldset>
          <legend>Theme &amp; technology</legend>
          <Dropdown
            label="Theme"
            value={filters.theme}
            onChange={(v) => set('theme', v)}
            options={[
              { value: '', label: 'Any theme' },
              ...filters.facets.themes.map((t) => ({ value: t.value, label: `${t.value} (${t.count})` })),
            ]}
          />
          <Dropdown
            label="Technology"
            value={filters.tech}
            onChange={(v) => set('tech', v)}
            options={[
              { value: '', label: 'Any technology' },
              ...filters.facets.technologies.map((t) => ({ value: t.value, label: `${t.value} (${t.count})` })),
            ]}
          />
        </fieldset>

        <fieldset>
          <legend>Team size</legend>
          <label className="field">
            <span>My team has N members</span>
            <input
              type="number"
              name="teamSize"
              min={1}
              max={50}
              inputMode="numeric"
              placeholder="e.g. 4…"
              value={filters.teamSize}
              onChange={(e) => set('teamSize', e.target.value)}
            />
          </label>
        </fieldset>

        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onChange({ ...DEFAULT_FILTERS, facets: filters.facets })}>
            Reset
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Show results
          </button>
        </div>
      </div>
    </div>
  );
}
