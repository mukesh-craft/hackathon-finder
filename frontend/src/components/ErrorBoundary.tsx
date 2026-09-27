import { Component, type ReactNode } from 'react';

/**
 * Last-resort catch for render crashes. Without this, any uncaught render
 * error unmounts the whole tree and the user stares at an empty white page
 * with no way forward.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(): void {
    // Deliberately not sent anywhere: no tracking backend exists.
  }

  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <section className="state" role="alert" style={{ margin: '2rem 1rem' }}>
          <h1>Something went wrong</h1>
          <p className="muted">The page hit an unexpected error and could not render.</p>
          <div className="state-actions">
            <button type="button" className="btn btn-primary btn-block" onClick={() => window.location.reload()}>
              Reload the page
            </button>
            <a className="btn btn-secondary btn-block" href="/">
              Back to search
            </a>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
