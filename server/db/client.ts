import pg from "pg";
import { config } from "../config";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool() {
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for database operations.");
  }

  pool ||= new Pool({
    connectionString: config.DATABASE_URL
  });

  return pool;
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export async function checkDatabase() {
  await getPool().query("SELECT 1");
}
