/**
 * Status refresh: recompute the cached `registration_status` column for every
 * record from its stored deadline.
 *
 * Search filters derive status live in SQL (see LIVE_STATUS in
 * services/search.ts), so this refresh is a consistency pass that keeps the
 * stored column — and anything that reads it, like admin counts — truthful.
 * It lives in its own module so both the scheduler and the crawl service can
 * use it without creating an import cycle.
 */
import type { Db } from '../db/client.js';
import { computeRegistrationStatus, guessPrecision } from '@hf/shared';
import { logger as rootLogger } from '../logger.js';
import type { AdapterLogger } from '../adapters/types.js';

export async function refreshStatuses(db: Db, logger: AdapterLogger = rootLogger): Promise<number> {
  const rows = await db.query<{
    id: string;
    registration_deadline: string | null;
    registration_deadline_precision: string;
    registration_opens_at: string | null;
  }>('SELECT id, registration_deadline, registration_deadline_precision, registration_opens_at FROM hackathons');

  let changed = 0;
  for (const row of rows.rows) {
    const status = computeRegistrationStatus({
      deadlineIso: row.registration_deadline,
      precision: guessPrecision(row.registration_deadline ?? '') as never,
      opensIso: row.registration_opens_at,
      now: new Date(),
    });
    await db.query(
      `UPDATE hackathons SET registration_status = $2, registration_status_note = $3, updated_at = now()
       WHERE id = $1 AND (registration_status <> $2 OR COALESCE(registration_status_note,'') <> COALESCE($3,''))`,
      [row.id, status.status, status.note],
    );
    changed += 1;
  }
  logger.info('status refresh complete', { records: changed });
  return changed;
}
