import { Navigate, Route, Routes } from 'react-router-dom';
import { MobileShell } from './components/Layout.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Home } from './pages/Home.js';
import { SearchResults } from './pages/SearchResults.js';
import { Saved } from './pages/Saved.js';
import { Details } from './pages/Details.js';
import { Health } from './pages/Health.js';
import { NotFound } from './pages/NotFound.js';

export function App() {
  return (
    <MobileShell>
      <ErrorBoundary>
        <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/hackathons/:city" element={<SearchResults />} />
        <Route path="/hackathon/:slug" element={<Details />} />
        <Route path="/saved" element={<Saved />} />
        <Route path="/health" element={<Health />} />
        <Route path="/admin" element={<Navigate to="/health" replace />} />
        <Route path="/ai" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </ErrorBoundary>
    </MobileShell>
  );
}
