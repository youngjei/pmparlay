import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../db/client", () => ({
  getPool: () => ({ query })
}));

import {
  getWorkerHeartbeatHealth,
  markWorkerFailure,
  markWorkerSuccess,
  recordWorkerHeartbeat,
  sanitizeWorkerFailure
} from "../db/workerHeartbeatRepository";

beforeEach(() => {
  query.mockReset();
});

describe("worker runtime heartbeats", () => {
  it("records a validated worker heartbeat with process metadata", async () => {
    query.mockResolvedValue({ rows: [] });
    const now = new Date("2026-07-14T00:00:00.000Z");

    await recordWorkerHeartbeat("market-worker", {
      now,
      processId: 42,
      instanceId: "instance-a",
      instanceGeneration: 101,
      metadata: { generation: 7 }
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (worker_name)"), [
      "market-worker",
      now.toISOString(),
      42,
      "instance-a",
      "101",
      { generation: 7 }
    ]);
    expect(query.mock.calls[0][0]).toContain(
      "worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation"
    );
  });

  it("reports healthy, stale, and missing workers deterministically", async () => {
    query.mockResolvedValue({
      rows: [
        {
          worker_name: "deposit-worker",
          heartbeat_at: new Date("2026-07-14T00:00:20.000Z"),
          last_success_at: new Date("2026-07-14T00:00:20.000Z"),
          last_failure_at: null,
          latest_failure: null
        },
        {
          worker_name: "settlement-worker",
          heartbeat_at: new Date("2026-07-13T23:59:00.000Z"),
          last_success_at: new Date("2026-07-13T23:59:00.000Z"),
          last_failure_at: null,
          latest_failure: null
        }
      ]
    });

    const result = await getWorkerHeartbeatHealth(["deposit-worker", "settlement-worker", "missing-worker"], {
      now: new Date("2026-07-14T00:00:30.000Z"),
      maxAgeMs: 45_000
    });

    expect(result.healthy).toBe(false);
    expect(result.workers).toEqual([
      expect.objectContaining({ name: "deposit-worker", status: "healthy", ageMs: 10_000 }),
      expect.objectContaining({ name: "settlement-worker", status: "stale", ageMs: 90_000 }),
      { name: "missing-worker", status: "missing" }
    ]);
  });

  it("requires a fresh successful cycle and rejects a newer failure", async () => {
    query.mockResolvedValue({
      rows: [
        {
          worker_name: "startup-worker",
          heartbeat_at: new Date("2026-07-14T00:00:25.000Z"),
          last_success_at: null,
          last_failure_at: null,
          latest_failure: null
        },
        {
          worker_name: "failed-worker",
          heartbeat_at: new Date("2026-07-14T00:00:25.000Z"),
          last_success_at: new Date("2026-07-14T00:00:10.000Z"),
          last_failure_at: new Date("2026-07-14T00:00:20.000Z"),
          latest_failure: "rpc_timeout"
        },
        {
          worker_name: "recovered-worker",
          heartbeat_at: new Date("2026-07-14T00:00:25.000Z"),
          last_success_at: new Date("2026-07-14T00:00:22.000Z"),
          last_failure_at: new Date("2026-07-14T00:00:20.000Z"),
          latest_failure: "rpc_timeout"
        }
      ]
    });

    const result = await getWorkerHeartbeatHealth(["startup-worker", "failed-worker", "recovered-worker"], {
      now: new Date("2026-07-14T00:00:30.000Z"),
      maxAgeMs: 45_000
    });

    expect(result.healthy).toBe(false);
    expect(result.workers).toEqual([
      expect.objectContaining({ name: "startup-worker", status: "stale", ageMs: 5_000 }),
      expect.objectContaining({ name: "failed-worker", status: "failed", latestFailure: "rpc_timeout" }),
      expect.objectContaining({ name: "recovered-worker", status: "healthy", successAgeMs: 8_000 })
    ]);
  });

  it("keeps process liveness strict while allowing slower successful work cycles", async () => {
    query.mockResolvedValue({
      rows: [
        {
          worker_name: "financial-reconciliation",
          heartbeat_at: new Date("2026-07-14T00:00:25.000Z"),
          last_success_at: new Date("2026-07-13T23:59:30.000Z"),
          last_failure_at: null,
          latest_failure: null
        }
      ]
    });

    const result = await getWorkerHeartbeatHealth(["financial-reconciliation"], {
      now: new Date("2026-07-14T00:00:30.000Z"),
      maxAgeMs: 45_000,
      successMaxAgeMs: 90_000
    });

    expect(result).toMatchObject({
      healthy: true,
      maxAgeMs: 45_000,
      successMaxAgeMs: 90_000,
      workers: [{ name: "financial-reconciliation", status: "healthy", ageMs: 5_000, successAgeMs: 60_000 }]
    });
  });

  it("resets prior process-instance state even when a container reuses the same PID", async () => {
    const now = new Date("2026-07-14T00:00:30.000Z");
    query.mockResolvedValue({ rows: [] });

    await recordWorkerHeartbeat("market-worker", {
      now,
      processId: 99,
      instanceId: "restarted-instance",
      instanceGeneration: 102
    });
    expect(query.mock.calls[0][0]).toContain("last_success_at = CASE");
    expect(query.mock.calls[0][0]).toContain(
      "worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation"
    );

    query.mockResolvedValue({
      rows: [
        {
          worker_name: "market-worker",
          heartbeat_at: now,
          last_success_at: null,
          last_failure_at: null,
          latest_failure: null
        }
      ]
    });
    const beforeSuccess = await getWorkerHeartbeatHealth(["market-worker"], { now, maxAgeMs: 45_000 });
    expect(beforeSuccess).toMatchObject({ healthy: false, workers: [{ name: "market-worker", status: "stale" }] });

    query.mockResolvedValue({ rows: [] });
    await markWorkerSuccess("market-worker", {
      now,
      processId: 99,
      instanceId: "restarted-instance",
      instanceGeneration: 102
    });

    query.mockResolvedValue({
      rows: [
        {
          worker_name: "market-worker",
          heartbeat_at: now,
          last_success_at: now,
          last_failure_at: null,
          latest_failure: null
        }
      ]
    });
    const afterSuccess = await getWorkerHeartbeatHealth(["market-worker"], { now, maxAgeMs: 45_000 });
    expect(afterSuccess).toMatchObject({ healthy: true, workers: [{ name: "market-worker", status: "healthy" }] });
  });

  it("records ordered success and sanitized failure state", async () => {
    query.mockResolvedValue({ rows: [] });
    const now = new Date("2026-07-14T00:00:00.000Z");

    await markWorkerSuccess("settlement-worker", {
      now,
      processId: 42,
      instanceId: "instance-a",
      instanceGeneration: 101
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("last_success_at"), [
      "settlement-worker",
      now.toISOString(),
      42,
      "instance-a",
      "101"
    ]);

    await markWorkerFailure("settlement-worker", "authorization=top-secret\nfailed", {
      now,
      processId: 42,
      instanceId: "instance-a",
      instanceGeneration: 101
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("last_failure_at"), [
      "settlement-worker",
      now.toISOString(),
      "authorization=[redacted] failed",
      42,
      "instance-a",
      "101"
    ]);
    expect(sanitizeWorkerFailure("token: secret-value")).toBe("token:[redacted]");
    expect(sanitizeWorkerFailure("authorization: Bearer secret-value")).toBe("authorization:[redacted]");
    expect(sanitizeWorkerFailure("rpc failed at https://user:pass@example.test/path?api_key=secret")).toBe(
      "rpc failed at [url]"
    );
  });

  it("retries process-generation allocation after a transient database failure", async () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    query
      .mockRejectedValueOnce(new Error("database_unavailable"))
      .mockResolvedValueOnce({ rows: [{ generation: "501" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(recordWorkerHeartbeat("market-worker", { now })).rejects.toThrow("database_unavailable");
    await recordWorkerHeartbeat("market-worker", { now });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toContain("nextval('worker_runtime_instance_generation_seq')");
    expect(query.mock.calls[2][1][4]).toBe("501");
  });
});
