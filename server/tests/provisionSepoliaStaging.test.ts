import { describe, expect, it } from "vitest";
import {
  assertResetConfirmed,
  assertSafeDatabaseName,
  assertSafeLocalStagingRedisReset,
  databaseUrlForName,
  redisUrlForStaging,
  resetRecoveryProof,
  stagingDepositStartBlock,
  stagingShadowVaultProvisioningInput
} from "../provisionSepoliaStaging";

describe("Sepolia staging provisioning guards", () => {
  it("derives isolated Postgres and Redis targets", () => {
    expect(databaseUrlForName("postgres://user:pass@localhost:5432/legwork?sslmode=require", "legwork_sepolia_staging")).toBe(
      "postgres://user:pass@localhost:5432/legwork_sepolia_staging?sslmode=require"
    );
    expect(redisUrlForStaging("redis://localhost:6379/0")).toBe("redis://localhost:6379/1");
  });

  it("allows Redis reset only for loopback database 1", () => {
    expect(() => assertSafeLocalStagingRedisReset("redis://127.0.0.1:6379/1")).not.toThrow();
    expect(() => assertSafeLocalStagingRedisReset("redis://127.0.0.1:6379/0")).toThrow("unsafe_staging_redis_reset_target");
    expect(() => assertSafeLocalStagingRedisReset("redis://cache.example.com:6379/1")).toThrow(
      "unsafe_staging_redis_reset_target"
    );
  });

  it("rejects unsafe database names and unconfirmed resets", () => {
    expect(() => assertSafeDatabaseName("legwork")).toThrow("unsafe_staging_database_name");
    expect(() => assertSafeDatabaseName("legwork_sepolia_staging")).not.toThrow();
    expect(() => assertResetConfirmed(true, "legwork_sepolia_staging", "wrong")).toThrow(
      "STAGING_RESET_CONFIRM_must_equal_legwork_sepolia_staging"
    );
    expect(() => assertResetConfirmed(true, "legwork_sepolia_staging", "legwork_sepolia_staging")).not.toThrow();
  });

  it("preserves the original scan start unless the database is reset", () => {
    expect(stagingDepositStartBlock({ reset: false, existing: "123", proposed: 999n })).toBe(123n);
    expect(stagingDepositStartBlock({ reset: true, existing: "123", proposed: 999n })).toBe(999n);
    expect(stagingDepositStartBlock({ reset: false, existing: "invalid", proposed: 999n })).toBe(999n);
  });

  it("binds a reset attestation to the exact database and archive digest", () => {
    expect(resetRecoveryProof("legwork_sepolia_staging", "abc123")).toBe(
      "legwork_sepolia_staging:abc123\n"
    );
  });

  it("pins shadow-vault provisioning to the configured Safe and Circle Sepolia USDC", () => {
    expect(stagingShadowVaultProvisioningInput("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")).toEqual({
      treasuryAddress: "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD",
      tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
    });
  });
});
