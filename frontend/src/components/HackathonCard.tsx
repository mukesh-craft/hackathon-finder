import { Link } from 'react-router-dom';
import type { Hackathon } from '@hf/shared';
import { deadlineView, formatPrize, formatTeamSize } from '../deadlines.js';
import { useLocalSet } from '../hooks.js';
import { CountdownPill, ModeBadge, QualityBadge, StatusBadge } from './Badges.js';

function locationLine(h: Hackathon): string {
  if (h.city || h.state) return [h.city, h.state].filter(Boolean).join(', ');
  if (h.locationText) return h.locationText;
  return h.onlineOrOffline === 'online' ? 'Online' : 'Location not stated';
}

export function HackathonCard({ hackathon, now, showDistance = false }: { hackathon: Hackathon; now: Date; showDistance?: boolean }) {
  const view = deadlineView(hackathon, now);
  const bookmarks = useLocalSet('hf:bookmarks');
  const saved = bookmarks.has(hackathon.id);

  return (
    <article className="card" aria-labelledby={`title-${hackathon.id}`}>
      <div className="card-top">
        <div className="card-badges">
          <StatusBadge status={view.status} />
          <QualityBadge quality={hackathon.dataQuality} />
        </div>
        <button
          type="button"
          className={`bookmark${saved ? ' is-saved' : ''}`}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${hackathon.title} from saved` : `Save ${hackathon.title}`}
          onClick={() => bookmarks.toggle(hackathon.id)}
        >
          {saved ? '★' : '☆'}
        </button>
      </div>

      <h3 id={`title-${hackathon.id}`} className="card-title">
        <Link to={`/hackathon/${hackathon.slug}`}>{hackathon.title}</Link>
      </h3>
      {hackathon.organizer ? <p className="card-organizer">{hackathon.organizer}</p> : null}

      <dl className="facts">
        <div>
          <dt>📍 Location</dt>
          <dd>
            {locationLine(hackathon)}
            {showDistance && hackathon.distanceKm !== null ? <span> · {hackathon.distanceKm} km</span> : null}
          </dd>
        </div>
        <div>
          <dt>🗓 Registration closes</dt>
          <dd>
            <strong>
              {view.main}
              {view.tzLabel ? ` ${view.tzLabel}` : ''}
            </strong>
            {view.local ? <span className="local-time">({view.local})</span> : null}
            <CountdownPill label={view.countdown} urgency={view.urgency} expired={view.expired} />
          </dd>
        </div>
        <div>
          <dt>🏆 Prize</dt>
          <dd>{hackathon.prizeAmount ? formatPrize(hackathon.prizeAmount, hackathon.prizeCurrency) : (hackathon.prizeDetails ?? 'Not specified')}</dd>
        </div>
        <div>
          <dt>👥 Team</dt>
          <dd>{formatTeamSize(hackathon.teamSizeMin, hackathon.teamSizeMax)}</dd>
        </div>
        <div>
          <dt>🎯 Eligibility</dt>
          <dd>{hackathon.eligibility ?? 'Not specified'}</dd>
        </div>
        <div>
          <dt>💻 Format</dt>
          <dd>
            <ModeBadge mode={hackathon.onlineOrOffline} />
          </dd>
        </div>
      </dl>

      {hackathon.themes.length > 0 ? (
        <ul className="tag-list" aria-label="Themes">
          {hackathon.themes.slice(0, 5).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}

      {view.inferenceNote ? <p className="inference-note">{view.inferenceNote}</p> : null}
      {hackathon.deadlineConflict ? (
        <p className="conflict-note" role="alert">
          Deadline information differs between sources. Verify on the official page.
        </p>
      ) : null}

      <div className="card-actions">
        <Link to={`/hackathon/${hackathon.slug}`} className="btn btn-secondary">
          Details
        </Link>
        {hackathon.registrationUrl ? (
          <a href={hackathon.registrationUrl} target="_blank" rel="noopener noreferrer sponsored" className="btn btn-primary">
            Register
          </a>
        ) : (
          <a href={hackathon.sourceUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
            Official page
          </a>
        )}
      </div>
      <p className="card-source">
        Source: <SourceLink url={hackathon.sourceUrl} name={hackathon.source} />
        {hackathon.sources.length > 1 ? <span> (+{hackathon.sources.length - 1} more)</span> : null}
      </p>
    </article>
  );
}

export function SourceLink({ url, name }: { url: string; name: string }) {
  let host = name;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // Keep the source id as the label.
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {host}
    </a>
  );
}
