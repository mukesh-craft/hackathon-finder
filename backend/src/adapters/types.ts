/**
 * The contract every source adapter implements.
 *
 * Adding a platform means writing one adapter and registering it; no search,
 * storage or UI code changes. Adapters are intentionally dumb: they turn a
 * source's own representation into `RawHackathon` and record where each value
 * came from. They never merge, never guess, and never decide what a user should
 * see.
 */
import type { RawHackathon, SourceId } from '@hf/shared';

export interface AdapterContext {
  /** Cooperative cancellation for long crawls. */
  signal: AbortSignal;
  /** Receives every record as soon as it is normalized, so one bad page cannot
   *  discard a whole crawl. */
  onRecord: (record: RawHackathon) => Promise<void>;
  log: AdapterLogger;
  /** Cursor state persisted between runs, so a crawl can resume. */
  cursor?: Record<string, unknown>;
}

export interface AdapterLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface AdapterRunResult {
  records: number;
  failed: number;
  cursor?: Record<string, unknown>;
  /** Wall-clock duration, recorded in crawl_runs. */
  durationMs: number;
}

export interface SourceAdapter {
  id: SourceId;
  name: string;
  homepage: string;
  /** Shown in the admin dashboard so a maintainer knows why a source is off. */
  policyNote: string;
  /** Whether the adapter is allowed to run at all. */
  enabled: boolean;
  /** Crawl the source and push every record through `ctx.onRecord`. */
  run: (ctx: AdapterContext) => Promise<AdapterRunResult>;
  /** Cheap probe used by the admin dashboard and health checks. */
  check?: () => Promise<{ ok: boolean; detail: string; durationMs: number }>;
}
