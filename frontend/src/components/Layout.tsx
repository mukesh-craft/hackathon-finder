import { Link, NavLink, useLocation } from 'react-router-dom';

const TABS = [
  { to: '/', label: 'Search', icon: '🔍' },
  { to: '/saved', label: 'Saved', icon: '★' },
  { to: '/health', label: 'Health', icon: '📊' },
] as const;

export function MobileShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const onHealth = location.pathname === '/health' || location.pathname === '/admin';
  return (
    <div className="phone">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Hackathon Finder home">
          <span className="brand-mark" aria-hidden="true">
            {'</>'}
          </span>
          <span className="brand-name">Hackathon Finder</span>
        </Link>
        <span className="spacer" />
      </header>
      <main id="main" className="mainscroll">
        {children}
      </main>
      <nav className="tabbar" aria-label="Primary">
        {TABS.map((t) => {
          const active =
            t.to === '/' ? location.pathname === '/' : location.pathname === t.to || (t.to === '/health' && onHealth);
          return (
            <NavLink key={t.to} to={t.to} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
              <span className="tab-ico" aria-hidden="true">
                {t.icon}
              </span>
              {t.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
