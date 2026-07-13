import { Queue, Worker } from "bullmq";
import { closePool } from "../db/client";
import { persistMarketCatalog } from "../db/marketRepository";
import { fetchLiveMarketCatalog } from "../marketCatalog";
import { redisConnectionOptions } from "../queues/connection";
import { startWorkerHeartbeat } from "./heartbeat";

const queueName = "market-indexer";
const connection = redisConnectionOptions();

export const marketIndexerQueue = new Queue(queueName, { connection });

export async function enqueueMarketIndexJob() {
  return marketIndexerQueue.add(
    "index-polymarket",
    {},
    {
      removeOnComplete: 50,
      removeOnFail: 100
    }
  );
}

export function startMarketIndexerWorker() {
  return new Worker(
    queueName,
    async () => {
      const catalog = await fetchLiveMarketCatalog(0);
      return persistMarketCatalog(catalog);
    },
    {
      connection,
      concurrency: 1
    }
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = startMarketIndexerWorker();
  const stopHeartbeat = startWorkerHeartbeat("market-worker");
  await enqueueMarketIndexJob();
  const interval = setInterval(() => {
    void enqueueMarketIndexJob();
  }, Number(process.env.MARKET_INDEX_INTERVAL_MS || 60_000));
  console.log("market indexer worker started");

  const shutdown = async () => {
    clearInterval(interval);
    stopHeartbeat();
    await worker.close();
    await marketIndexerQueue.close();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
