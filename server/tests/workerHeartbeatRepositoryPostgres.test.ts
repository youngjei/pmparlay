import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl ? describe : describe.skip;
const schema = `worker_health_test_${process.pid}_${randomBytes(5).toString("hex")}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
let admin: pg.Client;
let repository: typeof import("../db/workerHeartbeatRepository");
let closePool: typeof import("../db/client").closePool;

function schemaConnectionString(connectionString: string) {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

describeWithPostgres("worker heartbeat PostgreSQL integration", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}", public`);

    const migrationsDir = path.resolve("server/db/migrations");
    for (const migration of ["0032_worker_runtime_heartbeats.sql", "0035_worker_runtime_success_health.sql"]) {
      await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    await admin.query(
      `INSERT INTO worker_runtime_heartbeats (worker_name, heartbeat_at, process_id)
       VALUES ($1, now(), 7)`,
      [`legacy-${"x".repeat(180)}`]
    );
    await admin.query(await readFile(path.join(migrationsDir, "0037_worker_runtime_instance_id.sql"), "utf8"));
    await admin.query(await readFile(path.join(migrationsDir, "0038_worker_runtime_instance_generation.sql"), "utf8"));

    const legacy = await admin.query<{ instance_id: string; instance_generation: string }>(
      "SELECT instance_id, instance_generation::text FROM worker_runtime_heartbeats WHERE process_id = 7"
    );
    expect(legacy.rows[0]?.instance_id.length).toBeLessThanOrEqual(128);
    expect(BigInt(legacy.rows[0]?.instance_generation || "0")).toBeGreaterThan(0n);

    process.env.DATABASE_URL = schemaConnectionString(testDatabaseUrl!);
    process.env.NODE_ENV = "test";
    vi.resetModules();
    repository = await import("../db/workerHeartbeatRepository");
    ({ closePool } = await import("../db/client"));
  }, 30_000);

  afterAll(async () => {
    await closePool?.();
    if (admin) {
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }, 30_000);

  it("requires a fresh successful cycle when a restarted container reuses its PID", async () => {
    const firstSuccess = new Date("2026-07-14T00:00:00.000Z");
    const restartedAt = new Date("2026-07-14T00:00:10.000Z");

    await repository.markWorkerSuccess("settlement-worker", {
      now: firstSuccess,
      processId: 1,
      instanceId: "first-container-boot",
      instanceGeneration: 100
    });
    await repository.recordWorkerHeartbeat("settlement-worker", {
      now: restartedAt,
      processId: 1,
      instanceId: "second-container-boot",
      instanceGeneration: 101
    });
    await repository.markWorkerSuccess("settlement-worker", {
      now: new Date("2026-07-14T00:00:20.000Z"),
      processId: 1,
      instanceId: "first-container-boot",
      instanceGeneration: 100
    });

    const beforeNewSuccess = await repository.getWorkerHeartbeatHealth(["settlement-worker"], {
      now: restartedAt,
      maxAgeMs: 45_000,
      successMaxAgeMs: 180_000
    });
    expect(beforeNewSuccess).toMatchObject({
      healthy: false,
      workers: [{ name: "settlement-worker", status: "stale" }]
    });

    await repository.markWorkerSuccess("settlement-worker", {
      now: restartedAt,
      processId: 1,
      instanceId: "second-container-boot",
      instanceGeneration: 101
    });
    const afterNewSuccess = await repository.getWorkerHeartbeatHealth(["settlement-worker"], {
      now: restartedAt,
      maxAgeMs: 45_000,
      successMaxAgeMs: 180_000
    });
    expect(afterNewSuccess).toMatchObject({
      healthy: true,
      workers: [{ name: "settlement-worker", status: "healthy", successAgeMs: 0 }]
    });
  });
});
