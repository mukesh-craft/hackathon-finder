/** Small HTML helpers shared by adapters. Uses cheerio, never a regex on raw HTML. */
import * as cheerio from 'cheerio';

const BLOCK_TAGS = 'script,style,noscript,template,svg,iframe';

/** Block elements whose text must not glue together ("MembersDate:"). */
const BLOCK_SEPARATORS = 'p, li, ul, ol, div, br, h1, h2, h3, h4, h5, h6, tr, td, th, section, article, header, footer, hr';

/** Visible text from an HTML fragment, with collapsed whitespace. */
export function stripHtml(html: string | null | undefined, maxLength = 20_000): string {
  if (!html) return '';
  try {
    const $ = cheerio.load(`<div>${html}</div>`, null, false);
    $(BLOCK_TAGS).remove();
    // Separate block elements first: without this, "<li>A</li><li>B</li>"
    // becomes "AB", fusing labels into their neighbours ("MembersDate:").
    $(BLOCK_SEPARATORS).each((_, el) => {
      $(el).after('\n');
    });
    const text = $.root().text().replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return '';
  }
}

export interface JsonLdEvent {
  '@type'?: string | string[];
  name?: string;
  startDate?: string;
  endDate?: string;
  url?: string;
  location?: unknown;
  organizer?: unknown;
  description?: string;
  eventStatus?: string;
  offers?: unknown;
}

function typeMatches(node: Record<string, unknown>): boolean {
  const t = node['@type'];
  if (Array.isArray(t)) return t.some((x) => String(x).toLowerCase() === 'event');
  return String(t ?? '').toLowerCase() === 'event';
}

function walk(node: unknown, out: JsonLdEvent[], depth = 0): void {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (typeMatches(obj)) out.push(obj as JsonLdEvent);
  if (Array.isArray(obj['@graph'])) walk(obj['@graph'], out, depth + 1);
  if (obj['@graph']) walk(obj['@graph'], out, depth + 1);
}

/** Extract schema.org Event nodes from JSON-LD blocks. Malformed blocks are skipped. */
export function extractJsonLdEvents(html: string): JsonLdEvent[] {
  const out: JsonLdEvent[] = [];
  try {
    const $ = cheerio.load(html);
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text();
      if (!raw?.trim()) return;
      try {
        walk(JSON.parse(raw), out);
      } catch {
        // A malformed block is skipped, never fatal.
      }
    });
  } catch {
    return out;
  }
  return out;
}

export interface MetaTag {
  name: string;
  content: string;
}

export function extractMeta(html: string): MetaTag[] {
  const out: MetaTag[] = [];
  try {
    const $ = cheerio.load(html);
    $('meta').each((_, el) => {
      const node = $(el);
      const name = node.attr('property') ?? node.attr('name') ?? node.attr('itemprop');
      const content = node.attr('content');
      if (name && content) out.push({ name: name.toLowerCase(), content });
    });
  } catch {
    return out;
  }
  return out;
}

/** Read a schema.org PostalAddress out of a JSON-LD location value. */
export function readAddress(value: unknown): { address?: string; city?: string; region?: string; country?: string } {
  if (!value) return {};
  const list = Array.isArray(value) ? value : [value];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const node = entry as Record<string, unknown>;
    const address = (node.address ?? node) as Record<string, unknown>;
    if (typeof address === 'string') return { address };
    if (address && typeof address === 'object') {
      const street = [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode]
        .filter((x) => typeof x === 'string' && x)
        .join(', ');
      return {
        address: (typeof node.name === 'string' ? node.name : undefined) ?? (street || undefined),
        city: typeof address.addressLocality === 'string' ? address.addressLocality : undefined,
        region: typeof address.addressRegion === 'string' ? address.addressRegion : undefined,
        country: typeof address.addressCountry === 'string' ? address.addressCountry : undefined,
      };
    }
  }
  return {};
}
