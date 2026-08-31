import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
  upsertJobScheduler: vi.fn(),
  queueClose: vi.fn(),
  workerConstructor: vi.fn(),
  workerClose: vi.fn(),
  fetchCatalog: vi.fn(),
  persistCatalog: vi.fn(),
  getSweepState: vi.fn(),
  resetInvalidCursor: vi.fn(),
  assertStorageHeadroom: vi.fn(),
  markWorkerSuccess: vi.fn(),
  markWorkerFailure: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add(...args: unknown[]) {
      return mocks.add(...args);
    }

    getJob(...args: unknown[]) {
      return mocks.getJob(...args);
    }

    upsertJobScheduler(...args: unknown[]) {
      return mocks.upsertJobScheduler(...args);
    }

    close() {
      return mocks.queueClose();
    }
  },
  Worker: class {
    close = mocks.workerClose;

    constructor(...args: unknown[]) {
      mocks.workerConstructor(...args);
    }
  }
}));

vi.mock("../queues/connection", () => ({ redisConnectionOptions: () => ({}) }));
vi.mock("../db/client", () => ({ closePool: vi.fn() }));
vi.mock("../db/marketRepository", () => ({
  getMarketCatalogSweepState: mocks.getSweepState,
  persistMarketCatalog: mocks.persistCatalog,
  resetMarketCatalogSweepAfterInvalidCursor: mocks.resetInvalidCursor
}));
vi.mock("../db/storageRepository", () => ({ assertMarketIndexStorageHeadroom: mocks.assertStorageHeadroom }));
vi.mock("../marketCatalog", () => ({ fetchLiveMarketCatalog: mocks.fetchCatalog }));
vi.mock("../workers/heartbeat", () => ({ startWorkerHeartbeat: () => vi.fn() }));
vi.mock("../db/workerHeartbeatRepository", () => ({
  markWorkerSuccess: mocks.markWorkerSuccess,
  markWorkerFailure: mocks.markWorkerFailure
}));

import {
  enqueueMarketIndexJob,
  indexMarketCatalogOnce,
  processMarketIndexCycle,
  scheduleMarketIndexJobs,
  startMarketIndexerWorker
} from "../workers/marketIndexerWorker";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getJob.mockResolvedValue(undefined);
  mocks.add.mockResolvedValue({ id: "market-indexer-polymarket" });
  mocks.upsertJobScheduler.mockResolvedValue({ id: "scheduler-trigger" });
  mocks.assertStorageHeadroom.mockResolvedValue({ usedBytes: 1 });
});

describe("market indexer job deduplication", () => {
  it("uses the stable singleton job id for direct enqueue", async () => {
    await enqueueMarketIndexJob();

    expect(mocks.add).toHaveBeenCalledWith(
      "index-polymarket",
      {},
      expect.objectContaining({ jobId: "market-indexer-polymarket" })
    );
    expect(mocks.add.mock.calls[0][2].jobId).not.toContain(":");
  });

  it("routes repeat scheduler triggers through the same singleton enqueue", async () => {
    await scheduleMarketIndexJobs(30_000);
    startMarketIndexerWorker();

    expect(mocks.upsertJobScheduler).toHaveBeenCalledWith(
      "market-indexer-polymarket-scheduler",
      { every: 30_000 },
      expect.objectContaining({ name: "schedule-polymarket" })
    );

    const processor = mocks.workerConstructor.mock.calls[0][1] as (job: { name: string }) => Promise<unknown>;
    expect(mocks.workerConstructor.mock.calls[0][2]).toEqual(
      expect.objectContaining({ concurrency: 1, lockDuration: 150_000 })
    );
    await processor({ name: "schedule-polymarket" });

    expect(mocks.add).toHaveBeenCalledWith(
      "index-polymarket",
      {},
      expect.objectContaining({ jobId: "market-indexer-polymarket" })
    );
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });

  it("carries the durable generation version into the fetched continuation page", async () => {
    const catalog = { asOf: "2026-07-13T00:00:00.000Z", source: "polymarket", outcomes: [] };
    mocks.getSweepState.mockResolvedValue({ nextCursor: "cursor-two", generationVersion: 7 });
    mocks.fetchCatalog.mockResolvedValue(catalog);
    mocks.persistCatalog.mockResolvedValue({ markets: 0 });

    await indexMarketCatalogOnce();

    expect(mocks.fetchCatalog).toHaveBeenCalledWith(
      0,
      expect.any(AbortSignal),
      expect.objectContaining({
        purpose: "index",
        afterCursor: "cursor-two",
        expectedGenerationVersion: 7,
        maxPages: 1
      })
    );
    expect(mocks.persistCatalog).toHaveBeenCalledWith(catalog, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(mocks.assertStorageHeadroom).toHaveBeenCalledTimes(2);
  });

  it("does not call Polymarket when database storage has reached its soft limit", async () => {
    mocks.assertStorageHeadroom.mockRejectedValue(new Error("market_index_storage_soft_limit_exceeded:350000000:350000000"));

    await expect(indexMarketCatalogOnce()).rejects.toThrow("market_index_storage_soft_limit_exceeded");

    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
    expect(mocks.persistCatalog).not.toHaveBeenCalled();
  });

  it("resets an expired durable cursor and retries from the first page", async () => {
    const invalidCursor = Object.assign(new Error("Polymarket responded with 422: invalid cursor"), {
      name: "PolymarketApiError",
      status: 422,
      detail: "invalid cursor"
    });
    Object.setPrototypeOf(invalidCursor, (await import("../../src/marketData")).PolymarketApiError.prototype);
    const catalog = { asOf: "2026-07-21T00:00:00.000Z", source: "polymarket", outcomes: [] };
    mocks.getSweepState.mockResolvedValue({ nextCursor: "expired-cursor", generationVersion: 7 });
    mocks.fetchCatalog.mockRejectedValueOnce(invalidCursor).mockResolvedValueOnce(catalog);
    mocks.resetInvalidCursor.mockResolvedValue(8);
    mocks.persistCatalog.mockResolvedValue({ markets: 0 });

    await indexMarketCatalogOnce();

    expect(mocks.resetInvalidCursor).toHaveBeenCalledWith({
      expectedGenerationVersion: 7,
      expectedCursor: "expired-cursor"
    });
    expect(mocks.fetchCatalog).toHaveBeenNthCalledWith(
      2,
      0,
      expect.any(AbortSignal),
      expect.objectContaining({ afterCursor: undefined, expectedGenerationVersion: 8 })
    );
    expect(mocks.persistCatalog).toHaveBeenCalledWith(catalog, expect.any(Object));
  });

  it("aborts a hung index fetch at the overall job deadline without persisting", async () => {
    vi.useFakeTimers();
    const previousTimeout = process.env.MARKET_INDEX_JOB_TIMEOUT_MS;
    process.env.MARKET_INDEX_JOB_TIMEOUT_MS = "25";
    mocks.getSweepState.mockResolvedValue(undefined);
    mocks.fetchCatalog.mockImplementation((_ttl, signal: AbortSignal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    try {
      const indexing = indexMarketCatalogOnce();
      const rejection = expect(indexing).rejects.toThrow("market_index_job_timeout:25");
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(mocks.persistCatalog).not.toHaveBeenCalled();
      expect((mocks.fetchCatalog.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    } finally {
      if (previousTimeout === undefined) delete process.env.MARKET_INDEX_JOB_TIMEOUT_MS;
      else process.env.MARKET_INDEX_JOB_TIMEOUT_MS = previousTimeout;
      vi.useRealTimers();
    }
  });

  it("marks catalog indexing errors as worker failures", async () => {
    const error = new Error("catalog_unavailable");
    mocks.getSweepState.mockResolvedValue(undefined);
    mocks.fetchCatalog.mockRejectedValue(error);
    mocks.markWorkerFailure.mockResolvedValue(undefined);

    await expect(processMarketIndexCycle()).rejects.toThrow("catalog_unavailable");
    expect(mocks.markWorkerFailure).toHaveBeenCalledWith("market-worker", error);
    expect(mocks.markWorkerSuccess).not.toHaveBeenCalled();
  });
});
