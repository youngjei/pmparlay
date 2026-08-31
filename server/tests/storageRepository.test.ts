import { afterEach, describe, expect, it } from "vitest";
import {
  assertMarketIndexStorageHeadroom,
  MarketIndexStorageLimitError,
  marketIndexDatabaseSoftLimitBytesFromEnv
} from "../db/storageRepository";

const originalSoftLimit = process.env.MARKET_INDEX_DB_SOFT_LIMIT_BYTES;

afterEach(() => {
  if (originalSoftLimit === undefined) delete process.env.MARKET_INDEX_DB_SOFT_LIMIT_BYTES;
  else process.env.MARKET_INDEX_DB_SOFT_LIMIT_BYTES = originalSoftLimit;
});

describe("market index database storage guard", () => {
  it("accepts only positive safe integer limits", () => {
    expect(marketIndexDatabaseSoftLimitBytesFromEnv("350000000")).toBe(350_000_000);
    expect(() => marketIndexDatabaseSoftLimitBytesFromEnv(undefined, "production")).toThrow(
      "market_index_db_soft_limit_required"
    );
    expect(() => marketIndexDatabaseSoftLimitBytesFromEnv("0")).toThrow("market_index_db_soft_limit_invalid");
    expect(() => marketIndexDatabaseSoftLimitBytesFromEnv("not-a-number")).toThrow("market_index_db_soft_limit_invalid");
  });

  it("returns remaining headroom below the configured limit", async () => {
    process.env.MARKET_INDEX_DB_SOFT_LIMIT_BYTES = "350000000";
    const usage = await assertMarketIndexStorageHeadroom(async () => ({
      rows: [{ used_bytes: "125000000", database_bytes: "75000000", wal_bytes: "50000000" }]
    }));

    expect(usage).toEqual({
      usedBytes: 125_000_000,
      databaseBytes: 75_000_000,
      walBytes: 50_000_000,
      softLimitBytes: 350_000_000,
      remainingBytes: 225_000_000
    });
  });

  it("fails closed at or above the configured limit", async () => {
    process.env.MARKET_INDEX_DB_SOFT_LIMIT_BYTES = "350000000";
    const blocked = assertMarketIndexStorageHeadroom(async () => ({
      rows: [{ used_bytes: "350000000", database_bytes: "254000000", wal_bytes: "96000000" }]
    }));

    await expect(blocked).rejects.toBeInstanceOf(MarketIndexStorageLimitError);
    await expect(blocked).rejects.toThrow("market_index_storage_soft_limit_exceeded:350000000:350000000");
  });
});
