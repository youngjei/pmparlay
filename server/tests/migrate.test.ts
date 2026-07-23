import { describe, expect, it } from "vitest";
import { assertMigrationChecksum, migrationChecksum } from "../db/migrate";

describe("migration integrity", () => {
  it("produces a stable SHA-256 checksum and detects content changes", () => {
    const original = migrationChecksum("SELECT 1;\n");

    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(migrationChecksum("SELECT 1;\n")).toBe(original);
    expect(migrationChecksum("SELECT 2;\n")).not.toBe(original);
  });

  it("fails closed when an applied migration no longer matches its recorded checksum", () => {
    expect(() => assertMigrationChecksum("0001_example.sql", "recorded", "recorded")).not.toThrow();
    expect(() => assertMigrationChecksum("0001_example.sql", "recorded", "changed")).toThrow(
      "migration_checksum_mismatch:0001_example.sql"
    );
  });
});
