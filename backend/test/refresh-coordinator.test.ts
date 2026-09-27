/**
 * Visit-refresh coordinator: interval guard, in-flight guard, disabled mode.
 * The crawl runner is stubbed — these tests never touch the network.
 */
import { describe, expect, it } from 'vitest';
import { testDb, silentLogger } from './setup.js';
import { RefreshCoordinator } from '../src/services/refresh-coordinator.js';

const SETTINGS = { enabled: true, intervalMs: 30 * 60_000, manualIntervalMs: 5 * 60_000 };

describe('RefreshCoordinator', () => {
  it('stays disabled when configured off and runs nothing', async () => {
    const db = testDb();
    let calls = 0;
    const coord = new RefreshCoordinator(
      db,
      silentLogger,
      { ...SETTINGS, enabled: false, disabledReason: 'disabled in tests' },
      async () => {
        calls += 1;
      },
    );
    const r = await coord.maybeRefresh({ manual: true });
    expect(r.started).toBe(false);
    expect(r.reason).toBe('disabled in tests');
    await new Promise((s) => setTimeout(s, 20));
    expect(calls).toBe(0);
  });

  it('starts when no recent run exists and refuses a second concurrent run', async () => {
    const db = testDb();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const coord = new RefreshCoordinator(db, silentLogger, SETTINGS, () =>
      (async () => {
        calls += 1;
        await gate;
      })(),
    );
    const first = await coord.maybeRefresh({ manual: true });
    expect(first.started).toBe(true);
    const second = await coord.maybeRefresh({ manual: true });
    expect(second.started).toBe(false);
    expect(second.reason).toBe('refresh already running');
    release();
    await new Promise((s) => setTimeout(s, 20));
    expect(calls).toBe(1);
  });

  it('refuses when a recent run finished inside the interval', async () => {
    const db = testDb();
    await db.query(
      `INSERT INTO crawl_runs (id, source, status, started_at, finished_at) VALUES
       ('00000000-0000-0000-0000-000000000099', 'unstop', 'ok', now(), now())`,
    );
    let calls = 0;
    const coord = new RefreshCoordinator(db, silentLogger, SETTINGS, async () => {
      calls += 1;
    });
    const r = await coord.maybeRefresh({ manual: false });
    expect(r.started).toBe(false);
    expect(r.reason).toBe('refreshed recently');
    expect(r.retryAfterMs).toBeGreaterThan(0);
    await new Promise((s) => setTimeout(s, 20));
    expect(calls).toBe(0);
  });
});
