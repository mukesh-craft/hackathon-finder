/**
 * Server-rendered metadata for indexable routes.
 *
 * The application is a client-rendered SPA, but search engines should not have
 * to execute JavaScript to learn what a page is about. These routes emit the same
 * shell with a real <title>, description, canonical URL, Open Graph tags,
 * JSON-LD and a <noscript> list of the actual events, all built from the same
 * database rows the UI renders. No content is invented for crawlers.
 */
import type { Hackathon, SearchResponse } from '@hf/shared';
import { DEADLINE_KIND_LABELS, countdownTo, formatDeadline } from '@hf/shared';
import { config } from '../config.js';

function esc(value: string | null | undefined): string {
  if (!value) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function base(): string {
  return config.publicBaseUrl.replace(/\/$/, '');
}

interface CitySeoInput {
  kind: 'city';
  city: string;
  result: SearchResponse;
}

interface EventSeoInput {
  kind: 'event';
  record: Hackathon;
}

interface MissingSeoInput {
  kind: 'missing';
  slug: string;
}

export function seoHtml(input: CitySeoInput | EventSeoInput | MissingSeoInput): string {
  if (input.kind === 'city') return cityHtml(input);
  if (input.kind === 'event') return eventHtml(input);
  return minimalHtml({
    title: 'Hackathon not found',
    description: 'This hackathon page could not be found.',
    canonical: `${base()}/`,
    jsonLd: null,
    body: '<h1>Hackathon not found</h1><p>This event is no longer listed. <a href="/">Search for hackathons</a>.</p>',
  });
}

function cityHtml({ city, result }: CitySeoInput): string {
  const resolvedName = result.city.name ?? city;
  const slug = result.city.slug ?? city.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const open = result.results.filter((r) => r.registrationStatus === 'open');
  const title = `Hackathons in ${resolvedName} — Upcoming & Open Registrations`;
  const description = `${result.total} hackathon${result.total === 1 ? '' : 's'} in ${resolvedName} with registration deadlines from Unstop, Devpost, MLH and official organizer pages. ${open.length} with registration still open.`;
  const canonical = `${base()}/hackathons/${slug}`;

  const items = result.results
    .map((r) => {
      const deadline = describeDeadline(r);
      return `<li><a href="/hackathon/${esc(r.slug)}"><strong>${esc(r.title)}</strong></a> — ${esc(r.organizer ?? 'Organizer not stated')} — ${esc(
        [r.city, r.state].filter(Boolean).join(', ') || (r.onlineOrOffline === 'online' ? 'Online' : 'Location not stated'),
      )} — registration ${esc(deadline)} — ${esc(r.onlineOrOffline)}</li>`;
    })
    .join('\n');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: title,
    description,
    url: canonical,
    numberOfItems: result.total,
    itemListElement: result.results.slice(0, 50).map((r, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${base()}/hackathon/${r.slug}`,
      name: r.title,
    })),
  };

  const body = `
    <h1>Hackathons in ${esc(resolvedName)}</h1>
    <p>${esc(description)}</p>
    <noscript>
      <h2>${result.total} result${result.total === 1 ? '' : 's'}</h2>
      <ul>${items || '<li>No hackathons are currently listed for this city.</li>'}</ul>
    </noscript>
    <p><a href="/?city=${encodeURIComponent(city)}">Search hackathons in ${esc(resolvedName)}</a></p>`;

  return minimalHtml({ title, description, canonical, jsonLd, body });
}

function eventHtml({ record }: EventSeoInput): string {
  const where = [record.city, record.state, record.country].filter(Boolean).join(', ');
  const deadline = describeDeadline(record);
  const title = `${record.title} — Registration deadline${record.registrationDeadline ? ` ${formatDeadline(record.registrationDeadline, { timeZone: 'UTC' }).main}` : ' not specified'}`;
  const description = `${record.organizer ?? 'Hackathon'}${where ? `, ${where}` : ''}. ${record.registrationStatus === 'open' ? 'Registration is open.' : record.registrationStatus === 'closed' ? 'Registration has closed.' : 'Registration status is not published.'} ${deadline}.`;
  const canonical = `${base()}/hackathon/${record.slug}`;

  const timeline = [
    ['Registration opens', record.registrationOpensAt],
    ['Registration closes', record.registrationDeadline],
    ['Idea submission deadline', record.ideaSubmissionDeadline],
    ['Submission deadline', record.submissionDeadline],
    ['Hackathon starts', record.hackathonStart],
    ['Hackathon ends', record.hackathonEnd],
    ['Final presentation', record.finalPresentation],
    ['Results announced', record.resultAnnouncement],
  ] as const;

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: record.title,
    url: canonical,
    description: record.description?.slice(0, 500) ?? description,
    eventAttendanceMode: record.onlineOrOffline === 'online' ? 'https://schema.org/OnlineEventAttendanceMode' : 'https://schema.org/OfflineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    organizer: { '@type': 'Organization', name: record.organizer ?? 'Organizer not stated' },
  };
  if (record.hackathonStart) jsonLd.startDate = record.hackathonStart;
  if (record.hackathonEnd) jsonLd.endDate = record.hackathonEnd;
  if (record.locationText) {
    jsonLd.location = record.onlineOrOffline === 'online'
      ? { '@type': 'VirtualLocation', url: record.sourceUrl }
      : { '@type': 'Place', name: record.locationText, address: record.venue ?? record.locationText };
  }
  if (record.registrationDeadline) {
    jsonLd.offers = {
      '@type': 'Offer',
      availability: record.registrationStatus === 'open' ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut',
      url: record.registrationUrl ?? record.sourceUrl,
      validThrough: record.registrationDeadline,
    };
  }

  const body = `
    <h1>${esc(record.title)}</h1>
    <p>${esc(description)}</p>
    <table>
      <tr><th>Organizer</th><td>${esc(record.organizer ?? 'Not stated')}</td></tr>
      <tr><th>Location</th><td>${esc(where || (record.onlineOrOffline === 'online' ? 'Online' : 'Not stated'))}</td></tr>
      <tr><th>Registration</th><td>${esc(deadline)} (${esc(record.registrationStatus)})</td></tr>
      <tr><th>Format</th><td>${esc(record.onlineOrOffline)}</td></tr>
      <tr><th>Team size</th><td>${esc(teamSize(record))}</td></tr>
      <tr><th>Prize</th><td>${esc(prize(record))}</td></tr>
      <tr><th>Data quality</th><td>${esc(record.dataQuality)}</td></tr>
    </table>
    <h2>Timeline</h2>
    <ul>${timeline
      .filter(([, value]) => Boolean(value))
      .map(([label, value]) => `<li>${esc(DEADLINE_KIND_LABELS[labelOf(label)])}: ${esc(value)}</li>`)
      .join('')}</ul>
    <h2>Sources</h2>
    <ul>${record.sources
      .map((s) => `<li><a href="${esc(s.sourceUrl)}">${esc(s.source)}</a> — ${esc(s.title)}</li>`)
      .join('')}</ul>
    <p><a href="${esc(record.registrationUrl ?? record.sourceUrl)}">Register on the official page</a></p>
    <p><a href="/hackathon/${esc(record.slug)}">View full details</a></p>`;

  return minimalHtml({ title, description, canonical, jsonLd, body });
}

function labelOf(label: string): keyof typeof DEADLINE_KIND_LABELS {
  const map: Record<string, keyof typeof DEADLINE_KIND_LABELS> = {
    'Registration opens': 'registration_opens',
    'Registration closes': 'registration_deadline',
    'Idea submission deadline': 'idea_submission_deadline',
    'Submission deadline': 'submission_deadline',
    'Hackathon starts': 'hackathon_start',
    'Hackathon ends': 'hackathon_end',
    'Final presentation': 'final_presentation',
    'Results announced': 'result_announcement',
  };
  return map[label] ?? 'unknown';
}

export function describeDeadline(record: Hackathon): string {
  if (!record.registrationDeadline) return 'deadline not specified';
  const formatted = formatDeadline(record.registrationDeadline, {
    timeZone: 'UTC',
    sourceTimezoneLabel: record.registrationDeadlineTimezone,
  });
  const count = countdownTo(record.registrationDeadline);
  return `${formatted.main}${count.expired ? ' (closed)' : ` (${count.label})`}`;
}

function teamSize(record: Hackathon): string {
  if (record.teamSizeMin && record.teamSizeMax) {
    return record.teamSizeMin === record.teamSizeMax ? `${record.teamSizeMin}` : `${record.teamSizeMin}–${record.teamSizeMax}`;
  }
  if (record.teamSizeMax) return `up to ${record.teamSizeMax}`;
  if (record.teamSizeMin) return `from ${record.teamSizeMin}`;
  return 'Not specified';
}

function prize(record: Hackathon): string {
  if (!record.prizeAmount) return 'Not specified';
  return `${record.prizeCurrency ?? ''}${record.prizeAmount.toLocaleString('en-IN')}`.trim();
}

function minimalHtml(input: {
  title: string;
  description: string;
  canonical: string;
  jsonLd: Record<string, unknown> | null;
  body: string;
}): string {
  const siteName = 'Hackathon Finder';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
<meta name="description" content="${esc(input.description)}">
<link rel="canonical" href="${esc(input.canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(siteName)}">
<meta property="og:title" content="${esc(input.title)}">
<meta property="og:description" content="${esc(input.description)}">
<meta property="og:url" content="${esc(input.canonical)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(input.title)}">
<meta name="twitter:description" content="${esc(input.description)}">
${input.jsonLd ? `<script type="application/ld+json">${JSON.stringify(input.jsonLd)}</script>` : ''}
</head>
<body>
<main>
${input.body}
</main>
</body>
</html>`;
}
