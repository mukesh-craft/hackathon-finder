import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { suggestCities } from '../api.js';
import { useDebouncedValue } from '../hooks.js';

interface Suggestion {
  name: string;
  slug: string;
  state?: string | null;
  country: string;
  locality?: boolean;
}

export function SearchBar({ initialCity = '', autoFocus = false }: { initialCity?: string; autoFocus?: boolean }) {
  const [value, setValue] = useState(initialCity);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const debounced = useDebouncedValue(value, 220);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = 'city-suggestions';

  // Follow navigation instead of showing a stale city.
  useEffect(() => {
    setValue(initialCity);
    setOpen(false);
  }, [initialCity]);

  // Suggestions only fire once the user typed something meaningful.
  const canSuggest = debounced.trim().length >= 2;
  useEffect(() => {
    if (!canSuggest) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    suggestCities(debounced)
      .then((r) => {
        if (alive) {
          setSuggestions(r.results.slice(0, 8));
          setHighlight(-1);
        }
      })
      .catch(() => {
        if (alive) setSuggestions([]);
      });
    return () => {
      alive = false;
    };
  }, [debounced, canSuggest]);

  useEffect(() => {
    const dismiss = (e: Event) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('touchstart', dismiss, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('touchstart', dismiss);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  const go = (city: string) => {
    const trimmed = city.trim();
    setOpen(false);
    if (!trimmed) {
      navigate('/hackathons/all');
      return;
    }
    navigate(`/hackathons/${encodeURIComponent(trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}?city=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div ref={boxRef} className="search-box">
      <form
        role="search"
        aria-label="Find hackathons by city"
        onSubmit={(e) => {
          e.preventDefault();
          go(value);
        }}
      >
        <label className="visually-hidden" htmlFor="city-input">
          Enter a city
        </label>
        <div className="search-row">
          <input
            id="city-input"
            name="city"
            type="search"
            value={value}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            placeholder="City — Chennai, Mumbai…"
            onChange={(e) => {
              setValue(e.target.value);
              setOpen(e.target.value.trim().length >= 2);
            }}
            onFocus={() => {
              if (value.trim().length >= 2) setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && suggestions.length > 0) {
                e.preventDefault();
                setHighlight((h) => (h + 1) % suggestions.length);
              } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
                e.preventDefault();
                setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === 'Enter' && highlight >= 0 && suggestions[highlight]) {
                e.preventDefault();
                go(suggestions[highlight].name);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listId}
            aria-activedescendant={highlight >= 0 ? `city-opt-${highlight}` : undefined}
            role="combobox"
            aria-autocomplete="list"
          />
          <button type="submit" className="btn btn-primary" aria-label="Find hackathons">
            Go
          </button>
        </div>
      </form>
      {open && suggestions.length > 0 ? (
        <ul id={listId} className="suggestions" role="listbox" aria-label="City suggestions">
          {suggestions.map((s, i) => (
            <li key={s.slug} id={`city-opt-${i}`} role="option" aria-selected={i === highlight} className={i === highlight ? 'highlight' : undefined}>
              <button type="button" onClick={() => go(s.name)} onMouseEnter={() => setHighlight(i)} tabIndex={-1}>
                <span className="sugg-name">{s.name}</span>
                <span className="sugg-meta">
                  {[s.state, s.country].filter(Boolean).join(', ')}
                  {s.locality ? ' · locality' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
