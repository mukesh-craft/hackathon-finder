import { adminCrawls, adminStats } from '../api.js';
import { useAsync, useRefetchOnVisible } from '../hooks.js';
import { ErrorState, SkeletonList } from '../components/States.js';

/** Pipeline health, readable by everyone: counts, source health, crawls. */
export function Health() {
  const stats = useAsync(() => adminStats(), []);
  const crawls = useAsync(() => adminCrawls(), [stats.data]);
  useRefetchOnVisible(stats.reload);

  return (
    <div>
      <h1 style={{ fontSize: '1.35rem', margin: '0.2rem 0 0.6rem' }}>Data health</h1>
      <p className="muted" style={{ margin: '0 0 0.8rem' }}>
        Live numbers from the database — what was collected, what works, what fails.
      </p>

      {stats.loading ? <SkeletonList count={2} /> : null}
      {stats.error ? <ErrorState message={stats.error.message} onRetry={stats.reload} /> : null}
      {stats.data ? <StatsView stats={stats.data} /> : null}

      <div className="section-head">
        <h2>Recent crawls</h2>
      </div>
      {crawls.error ? <ErrorState message={crawls.error.message} onRetry={crawls.reload} /> : null}
      {crawls.data ? (
        <div className="table-scroll">
          <table className="prov-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th scope="col">Seen</th>
                <th scope="col">Failed</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {crawls.data.runs.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td>{r.source}</td>
                  <td>
                    <span className={`badge badge-run-${r.status}`}>{r.status}</span>
                  </td>
                  <td>{r.records_seen}</td>
                  <td>{r.records_failed}</td>
                  <td>{new Date(r.started_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function StatsView({ stats }: { stats: Awaited<ReturnType<typeof adminStats>> }) {
  const cards: Array<[string, number | string]> = [
    ['Hackathons', stats.totals.hackathons],
    ['Open now', stats.totals.openRegistrations],
    ['Closed', stats.totals.closedRegistrations],
    ['No deadline', stats.totals.missingDeadlines],
    ['Conflicts', stats.totals.deadlineConflicts],
    ['Merged dupes', stats.totals.duplicateCandidates],
  ];
  return (
    <>
      <div className="stat-grid">
        {cards.map(([label, value]) => (
          <div key={label} className="stat-card">
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
      </div>
      <div className="section-head">
        <h2>Sources</h2>
      </div>
      {stats.sources.map((s) => (
        <div key={s.source} className="panel" style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{s.source}</strong>
            <div className="muted">
              {s.records} records{s.lastOkAt ? ` · ok ${new Date(s.lastOkAt).toLocaleString()}` : ' · never ok'}
              {s.lastError ? ` · ${s.lastError.slice(0, 90)}` : ''}
            </div>
          </div>
          <span className={`badge badge-health-${s.health}`}>{s.health}</span>
        </div>
      ))}
      <p className="muted">
        Last crawl: {stats.lastCrawlAt ? new Date(stats.lastCrawlAt).toLocaleString() : 'never'}
      </p>
    </>
  );
}
