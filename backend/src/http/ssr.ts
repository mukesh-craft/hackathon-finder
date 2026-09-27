/**
 * Server-rendered page content, injected into the SPA shell's #root.
 *
 * The shell alone shows nothing without JavaScript. By pre-rendering the
 * actual event list on the server — from the same database rows and the same
 * @hf/shared formatters the client uses — every page is readable, linkable
 * and usable with JS disabled, on ancient browsers, or when the bundle fails.
 * When JS does run, React replaces this markup wholesale (no hydration).
 */
import type { Db } from '../db/client.js';
import type { Hackathon } from '@hf/shared';
import { countdownTo, formatSourceWallClock } from '@hf/shared';
import { SearchService } from '../services/search.js';
import { popularCities } from '@hf/shared';

export function esc(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Swap the shell's placeholder #root content for pre-rendered HTML. */
export function injectIntoShell(shellHtml: string, contentHtml: string): string {
  const openTag = '<div id="root">';
  const start = shellHtml.indexOf(openTag);
  if (start === -1) return shellHtml;
  const contentStart = start + openTag.length;
  // Root's closing tag is the last </div> before the noscript/script blocks.
  const tail = shellHtml.indexOf('<noscript');
  const scriptPos = shellHtml.indexOf('<script', contentStart);
  const boundary = tail === -1 ? scriptPos : tail;
  const end = shellHtml.lastIndexOf('</div>', boundary === -1 ? undefined : boundary);
  if (end === -1 || end < contentStart) return shellHtml;
  return `${shellHtml.slice(0, contentStart)}${contentHtml}${shellHtml.slice(end)}`;
}

function statusBadge(status: Hackathon['registrationStatus']): string {
  const labels: Record<Hackathon['registrationStatus'], string> = {
    open: 'Registration open',
    upcoming: 'Opening soon',
    closed: 'Registration closed',
    unknown: 'Status unknown',
  };
  return `<span class="badge badge-status-${esc(status)}">${esc(labels[status])}</span>`;
}

function qualityBadge(quality: Hackathon['dataQuality']): string {
  const labels: Record<Hackathon['dataQuality'], string> = {
    verified: 'Verified deadline',
    source_confirmed: 'Source confirmed',
    partially_verified: 'Partially verified',
    unknown: 'Unverified',
  };
  return `<span class="badge badge-quality-${esc(quality)}">${esc(labels[quality])}</span>`;
}

function deadlineLine(h: Hackathon, now: Date): string {
  if (!h.registrationDeadline) {
    return '<strong>Not specified</strong>';
  }
  // Source wall clock (IST stays IST) — never UTC-normalized.
  const formatted = formatSourceWallClock(h.registrationDeadline, h.registrationDeadlineTimezone);
  const cd = countdownTo(h.registrationDeadline, now);
  const main =
    formatted.timeNotSpecified
      ? esc(formatted.main)
      : `${esc(formatted.main)}${formatted.timezoneLabel ? ` ${esc(formatted.timezoneLabel)}` : ''}`;
  return `<strong>${main}</strong> <span class="countdown countdown-${cd.urgency}">${esc(cd.label)}</span>`;
}

function cardHtml(h: Hackathon, now: Date): string {
  const where = [h.city, h.state].filter(Boolean).join(', ') || h.locationText || (h.onlineOrOffline === 'online' ? 'Online' : 'Location not stated');
  const register = h.registrationUrl ?? h.sourceUrl;
  return `<article class="card">
    <div class="card-top"><div class="card-badges">${statusBadge(h.registrationStatus)}${qualityBadge(h.dataQuality)}</div></div>
    <h3 class="card-title"><a href="/hackathon/${esc(h.slug)}">${esc(h.title)}</a></h3>
    ${h.organizer ? `<p class="card-organizer">${esc(h.organizer)}</p>` : ''}
    <dl class="facts">
      <div><dt>📍 Location</dt><dd>${esc(where)}</dd></div>
      <div><dt>🗓 Registration closes</dt><dd>${deadlineLine(h, now)}</dd></div>
      <div><dt>🏆 Prize</dt><dd>${h.prizeAmount ? esc(`${h.prizeCurrency ?? ''}${h.prizeAmount.toLocaleString('en-IN')}`.trim()) : esc(h.prizeDetails ?? 'Not specified')}</dd></div>
    </dl>
    <div class="card-actions">
      <a class="btn btn-secondary" href="/hackathon/${esc(h.slug)}">Details</a>
      <a class="btn btn-primary" href="${esc(register)}">Register</a>
    </div>
  </article>`;
}

function searchFormHtml(): string {
  return `<form role="search" aria-label="Find hackathons by city" action="/hackathons/all" method="get">
    <label class="visually-hidden" for="city-input">Enter a city</label>
    <div class="search-row">
      <input id="city-input" name="city" type="search" autocomplete="off" placeholder="City — Chennai, Mumbai…" />
      <button type="submit" class="btn btn-primary">Go</button>
    </div>
  </form>`;
}

/**
 * When this HTML was rendered. Countdowns inside are frozen at that instant —
 * saying so keeps a cached or JS-less page honest instead of silently stale.
 */
function freshnessNote(now: Date): string {
  const stamp = Number.isNaN(now.getTime()) ? '' : now.toISOString();
  return `<p class="muted freshness">Times shown as of ${esc(stamp)} — reload for live countdowns.</p>`;
}

/** Slug ("bangalore-urban") back to a display name; mirrors the client. */
export function denormalizeSlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export async function renderHomeContent(db: Db, now = new Date()): Promise<string> {
  const search = new SearchService(db);
  const open = await search.search({ page: 1, limit: 4, openOnly: true, sort: 'deadline' }, now);
  const chips = (popularCities().length > 0 ? popularCities() : ['Chennai', 'Mumbai', 'Delhi'])
    .map((c) => `<a class="chip" href="/hackathons/${esc(c.toLowerCase())}?city=${encodeURIComponent(c)}">${esc(c)}</a>`)
    .join('');
  return `<div class="hero"><h1>Find hackathons near you</h1>
    <p class="lede">Real registration deadlines, read from the event's own page and shown with its source.</p>
    <div class="search-box">${searchFormHtml()}</div>
    <div class="popular"><span>Popular:</span>${chips}</div></div>
    <div class="section-head"><h2>Open now</h2></div>
    <div class="cards">${open.results.map((h) => cardHtml(h, now)).join('')}</div>
    ${freshnessNote(now)}`;
}

export async function renderCityContent(
  db: Db,
  citySlug: string,
  queryCity: string | undefined,
  now = new Date(),
): Promise<{ title: string; html: string }> {
  const search = new SearchService(db);
  const browseAll = citySlug.toLowerCase() === 'all' && !queryCity;
  const city = browseAll ? undefined : queryCity ?? denormalizeSlug(citySlug);
  const result = await search.search(
    { city, page: 1, limit: 10, openOnly: false, radiusKm: city ? 50 : null, mode: 'all', sort: 'relevance' },
    now,
  );
  const heading = city ? `Hackathons in ${esc(result.city.name ?? city)}` : 'Browse hackathons';
  const notes = (result.city.notes ?? []).map((n) => `<p class="muted">${esc(n)}</p>`).join('');
  const list =
    result.results.length > 0
      ? `<div class="cards">${result.results.map((h) => cardHtml(h, now)).join('')}</div>`
      : '<section class="state"><h2>No currently open hackathons found here.</h2><p>Try nearby cities or online hackathons.</p></section>';
  const online =
    result.online && result.online.total > 0
      ? `<div class="section-head"><h2>Online — join from ${esc(result.city.name ?? city ?? 'anywhere')}</h2></div>
         <div class="cards">${result.online.results.slice(0, 6).map((h) => cardHtml(h, now)).join('')}</div>`
      : '';
  return {
    title: city ? `Hackathons in ${result.city.name ?? city}` : 'Browse hackathons',
    html: `<h1 style="font-size:1.35rem;margin:0.2rem 0 0.6rem">${heading}</h1>${notes}<div class="search-box">${searchFormHtml()}</div>${list}${online}${freshnessNote(now)}`,
  };
}
