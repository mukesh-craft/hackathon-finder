/**
 * Database access with two interchangeable drivers.
 *
 * - `DATABASE_URL` set  -> node-postgres against a real PostgreSQL server.
 * - otherwise            -> PGlite, which is PostgreSQL 18 compiled to
 *                           WebAssembly running in-process.
 *
 * Both speak the same SQL, so migrations, indexes and queries are identical in
 * development, tests and production. Only the connection bootstrap differs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config, REPO_ROOT } from '../config.js';

export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'postgres' | 'pglite';
}

/** PGlite returns dates as JS Date objects; node-postgres also does. Normalise both. */
class PgliteDb implements Db {
  readonly driver = 'pglite' as const;
  constructor(private readonly pg: PGlite) {}

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query<T>(sql, params as never[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    await this.pg.exec('BEGIN');
    try {
      const out = await fn(this);
      await this.pg.exec('COMMIT');
      return out;
    } catch (err) {
      await this.pg.exec('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

class PostgresDb implements Db {
  readonly driver = 'postgres' as const;
  constructor(private readonly pool: Pool) {}

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params as never[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const scoped = new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async <R extends QueryResultRow>(sql: string, params: unknown[] = []) => {
            const res = await client.query(sql, params as never[]);
            return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
          };
        }
        if (prop === 'exec') return async (sql: string) => { await client.query(sql); };
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    try {
      await client.query('BEGIN');
      const out = await fn(scoped);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let instance: Db | null = null;

export async function getDb(): Promise<Db> {
  if (instance) return instance;
  if (config.databaseUrl) {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: config.isProduction && !/localhost|127\.0\.0\.1/.test(config.databaseUrl)
        ? { rejectUnauthorized: false }
        : undefined,
    });
    instance = new PostgresDb(pool);
  } else {
    const dir = config.pgliteDataDir;
    const pg = await PGlite.create({ dataDir: dir });
    instance = new PgliteDb(pg);
  }
  return instance;
}

/** In-memory database, used by tests so runs are isolated and fast. */
export async function createEphemeralDb(): Promise<Db> {
  const pg = await PGlite.create();
  return new PgliteDb(pg);
}

export async function setDb(db: Db): Promise<void> {
  instance = db;
}

function migrationsDir(): string {
  return resolve(REPO_ROOT, 'database', 'migrations');
}

export async function runMigrations(db: Db): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    ran.push(file);
  }
  return ran;
}

export function newId(): string {
  return randomUUID();
}
