import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <section className="state">
      <h1>Page not found</h1>
      <p>The page you asked for does not exist.</p>
      <Link to="/" className="btn btn-primary btn-block">
        Back to search
      </Link>
    </section>
  );
}
