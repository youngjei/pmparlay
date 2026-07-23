import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({
    connect: async () => ({ query: mocks.query, release: mocks.release })
  })
}));

import { acquireWorkerSingletonLease } from "../workers/singletonLease";

beforeEach(() => {
  mocks.query.mockReset();
  mocks.release.mockReset();
});

describe("financial worker singleton lease", () => {
  it("holds one advisory-lock connection and releases it idempotently", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });

    const release = await acquireWorkerSingletonLease("settlement-worker");
    expect(mocks.release).not.toHaveBeenCalled();

    await release();
    await release();

    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      ["legwork-worker:settlement-worker"]
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
      ["legwork-worker:settlement-worker"]
    );
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed and releases the connection when another process holds the lease", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });

    await expect(acquireWorkerSingletonLease("usdc-deposit-scanner")).rejects.toThrow(
      "worker_already_running:usdc-deposit-scanner"
    );
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
