import { getPool } from "./client";

export type DatabaseStorageUsage = {
  usedBytes: number;
  databaseBytes: number;
  walBytes: number;
  softLimitBytes?: number;
  remainingBytes?: number;
};

type StorageRow = {
  used_bytes: string;
  database_bytes: string;
  wal_bytes: string;
};

type StorageQuery = (sql: string) => Promise<{ rows: StorageRow[] }>;

export class MarketIndexStorageLimitError extends Error {
  readonly usage: DatabaseStorageUsage;

  constructor(usage: DatabaseStorageUsage) {
    super(`market_index_storage_soft_limit_exceeded:${usage.usedBytes}:${usage.softLimitBytes}`);
    this.name = "MarketIndexStorageLimitError";
    this.usage = usage;
  }
}

export function marketIndexDatabaseSoftLimitBytesFromEnv(
  value = process.env.MARKET_INDEX_DB_SOFT_LIMIT_BYTES,
  nodeEnv = process.env.NODE_ENV
) {
  if (!value?.trim()) {
    if (nodeEnv === "production") throw new Error("market_index_db_soft_limit_required");
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("market_index_db_soft_limit_invalid");
  return parsed;
}

export async function getDatabaseStorageUsage(
  query: StorageQuery = (sql: string) => getPool().query<StorageRow>(sql)
): Promise<DatabaseStorageUsage> {
  const result = await query(`
    WITH database_storage AS (
      SELECT COALESCE(sum(pg_database_size(datname)), 0)::bigint AS bytes
      FROM pg_database
    ), wal_storage AS (
      SELECT COALESCE(sum(size), 0)::bigint AS bytes
      FROM pg_ls_waldir()
    )
    SELECT
      (database_storage.bytes + wal_storage.bytes)::text AS used_bytes,
      database_storage.bytes::text AS database_bytes,
      wal_storage.bytes::text AS wal_bytes
    FROM database_storage
    CROSS JOIN wal_storage
  `);
  const usedBytes = Number(result.rows[0]?.used_bytes);
  const databaseBytes = Number(result.rows[0]?.database_bytes);
  const walBytes = Number(result.rows[0]?.wal_bytes);
  if (
    !Number.isSafeInteger(usedBytes) ||
    usedBytes < 0 ||
    !Number.isSafeInteger(databaseBytes) ||
    databaseBytes < 0 ||
    !Number.isSafeInteger(walBytes) ||
    walBytes < 0
  ) {
    throw new Error("database_storage_usage_invalid");
  }

  const softLimitBytes = marketIndexDatabaseSoftLimitBytesFromEnv();
  return {
    usedBytes,
    databaseBytes,
    walBytes,
    softLimitBytes,
    remainingBytes: softLimitBytes === undefined ? undefined : Math.max(softLimitBytes - usedBytes, 0)
  };
}

export async function assertMarketIndexStorageHeadroom(
  query?: StorageQuery
) {
  const usage = await getDatabaseStorageUsage(query);
  if (usage.softLimitBytes !== undefined && usage.usedBytes >= usage.softLimitBytes) {
    throw new MarketIndexStorageLimitError(usage);
  }
  return usage;
}
