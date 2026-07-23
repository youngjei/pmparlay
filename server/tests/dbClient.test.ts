import { describe, expect, it } from "vitest";
import { DATABASE_APPLICATION_NAME } from "../config";
import { createPoolOptions } from "../db/client";

describe("Postgres pool options", () => {
  it("uses bounded, staged defaults without creating a connection", () => {
    expect(
      createPoolOptions("postgres://legwork:test-password@localhost:5432/legwork", {
        DATABASE_POOL_MAX: 4,
        DATABASE_CONNECTION_TIMEOUT_MS: 4_000,
        DATABASE_STATEMENT_TIMEOUT_MS: 12_000
      })
    ).toMatchObject({
      max: 4,
      connectionTimeoutMillis: 4_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 12_000,
      application_name: DATABASE_APPLICATION_NAME
    });
  });
});
