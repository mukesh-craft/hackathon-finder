/**
 * Refresh-on-visit coordinator.
 *
 * Users reasonably expect fresh data every time they open the site, but a full
 * crawl takes minutes and hammers third parties — doing it synchronously per
 * visit would make every page load slow and get us throttled. Instead:
 *
 *  - each search request asks `maybeRefresh()` (one cheap MAX() query);
 *  - at most one background crawl runs at a time, and at most once per
 *    interval (30 min automatic, 5 min manual);
 *  - the light profile covers the fast sources only (Unstop + MLH, no venue
 *    geocoding, no Devpost detail enrichment) so a background run finishes in
 *    ~2 minutes without touching the request path;
 *  - the API response carries `refreshing: true` while it runs, so the UI can
 *    say "Updating…" instead of showing silent staleness.
 */
import type { Db } from '../db/client.js';
import { config } from '../config.js';
import { logger as rootLogger } from '../logger.js';
import type { AdapterLogger } from '../adapters/types.js';
import { CrawlService } from './crawl.js';

export interface CoordinatorSettings {
  enabled: boolean;
  intervalMs: number;
  manualIntervalMs: number;
  disabledReason?: string | null;
}

export interface RefreshAttempt {
  started: boolean;
  reason: string;
  /** Ms until another manual refresh is allowed (0 when started or disabled). */
  retryAfterMs: number;
}

/** Fast sources only: listing reads, no detail enrichment, no venue geocoding. */
export const LIGHT_REFRESH_SOURCES = ['unstop', 'mlh'] as const;

export class RefreshCoordinator {
  private inFlight = false;

  constructor(
    private readonly db: Db,
    private readonly logger: AdapterLogger = rootLogger,
    private readonly settings: CoordinatorSettings = {
      enabled: config.visitRefresh.enabled && !config.isTest,
      intervalMs: config.visitRefresh.intervalMs,
      manualIntervalMs: config.visitRefresh.manualIntervalMs,
    },
    private readonly runCrawl: () => Promise<void> = () => this.defaultRun(),
  ) {}

  async maybeRefresh(opts: { manual: boolean }): Promise<RefreshAttempt> {
    if (!this.settings.enabled) {
      return { started: false, reason: this.settings.disabledReason ?? 'disabled', retryAfterMs: 0 };
    }
    if (this.inFlight) {
      return { started: false, reason: 'refresh already running', retryAfterMs: 0 };
    }
    const interval = opts.manual ? this.settings.manualIntervalMs : this.settings.intervalMs;
    const last = await this.lastRunStartedAt();
    const elapsed = Date.now() - last;
    if (elapsed < interval) {
      return { started: false, reason: 'refreshed recently', retryAfterMs: interval - elapsed };
    }
    this.inFlight = true;
    void this.run().finally(() => {
      this.inFlight = false;
    });
    return { started: true, reason: opts.manual ? 'manual refresh started' : 'background refresh started', retryAfterMs: 0 };
  }

  private async lastRunStartedAt(): Promise<number> {
    try {
      const res = await this.db.query<{ at: string | null }>(
        `SELECT MAX(started_at)::text AS at FROM crawl_runs WHERE status IN ('ok','failed','running')`,
      );
      const at = res.rows[0]?.at;
      const ms = at ? new Date(at).getTime() : NaN;
      return Number.isNaN(ms) ? 0 : ms;
    } catch {
      return 0;
    }
  }

  private async run(): Promise<void> {
    try {
      await this.runCrawl();
    } catch (err) {
      this.logger.warn('visit refresh failed', { error: (err as Error).message });
    }
  }

  private async defaultRun(): Promise<void> {
    const crawl = new CrawlService(this.db, this.logger);
    await crawl.crawl({
      sources: [...LIGHT_REFRESH_SOURCES] as never,
      geocodeVenues: false,
      logger: this.logger,
    });
  }
}
