/** Typed client for the Hackathon Finder REST API. Same-origin in production. */
import type { Hackathon, PipelineStats, SearchQuery, SearchResponse } from '@hf/shared';

/**
 * API origin. Empty by default (same-origin: the backend serves the SPA).
 * Set VITE_API_URL at build time to split hosting, e.g. static frontend on
 * Vercel talking to the API on Render: VITE_API_URL=https://xxx.onrender.com
 */
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export interface ProvenanceEntry {
  field: string;
  value: string | null;
  source: string;
  sourceUrl: string;
  retrievedAt: string;
  confidence: string;
}

export interface DetailsResponse {
  hackathon: Hackathon;
  provenance: ProvenanceEntry[];
  generatedAt: string;
}

export interface CitySummary {
  id: string;
  name: string;
  state: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  event_count: number;
  open_count: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    let code = 'request_failed';
    let message = `Request failed with status ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error page; keep the generic message.
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export interface SearchParams {
  city?: string;
  q?: string;
  open?: boolean;
  radius?: number;
  mode?: 'all' | 'online' | 'offline';
  free?: boolean;
  paid?: boolean;
  prize?: boolean;
  teamSize?: number;
  theme?: string[];
  tech?: string[];
  eligibility?: string[];
  eventFrom?: string;
  eventTo?: string;
  sort?: SearchQuery['sort'];
  page?: number;
  limit?: number;
}

export function searchHackathons(params: SearchParams): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else {
      qs.set(key, String(value));
    }
  }
  return request<SearchResponse>(`/api/hackathons?${qs.toString()}`);
}

export function hackathonDetails(slug: string): Promise<DetailsResponse> {  return request<DetailsResponse>(`/api/hackathons/slug/${encodeURIComponent(slug)}`);
}

export function hackathonById(id: string): Promise<DetailsResponse> {
  return request<DetailsResponse>(`/api/hackathons/${encodeURIComponent(id)}`);
}

export interface RefreshResponse {
  started: boolean;
  reason: string;
  retryAfterMs: number;
}

/** Ask the server for a fresh crawl. Interval-guarded, background, never blocking. */
export function requestRefresh(): Promise<RefreshResponse> {
  return request<RefreshResponse>('/api/refresh', { method: 'POST' });
}

export function listCities(limit = 60): Promise<{ count: number; cities: CitySummary[]; popular: string[] }> {
  return request(`/api/cities?limit=${limit}`);
}

export function suggestCities(q: string): Promise<{
  results: Array<{ name: string; slug: string; state?: string | null; country: string; locality?: boolean }>;
}> {
  return request(`/api/cities/suggest?q=${encodeURIComponent(q)}`);
}

export function topCities(): Promise<{ cities: Array<{ name: string; slug: string; openCount: number; totalCount: number }> }> {
  return request('/api/top-cities');
}

export function adminStats(token?: string): Promise<PipelineStats> {
  return request('/api/admin/stats', token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
}

export function adminCrawls(token?: string): Promise<{
  runs: Array<{
    id: string;
    source: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    records_seen: number;
    records_upserted: number;
    records_failed: number;
    duration_ms: number | null;
    error: string | null;
  }>;
}> {
  return request('/api/admin/crawls', token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
}
