import 'server-only';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * db.ts - the only place in the platform that opens a database connection.
 *
 * SERVER ONLY. The `server-only` import above turns an accidental client import into a build
 * error rather than a shipped connection string. Do not remove it, and do not re-export anything
 * from this module through a file that a client component imports.
 *
 * Direct `pg`, deliberately. A REST-over-Postgres layer is what produced the URL-length row cap,
 * the schema-cache staleness and the silent 1000-row truncation catalogued in docs/16_TRAPS.md.
 * Here a query is a query, and a long IN list is a parameter array rather than a URL.
 *
 * ENVIRONMENT VARIABLE NAMES COME FROM .env.example AND NOWHERE ELSE. That file, the compose files
 * and this module read the same three names - DB_POOL_MAX, DB_STATEMENT_TIMEOUT_MS,
 * DB_SLOW_QUERY_MS. An earlier revision of this file read DATABASE_* variants that appeared in no
 * .env and in no compose file, so every setting silently fell back to its literal default and the
 * pool was never actually tuned by anything an operator wrote down.
 */

declare global {
  // eslint-disable-next-line no-var
  var __tmsPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. See .env.example; values are never committed.');
  }
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Interactive queries must stay under two seconds. Anything longer belongs in a scheduled job
    // that writes a cache the request path reads. This is a backstop, not a budget.
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 8_000),
  });
  pool.on('error', (err) => {
    console.error('[db] idle client error', err);
  });
  return pool;
}

// One pool per process. In development the module graph is re-evaluated on every change, so the
// pool is parked on globalThis; without this a long session exhausts the server's connections.
export const pool: Pool = global.__tmsPool ?? createPool();
if (process.env.NODE_ENV !== 'production') global.__tmsPool = pool;

export type Sql = string;
export type Params = ReadonlyArray<unknown>;

/** Rows of a query, typed by the caller. The caller owns the row type; this module never guesses. */
export async function query<T extends QueryResultRow>(
  sql: Sql,
  params: Params = [],
): Promise<T[]> {
  const started = Date.now();
  try {
    const res = await pool.query<T>(sql, params as unknown[]);
    return res.rows;
  } finally {
    const ms = Date.now() - started;
    if (ms > Number(process.env.DB_SLOW_QUERY_MS ?? 1_000)) {
      console.warn(`[db] slow query ${ms}ms: ${sql.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
  }
}

/** Exactly one row, or null. Throws when the query returns more than one - a silent extra row is a bug. */
export async function queryOne<T extends QueryResultRow>(
  sql: Sql,
  params: Params = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  if (rows.length > 1) {
    throw new Error(`queryOne expected at most 1 row, received ${rows.length}`);
  }
  return rows[0] ?? null;
}

/** A single scalar. Returns null when there is no row. */
export async function queryValue<V>(sql: Sql, params: Params = []): Promise<V | null> {
  const row = await queryOne<QueryResultRow>(sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return (row[keys[0]] ?? null) as V | null;
}

/**
 * Runs `fn` inside a transaction and releases the client whatever happens.
 * Every multi-statement write goes through here. A write path that half-succeeds and stays silent
 * is the failure mode that costs the most to diagnose later: fail loud, roll back.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Health probe for the deployment check. Returns false rather than throwing. */
export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
