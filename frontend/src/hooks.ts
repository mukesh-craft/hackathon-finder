import { useCallback, useEffect, useRef, useState } from 'react';

/** Run `fn` after the user stops changing `value` for `delay` ms. */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/**
 * A clock anchored to server time.
 *
 * Countdowns must not depend on the phone's clock: if the device time is off
 * (or drifted), every countdown is wrong by the same amount. Each API response
 * carries `generatedAt` (server time at the moment of the query); we measure
 * the offset once and tick locally from there, so countdowns stay correct even
 * with a wrong device clock.
 */
export function useServerClock(anchorIso: string | null, intervalMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  const offsetRef = useRef(0);
  useEffect(() => {
    if (!anchorIso) return;
    const server = new Date(anchorIso).getTime();
    if (!Number.isNaN(server)) {
      offsetRef.current = server - Date.now();
      setNow(new Date(server));
    }
  }, [anchorIso]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date(Date.now() + offsetRef.current)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Re-run `reload` when the tab becomes visible again or regains focus, so a
 *  page left open overnight never shows yesterday's data. */
export function useRefetchOnVisible(reload: () => void): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    let last = 0;
    const fire = () => {
      // Ignore the flurry of events fired together on tab switch.
      if (Date.now() - last < 2_000) return;
      last = Date.now();
      reloadRef.current();
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') fire();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', fire);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', fire);
    };
  }, []);
}

/** Persisted string set (bookmarks), stored locally. No account needed. */
export function useLocalSet(key: string): { has: (id: string) => boolean; toggle: (id: string) => void; all: string[] } {
  const [items, setItems] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });

  const toggle = useCallback(
    (id: string) => {
      setItems((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Private mode etc: bookmarks simply do not persist.
        }
        return next;
      });
    },
    [key],
  );

  const has = useCallback((id: string) => items.includes(id), [items]);
  return { has, toggle, all: items };
}

/** Run an async task and track loading/error state. Cancellation-safe. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; loading: boolean; error: Error | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => {
        if (alive) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (alive) {
          setError(e);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}
