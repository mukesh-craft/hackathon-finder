import { describe, expect, it } from 'vitest';
import { testDb, silentLogger } from './setup.js';
import { maybeSeedOnBoot } from '../src/boot-seed.js';

describe('maybeSeedOnBoot', () => {
  it('skips when the flag is off without touching crawlers', async () => {
    let calls = 0;
    const outcome = await maybeSeedOnBoot({
      db: testDb(),
      logger: silentLogger,
      onBoot: false,
      crawl: async () => {
        calls += 1;
      },
    });
    expect(outcome).toBe('skipped-disabled');
    expect(calls).toBe(0);
  });

  it('crawls exactly once on an empty database', async () => {
    let calls = 0;
    const outcome = await maybeSeedOnBoot({
      db: testDb(),
      logger: silentLogger,
      onBoot: true,
      crawl: async () => {
        calls += 1;
      },
    });
    expect(outcome).toBe('seeded');
    expect(calls).toBe(1);
  });

  it('skips a database that already has rows', async () => {
    const db = testDb();
    await db.query(
      `INSERT INTO hackathons (id, slug, title, source, source_url) VALUES (gen_random_uuid(), 'seeded-row', 'Seeded', 'unstop', 'https://unstop.com/')`,
    );
    try {
      let calls = 0;
      const outcome = await maybeSeedOnBoot({
        db,
        logger: silentLogger,
        onBoot: true,
        crawl: async () => {
          calls += 1;
        },
      });
      expect(outcome).toBe('skipped-nonempty');
      expect(calls).toBe(0);
    } finally {
      await db.query(`DELETE FROM hackathons WHERE slug = 'seeded-row'`);
    }
  });

  it('reports failure instead of throwing when the crawl blows up', async () => {
    const outcome = await maybeSeedOnBoot({
      db: testDb(),
      logger: silentLogger,
      onBoot: true,
      crawl: async () => {
        throw new Error('network down');
      },
    });
    expect(outcome).toBe('failed');
  });
});
