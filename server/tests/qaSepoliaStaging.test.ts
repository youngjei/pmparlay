import { describe, expect, it } from "vitest";
import { assertIsolatedStagingTargets, assertMigrationManifest } from "../qaSepoliaStaging";

describe("Sepolia staging runtime target guard", () => {
  it("accepts only the dedicated database and loopback Redis database 1", () => {
    expect(() =>
      assertIsolatedStagingTargets(
        "postgres://legwork:pass@127.0.0.1:5432/legwork_sepolia_staging?sslmode=disable",
        "redis://127.0.0.1:6379/1"
      )
    ).not.toThrow();
    expect(() => assertIsolatedStagingTargets("postgres://localhost/legwork", "redis://127.0.0.1:6379/1")).toThrow(
      "staging_database_target_mismatch"
    );
    expect(() =>
      assertIsolatedStagingTargets("postgres://localhost/legwork_sepolia_staging", "redis://127.0.0.1:6379/0")
    ).toThrow("staging_redis_target_mismatch");
  });

  it("rejects missing, reordered, or changed migration content", () => {
    const current = [
      { name: "0001.sql", checksum: "aaa" },
      { name: "0002.sql", checksum: "bbb" }
    ];
    expect(() => assertMigrationManifest(current, current)).not.toThrow();
    expect(() => assertMigrationManifest(current.slice(0, 1), current)).toThrow("staging_migration_count_mismatch");
    expect(() => assertMigrationManifest([...current].reverse(), current)).toThrow("staging_migration_name_mismatch");
    expect(() => assertMigrationManifest([{ name: "0001.sql", checksum: "changed" }, current[1]], current)).toThrow(
      "staging_migration_checksum_mismatch:0001.sql"
    );
  });
});
