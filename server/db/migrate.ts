import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "./client";

const currentFile = fileURLToPath(import.meta.url);
const migrationsDir = path.join(path.dirname(currentFile), "migrations");

async function ensureMigrationTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations() {
  const result = await getPool().query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(result.rows.map((row) => row.name));
}

async function applyMigration(name: string) {
  const sql = await readFile(path.join(migrationsDir, name), "utf8");
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    await client.query("COMMIT");
    console.log(`applied ${name}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function migrate() {
  await getPool().query("SELECT pg_advisory_lock(hashtext('legwork_schema_migrations'))");
  try {
    await ensureMigrationTable();
    const applied = await appliedMigrations();
    const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

    for (const migration of migrations) {
      if (!applied.has(migration)) {
        await applyMigration(migration);
      }
    }

    console.log("migrations complete");
  } finally {
    await getPool().query("SELECT pg_advisory_unlock(hashtext('legwork_schema_migrations'))");
  }
}

try {
  await migrate();
} finally {
  await closePool();
}
