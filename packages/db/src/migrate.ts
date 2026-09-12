import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getPool } from './connection.js';

export async function runMigrations(migrationsDir?: string): Promise<string[]> {
  const dir = migrationsDir ?? resolve(process.cwd(), 'database/migrations');
  const pool = getPool();
  const client = await pool.connect();

  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const { rows: appliedRows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations;',
    );
    const appliedSet = new Set(appliedRows.map((r) => r.version));

    const files = await readdir(dir);
    const sqlFiles = files
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const newlyApplied: string[] = [];

    for (const file of sqlFiles) {
      if (appliedSet.has(file)) {
        continue;
      }

      const filePath = join(dir, file);
      const sql = await readFile(filePath, 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1);',
          [file],
        );
        await client.query('COMMIT');
        newlyApplied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Failed to apply migration ${file}: ${(err as Error).message}`);
      }
    }

    return newlyApplied;
  } finally {
    client.release();
  }
}
