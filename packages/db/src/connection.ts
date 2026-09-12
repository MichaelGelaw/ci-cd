import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString =
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@localhost:5432/mini_ci';

    const max = Number(process.env['DB_POOL_MAX'] ?? 25);
    const idleTimeoutMillis = Number(process.env['DB_IDLE_TIMEOUT_MS'] ?? 30000);
    const connectionTimeoutMillis = Number(process.env['DB_CONNECTION_TIMEOUT_MS'] ?? 5000);

    pool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const currentPool = getPool();
  return currentPool.query<T>(text, params);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
