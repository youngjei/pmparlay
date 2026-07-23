import pg from "pg";
import { config, DATABASE_APPLICATION_NAME } from "../config";

const { Pool } = pg;

let pool: pg.Pool | undefined;
let poolClosePromise: Promise<void> | undefined;

type DatabasePoolSettings = Pick<
  typeof config,
  "DATABASE_POOL_MAX" | "DATABASE_CONNECTION_TIMEOUT_MS" | "DATABASE_STATEMENT_TIMEOUT_MS"
>;

export function createPoolOptions(connectionString: string, settings: DatabasePoolSettings = config): pg.PoolConfig {
  return {
    connectionString,
    max: settings.DATABASE_POOL_MAX,
    connectionTimeoutMillis: settings.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: settings.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: DATABASE_APPLICATION_NAME
  };
}

export function getPool() {
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for database operations.");
  }

  pool ||= new Pool(createPoolOptions(config.DATABASE_URL));

  return pool;
}

export async function closePool() {
  if (poolClosePromise) return poolClosePromise;
  if (!pool) return;

  const activePool = pool;
  pool = undefined;
  poolClosePromise = activePool.end().finally(() => {
    poolClosePromise = undefined;
  });
  return poolClosePromise;
}

export async function checkDatabase() {
  await getPool().query("SELECT 1");
}
