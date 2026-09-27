/** Shared scaffolding for backend tests: an empty, migrated PostgreSQL per file. */
import { beforeAll, afterAll } from 'vitest';
import { createEphemeralDb, runMigrations, type Db } from '../src/db/client.js';

let db: Db;

beforeAll(async () => {
  db = await createEphemeralDb();
  await runMigrations(db);
});

afterAll(async () => {
  await db?.close();
});

export function testDb(): Db {
  if (!db) throw new Error('test database not initialised');
  return db;
}

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
