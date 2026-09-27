/**
 * Outbound HTTP with SSRF protection, per-host rate limiting and retries.
 *
 * Every network read performed by an adapter goes through `safeFetch`. It is the
 * single place where a user-supplied URL (organizer websites) or a hard-coded
 * source endpoint is turned into an actual request, so the protections live here
 * rather than being re-implemented per adapter.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config.js';

export class FetchBlockedError extends Error {
  readonly code: string;
  constructor(message: string, code = 'blocked') {
    super(message);
    this.name = 'FetchBlockedError';
    this.code = code;
  }
}

export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchTimeoutError';
  }
}

const lastRequestAt = new Map<string, number>();

/** Minimum spacing between requests to the same host, across all adapters. */
async function throttle(url: string): Promise<void> {
  const host = new URL(url).host;
  const delay = config.http.perHostDelayMs;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + delay - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
}

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                       // 0.0.0.0/8
  if (a === 10) return true;                      // 10.0.0.0/8
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;          // 192.0.0.0/24 IETF protocol
  if (a >= 224) return true;                      // multicast / reserved
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80')) return true;       // link-local
  if (/^f[cd]/.test(lower)) return true;           // unique local
  if (lower.startsWith('::ffff:')) return ipv4IsPrivate(lower.slice(7));
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4IsPrivate(ip);
  if (version === 6) return ipv6IsPrivate(ip);
  return true;
}

export interface SafeFetchOptions {
  /** Hosts this call is permitted to reach. Empty means "no host restriction". */
  allowedHosts?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  accept?: string;
  retries?: number;
  method?: string;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
}

const BLOCKED_PORTS = new Set([22, 23, 25, 445, 3306, 5432, 6379, 9200, 11211, 27017]);

/** Validate a URL and every address it resolves to. */
export async function assertUrlAllowed(rawUrl: string, allowedHosts?: string[]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchBlockedError(`Malformed URL: ${rawUrl}`, 'malformed_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new FetchBlockedError(`Unsupported protocol: ${url.protocol}`, 'bad_protocol');
  }
  if (BLOCKED_PORTS.has(Number(url.port))) {
    throw new FetchBlockedError(`Blocked port: ${url.port}`, 'bad_port');
  }
  if (allowedHosts && allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const ok = allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
    if (!ok) throw new FetchBlockedError(`Host not allowed: ${host}`, 'host_not_allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new FetchBlockedError(`Refusing to request private address: ${hostname}`, 'private_address');
    }
  } else {
    let records: Array<{ address: string }>;
    try {
      records = await lookup(hostname, { all: true });
    } catch {
      throw new FetchBlockedError(`DNS lookup failed for ${hostname}`, 'dns_failure');
    }
    if (records.length === 0) throw new FetchBlockedError(`No DNS records for ${hostname}`, 'dns_failure');
    for (const r of records) {
      if (isPrivateAddress(r.address)) {
        throw new FetchBlockedError(
          `${hostname} resolves to a private address (${r.address})`,
          'private_address',
        );
      }
    }
  }
  return url;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Perform a guarded GET. Returns the body as text, capped at `maxBytes`.
 * Throws on network failure, timeout, oversize body and non-2xx status.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const retries = opts.retries ?? config.http.retries;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await assertUrlAllowed(rawUrl, opts.allowedHosts);
      await throttle(rawUrl);
      return await performFetch(rawUrl, opts);
    } catch (err) {
      lastError = err;
      const status = err instanceof HttpStatusError ? err.status : 0;
      const retryable = err instanceof FetchTimeoutError || (status && RETRYABLE_STATUS.has(status));
      if (!retryable || attempt === retries) break;
      // Exponential backoff with jitter, capped.
      const wait = Math.min(15_000, 700 * 2 ** attempt) + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

async function performFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? config.http.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rawUrl, {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'user-agent': config.http.userAgent,
        accept: opts.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...(opts.headers ?? {}),
      },
    });

    let current = res;
    let url = rawUrl;
    let hops = 0;
    while (current.status >= 300 && current.status < 400) {
      const location = current.headers.get('location');
      if (!location) break;
      if (hops >= config.http.maxRedirects) {
        throw new FetchBlockedError('Too many redirects', 'too_many_redirects');
      }
      // Re-validate every hop so a redirect cannot walk into the private network.
      const next = new URL(location, url).toString();
      await assertUrlAllowed(next, opts.allowedHosts);
      url = next;
      hops += 1;
      await throttle(url);
      current = await fetch(url, {
        method: opts.method ?? 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': config.http.userAgent,
          accept: opts.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...(opts.headers ?? {}),
        },
      });
    }

    const contentType = current.headers.get('content-type') ?? '';
    if (!current.ok) {
      await current.body?.cancel().catch(() => undefined);
      throw new HttpStatusError(current.status, url);
    }
    const maxBytes = opts.maxBytes ?? config.http.maxBytes;
    const reader = current.body?.getReader();
    if (!reader) {
      return { url, status: current.status, contentType, body: '', bytes: 0 };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FetchBlockedError(`Response exceeds ${maxBytes} bytes`, 'body_too_large');
      }
      chunks.push(value);
    }
    const body = new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, total));
    return { url, status: current.status, contentType, body, bytes: total };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FetchTimeoutError(`Request to ${rawUrl} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Fetch and parse JSON, with a shape guard so a soft-404 HTML page fails loudly. */
export async function safeFetchJson<T>(url: string, opts: SafeFetchOptions = {}): Promise<T> {
  const res = await safeFetch(url, { accept: 'application/json,text/plain;q=0.9', ...opts });
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`Response from ${url} was not valid JSON (content-type: ${res.contentType})`);
  }
}
