import { Link } from 'react-router-dom';

export function EmptyState({ city, onClear }: { city: string; onClear?: () => void }) {
  return (
    <section className="state state-empty" aria-live="polite">
      <h2>No currently open hackathons found{city ? ` in ${city}` : ''}.</h2>
      <p>Try:</p>
      <ul>
        <li>Nearby cities</li>
        <li>Online hackathons</li>
        <li>Upcoming events</li>
      </ul>
      <p className="muted">We never invent events — when nothing is listed, we say so.</p>
      <div className="state-actions">
        <Link to="/hackathons/all" className="btn btn-secondary btn-block">
          Browse everything open
        </Link>
        {onClear ? (
          <button type="button" className="btn btn-ghost btn-block" onClick={onClear}>
            Clear filters
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <section className="state state-error" role="alert">
      <h2>Something went wrong</h2>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-primary btn-block" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </section>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="cards" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton">
          <div className="sk sk-title" />
          <div className="sk sk-line" />
          <div className="sk sk-line short" />
          <div className="sk sk-line" />
          <div className="sk sk-actions" />
        </div>
      ))}
    </div>
  );
}
