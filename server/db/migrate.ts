import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { closePool, getPool } from "./client";

const currentFile = fileURLToPath(import.meta.url);
const migrationsDir = path.join(path.dirname(currentFile), "migrations");

async function ensureMigrationTable(client: pg.PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
}

async function appliedMigrations(client: pg.PoolClient) {
  const result = await client.query<{ name: string; checksum: string | null }>(
    "SELECT name, checksum FROM schema_migrations"
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

export function migrationChecksum(sql: string) {
  return createHash("sha256").update(sql).digest("hex");
}

export function assertMigrationChecksum(name: string, recordedChecksum: string, currentChecksum: string) {
  if (recordedChecksum !== currentChecksum) throw new Error(`migration_checksum_mismatch:${name}`);
}

async function applyMigration(client: pg.PoolClient, name: string, sql: string, checksum: string) {

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('statement_timeout', '5min', true), set_config('lock_timeout', '5s', true)");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
    await client.query("COMMIT");
    console.log(`applied ${name}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrate() {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('legwork_schema_migrations'))");
    await ensureMigrationTable(client);
    const applied = await appliedMigrations(client);
    const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

    for (const migration of migrations) {
      const sql = await readFile(path.join(migrationsDir, migration), "utf8");
      const checksum = migrationChecksum(sql);
      if (!applied.has(migration)) {
        await applyMigration(client, migration, sql, checksum);
        continue;
      }

      const recordedChecksum = applied.get(migration);
      if (!recordedChecksum) {
        await client.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL", [
          migration,
          checksum
        ]);
      } else {
        assertMigrationChecksum(migration, recordedChecksum, checksum);
      }
    }

    console.log("migrations complete");
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('legwork_schema_migrations'))").catch(() => undefined);
    client.release();
  }
}

if (currentFile === path.resolve(process.argv[1] || "")) {
  try {
    await migrate();
  } finally {
    await closePool();
  }
}
