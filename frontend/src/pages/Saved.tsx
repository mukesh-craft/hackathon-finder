import { Link } from 'react-router-dom';
import type { Hackathon } from '@hf/shared';
import { hackathonById } from '../api.js';
import { useAsync, useLocalSet, useRefetchOnVisible, useServerClock } from '../hooks.js';
import { HackathonCard } from '../components/HackathonCard.js';
import { ErrorState, SkeletonList } from '../components/States.js';

/** Saved list: bookmark ids live in localStorage; each record is re-fetched so
 *  deadlines and statuses are always live, never a stale snapshot. */
export function Saved() {
  const bookmarks = useLocalSet('hf:bookmarks');
  const savedIds = bookmarks.all;
  const result = useAsync(() => fetchSaved(savedIds), [savedIds.join(',')]);
  useRefetchOnVisible(result.reload);
  const now = useServerClock(result.data?.generatedAt ?? null);

  return (
    <div>
      <h1 style={{ fontSize: '1.35rem', margin: '0.2rem 0 0.6rem' }}>Saved hackathons</h1>
      {savedIds.length === 0 ? (
        <section className="state">
          <h2>Nothing saved yet</h2>
          <p className="muted">Tap ☆ on any hackathon to keep it here with a live countdown.</p>
          <Link to="/" className="btn btn-primary btn-block">
            Find hackathons
          </Link>
        </section>
      ) : null}
      {result.loading ? <SkeletonList count={Math.min(savedIds.length, 4)} /> : null}
      {result.error ? <ErrorState message={result.error.message} onRetry={result.reload} /> : null}
      {result.data && result.data.failed > 0 ? (
        <p className="muted" role="status">
          {result.data.failed} saved {result.data.failed === 1 ? 'event is' : 'events are'} no longer listed.
        </p>
      ) : null}
      {result.data ? (
        <div className="cards">
          {result.data.records.map((h) => (
            <HackathonCard key={h.id} hackathon={h} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

async function fetchSaved(ids: string[]): Promise<{ records: Hackathon[]; failed: number; generatedAt: string }> {
  const settled = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await hackathonById(id);
        return res.hackathon;
      } catch {
        return null;
      }
    }),
  );
  return {
    records: settled.filter((h): h is Hackathon => h !== null),
    failed: settled.filter((h) => h === null).length,
    generatedAt: new Date().toISOString(),
  };
}
