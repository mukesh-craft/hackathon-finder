import { Link, useParams } from 'react-router-dom';
import { hackathonDetails } from '../api.js';
import { deadlineView, formatPrize, formatTeamSize, renderSourceDeadline } from '../deadlines.js';
import { useAsync, useLocalSet, useRefetchOnVisible, useServerClock } from '../hooks.js';
import { CountdownPill, ModeBadge, QualityBadge, StatusBadge } from '../components/Badges.js';
import { SourceLink } from '../components/HackathonCard.js';
import { ErrorState, SkeletonList } from '../components/States.js';
import type { Hackathon } from '@hf/shared';

const TIMELINE: Array<{ label: string; key: keyof Hackathon }> = [
  { label: 'Registration opens', key: 'registrationOpensAt' },
  { label: 'Registration closes', key: 'registrationDeadline' },
  { label: 'Idea submission deadline', key: 'ideaSubmissionDeadline' },
  { label: 'Submission deadline', key: 'submissionDeadline' },
  { label: 'Hackathon starts', key: 'hackathonStart' },
  { label: 'Hackathon ends', key: 'hackathonEnd' },
  { label: 'Final presentation', key: 'finalPresentation' },
  { label: 'Results announced', key: 'resultAnnouncement' },
];

export function Details() {
  const { slug = '' } = useParams();
  const result = useAsync(() => hackathonDetails(slug), [slug]);
  useRefetchOnVisible(result.reload);
  // Tick every second here: this page shows live seconds in the countdown,
  // anchored to the server clock so a wrong device clock can't skew it.
  const now = useServerClock(result.data?.generatedAt ?? null, 1_000);
  const bookmarks = useLocalSet('hf:bookmarks');

  if (result.loading) return <SkeletonList count={1} />;
  if (result.error) return <ErrorState message={result.error.message} onRetry={result.reload} />;
  if (!result.data) return null;

  const { hackathon: h, provenance } = result.data;
  const view = deadlineView(h, now);
  const saved = bookmarks.has(h.id);

  return (
    <article>
      <p className="crumb">
        <Link to="/">Search</Link> / {h.city ? `${h.city} / ` : ''}Details
      </p>

      <div className="card-badges" style={{ marginBottom: '0.4rem' }}>
        <StatusBadge status={view.status} />
        <QualityBadge quality={h.dataQuality} />
        <ModeBadge mode={h.onlineOrOffline} />
      </div>
      <h1 style={{ fontSize: '1.45rem', margin: '0 0 0.2rem' }}>{h.title}</h1>
      {h.organizer ? <p className="muted" style={{ margin: '0 0 0.6rem' }}>by {h.organizer}</p> : null}

      <section className="panel deadline-panel" aria-labelledby="deadline-heading">
        <h2 id="deadline-heading">Registration deadline</h2>
        <p className="deadline-main">
          {view.main}
          {view.tzLabel ? ` ${view.tzLabel}` : ''}
        </p>
        {view.local ? <p className="muted">({view.local})</p> : null}
        <CountdownPill label={view.countdown} urgency={view.urgency} expired={view.expired} />
        {view.inferenceNote ? <p className="inference-note">{view.inferenceNote}</p> : null}
        {h.deadlineConflict && h.deadlineConflictDetail ? (
          <div className="conflict-panel" role="alert">
            <h3>Deadline differs between sources</h3>
            <ul>
              {h.deadlineConflictDetail.values.map((v, i) => (
                <li key={i}>
                  <strong>{v.value}</strong> — via {v.source}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {h.sourceDeadlineText ? (
          <p className="muted">
            Source wording: <q>{h.sourceDeadlineText}</q>
          </p>
        ) : null}
      </section>

      <div className="details-actions">
        {h.registrationUrl ? (
          <a href={h.registrationUrl} target="_blank" rel="noopener noreferrer sponsored" className="btn btn-primary btn-block">
            Register on the official page
          </a>
        ) : (
          <a href={h.sourceUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-block">
            Open official page
          </a>
        )}
        <button type="button" className="btn btn-secondary btn-block" aria-pressed={saved} onClick={() => bookmarks.toggle(h.id)}>
          {saved ? '★ Saved' : '☆ Save for later'}
        </button>
      </div>

      {h.description ? (
        <section className="panel" aria-labelledby="about-heading">
          <h2 id="about-heading">About</h2>
          <p className="description">{h.description}</p>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="facts-heading">
        <h2 id="facts-heading">Key facts</h2>
        <dl className="kv">
          <div>
            <dt>Location</dt>
            <dd>{[h.city, h.state, h.country].filter(Boolean).join(', ') || (h.onlineOrOffline === 'online' ? 'Online' : 'Not stated')}</dd>
          </div>
          {h.venue ? (
            <div>
              <dt>Venue</dt>
              <dd>{h.venue}</dd>
            </div>
          ) : null}
          <div>
            <dt>Team size</dt>
            <dd>{formatTeamSize(h.teamSizeMin, h.teamSizeMax)}</dd>
          </div>
          <div>
            <dt>Eligibility</dt>
            <dd>{h.eligibility ?? 'Not specified'}</dd>
          </div>
          <div>
            <dt>Prize</dt>
            <dd>
              {h.prizeAmount ? formatPrize(h.prizeAmount, h.prizeCurrency) : 'Not specified'}
              {h.prizeDetails ? <span className="muted"> — {h.prizeDetails}</span> : null}
            </dd>
          </div>
          <div>
            <dt>Entry fee</dt>
            <dd>
              {h.freeOrPaid === 'free' ? 'Free' : h.registrationFee ? formatPrize(h.registrationFee, h.registrationFeeCurrency) : h.freeOrPaid === 'paid' ? 'Paid (amount not stated)' : 'Not specified'}
            </dd>
          </div>
          {h.themes.length > 0 ? (
            <div>
              <dt>Themes</dt>
              <dd>{h.themes.join(', ')}</dd>
            </div>
          ) : null}
          {h.technologies.length > 0 ? (
            <div>
              <dt>Technologies</dt>
              <dd>{h.technologies.join(', ')}</dd>
            </div>
          ) : null}
          <div>
            <dt>Last verified</dt>
            <dd>{new Date(h.lastVerifiedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </section>

      <section className="panel" aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Timeline</h2>
        {eventDateConflicts(h).map((c, i) => (
          <p key={i} className="conflict-note" role="alert">
            {c}
          </p>
        ))}
        <ol className="timeline">
          {TIMELINE.map(({ label, key }) => {
            const value = h[key];
            if (typeof value !== 'string' || !value) return null;
            const proof = provenanceFor(provenance, key);
            return (
              <li key={key} className={key === 'registrationDeadline' ? 'is-registration' : undefined}>
                <span className="tl-label">{label}</span>
                <span className="tl-value">{renderTimelineValue(value)}</span>
                {proof ? (
                  <span className="tl-prov">
                    via {proof.source} · {proof.confidence.replace(/_/g, ' ')}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="panel" aria-labelledby="sources-heading">
        <h2 id="sources-heading">Sources ({h.sources.length})</h2>
        <ul className="source-list">
          {h.sources.map((s) => (
            <li key={`${s.source}-${s.sourceRecordId}`}>
              <SourceLink url={s.sourceUrl} name={s.source} /> — {s.title}
            </li>
          ))}
        </ul>
      </section>

      {provenance.length > 0 ? (
        <section className="panel" aria-labelledby="prov-heading">
          <h2 id="prov-heading">Where each fact came from</h2>
          <div className="table-scroll">
            <table className="prov-table">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Value</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {provenance.slice(0, 30).map((p, i) => (
                  <tr key={i}>
                    <td>{p.field}</td>
                    <td className="prov-value">{String(p.value).slice(0, 100)}</td>
                    <td>
                      <SourceLink url={p.sourceUrl} name={p.source} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

    </article>
  );
}

/**
 * Find the provenance entry behind a timeline row, so each milestone shows
 * which source published it and with what confidence. Timeline keys are
 * camelCase (registrationDeadline); provenance fields are snake_case
 * (registration_deadline) — the mapping is a mechanical conversion.
 * A row with no provenance simply shows no attribution rather than a guess.
 */
function provenanceFor(
  provenance: Array<{ field: string; source: string; confidence: string }>,
  key: string,
): { source: string; confidence: string } | null {
  const field = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
  const rank: Record<string, number> = { verified: 4, source_confirmed: 3, partially_verified: 2, inferred: 1, unknown: 0 };
  const matches = provenance.filter((p) => p.field === field);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (rank[b.confidence] ?? 0) - (rank[a.confidence] ?? 0));
  return { source: matches[0].source, confidence: matches[0].confidence };
}

/**
 * Plain-language notes for event-date disagreements (structured field vs the
 * organizer's own description text). Registration conflicts have their own
 * banner; these cover hackathon_start/hackathon_end only.
 */
function eventDateConflicts(h: Hackathon): string[] {
  const out: string[] = [];
  for (const c of h.fieldConflicts ?? []) {
    if (c.field !== 'hackathon_start' && c.field !== 'hackathon_end') continue;
    const what = c.field === 'hackathon_start' ? 'start' : 'end';
    const values = c.values.map((v) => v.value).join(' vs ');
    out.push(`The event ${what} differs between sources (${values}). The structured date is shown — verify on the official page.`);
  }
  return out;
}

function renderTimelineValue(iso: string): string {  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y} — time not specified`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
