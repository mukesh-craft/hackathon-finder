import { Link } from 'react-router-dom';
import { listCities, searchHackathons } from '../api.js';
import { useAsync, useRefetchOnVisible, useServerClock } from '../hooks.js';
import { SearchBar } from '../components/SearchBar.js';
import { HackathonCard } from '../components/HackathonCard.js';
import { ErrorState, SkeletonList } from '../components/States.js';

export function Home() {
  const cities = useAsync(() => listCities(40), []);
  const openNow = useAsync(() => searchHackathons({ open: true, sort: 'deadline', limit: 6 }), []);
  useRefetchOnVisible(openNow.reload);
  const now = useServerClock(openNow.data?.generatedAt ?? null);

  return (
    <div>
      <section className="hero">
        <h1>Find hackathons near you</h1>
        <p className="lede">
          Real registration deadlines, read from the event&apos;s own page and shown with its source.
        </p>
        <SearchBar autoFocus />
        <div className="popular">
          <span>Popular:</span>
          {(cities.data?.popular ?? ['Chennai', 'Bengaluru', 'Hyderabad', 'Mumbai', 'Delhi', 'Pune']).map((c) => (
            <Link key={c} to={`/hackathons/${c.toLowerCase()}?city=${encodeURIComponent(c)}`} className="chip">
              {c}
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="open-now">
        <div className="section-head">
          <h2 id="open-now">Open now</h2>
          <Link to="/hackathons/all">See all →</Link>
        </div>
        {openNow.loading ? <SkeletonList count={3} /> : null}
        {openNow.error ? <ErrorState message={openNow.error.message} onRetry={openNow.reload} /> : null}
        {openNow.data ? (
          <div className="cards">
            {openNow.data.results.slice(0, 4).map((h) => (
              <HackathonCard key={h.id} hackathon={h} now={now} />
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="how">
        <div className="section-head">
          <h2 id="how">Why trust the deadlines</h2>
        </div>
        <div className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Registration, submission, and event dates are classified separately — a project-submission date is never
            shown as the registration deadline. No published deadline means “Not specified”, never a guess.
          </p>
        </div>
      </section>
    </div>
  );
}
