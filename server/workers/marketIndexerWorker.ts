import { Queue, Worker } from "bullmq";
import { closePool } from "../db/client";
import {
  getMarketCatalogSweepState,
  persistMarketCatalog,
  resetMarketCatalogSweepAfterInvalidCursor
} from "../db/marketRepository";
import { markWorkerFailure, markWorkerSuccess } from "../db/workerHeartbeatRepository";
import { fetchLiveMarketCatalog } from "../marketCatalog";
import { isPolymarketInvalidCursorError } from "../../src/marketData";
import { redisConnectionOptions } from "../queues/connection";
import { startWorkerHeartbeat } from "./heartbeat";
import { acquireWorkerSingletonLease } from "./singletonLease";

const queueName = "market-indexer";
const jobName = "index-polymarket";
const schedulerJobName = "schedule-polymarket";
const singletonJobId = "market-indexer-polymarket";
const schedulerId = "market-indexer-polymarket-scheduler";
const connection = redisConnectionOptions();

export const marketIndexerQueue = new Queue(queueName, { connection });

function marketIndexIntervalMs() {
  const parsed = Number(process.env.MARKET_INDEX_INTERVAL_MS || 60_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60_000;
}

function marketIndexMaxPages() {
  const parsed = Number(process.env.MARKET_INDEX_MAX_PAGES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function marketIndexJobTimeoutMs() {
  const parsed = Number(process.env.MARKET_INDEX_JOB_TIMEOUT_MS || 120_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120_000;
}

async function removeTerminalSingletonJob() {
  const existing = await marketIndexerQueue.getJob(singletonJobId);
  if (!existing) return undefined;

  const state = await existing.getState();
  if (state === "completed" || state === "failed") {
    await existing.remove().catch(() => undefined);
    return undefined;
  }

  return existing;
}

export async function enqueueMarketIndexJob() {
  const existing = await removeTerminalSingletonJob();
  if (existing) return existing;

  return marketIndexerQueue.add(
    jobName,
    {},
    {
      jobId: singletonJobId,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5_000
      },
      removeOnComplete: 10,
      removeOnFail: 50
    }
  );
}

export async function scheduleMarketIndexJobs(intervalMs = marketIndexIntervalMs()) {
  return marketIndexerQueue.upsertJobScheduler(
    schedulerId,
    {
      every: intervalMs
    },
    {
      name: schedulerJobName,
      data: {},
      opts: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5_000
        },
        removeOnComplete: 10,
        removeOnFail: 50
      }
    }
  );
}

export async function indexMarketCatalogOnce(
  dependencies: {
    fetchCatalog?: typeof fetchLiveMarketCatalog;
    persistCatalog?: typeof persistMarketCatalog;
    getSweepState?: typeof getMarketCatalogSweepState;
    resetInvalidCursor?: typeof resetMarketCatalogSweepAfterInvalidCursor;
  } = {}
) {
  const fetchCatalog = dependencies.fetchCatalog || fetchLiveMarketCatalog;
  const persistCatalog = dependencies.persistCatalog || persistMarketCatalog;
  const getSweepState = dependencies.getSweepState || getMarketCatalogSweepState;
  const resetInvalidCursor = dependencies.resetInvalidCursor || resetMarketCatalogSweepAfterInvalidCursor;
  const controller = new AbortController();
  const timeoutMs = marketIndexJobTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`market_index_job_timeout:${timeoutMs}`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const work = (async () => {
    const sweepState = await getSweepState().catch(() => undefined);
    const afterCursor = process.env.MARKET_INDEX_AFTER_CURSOR || sweepState?.nextCursor;
    const fetchPage = (cursor: string | undefined, expectedGenerationVersion: number) =>
      fetchCatalog(0, controller.signal, {
        purpose: "index",
        afterCursor: cursor,
        maxPages: marketIndexMaxPages(),
        expectedGenerationVersion
      });

    let catalog;
    try {
      catalog = await fetchPage(afterCursor, sweepState?.generationVersion ?? 0);
    } catch (error) {
      if (!afterCursor || !sweepState || !isPolymarketInvalidCursorError(error)) throw error;
      const resetGenerationVersion = await resetInvalidCursor({
        expectedGenerationVersion: sweepState.generationVersion,
        expectedCursor: afterCursor
      });
      if (resetGenerationVersion === undefined) throw new Error("market_catalog_cursor_reset_conflict", { cause: error });
      catalog = await fetchPage(undefined, resetGenerationVersion);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    return persistCatalog(catalog, { signal: controller.signal });
  })();

  try {
    return await Promise.race([work, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function processMarketIndexCycle() {
  try {
    const result = await indexMarketCatalogOnce();
    await markWorkerSuccess("market-worker");
    return result;
  } catch (error) {
    await markWorkerFailure("market-worker", error);
    throw error;
  }
}

export function startMarketIndexerWorker() {
  return new Worker(
    queueName,
    async (job) => {
      if (job.name === schedulerJobName) {
        const queued = await enqueueMarketIndexJob();
        return { queuedJobId: queued?.id || singletonJobId };
      }
      if (job.name !== jobName) throw new Error(`unsupported_market_indexer_job:${job.name}`);
      return processMarketIndexCycle();
    },
    {
      connection,
      concurrency: 1,
      lockDuration: marketIndexJobTimeoutMs() + 30_000
    }
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const releaseWorkerLease = await acquireWorkerSingletonLease("market-worker");
  const worker = startMarketIndexerWorker();
  const stopHeartbeat = startWorkerHeartbeat("market-worker");
  await enqueueMarketIndexJob();
  await scheduleMarketIndexJobs();
  console.log("market indexer worker started");

  const shutdown = async () => {
    stopHeartbeat();
    await worker.close();
    await marketIndexerQueue.close();
    await releaseWorkerLease();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
