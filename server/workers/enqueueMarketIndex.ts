import { enqueueMarketIndexJob, marketIndexerQueue } from "./marketIndexerWorker";

try {
  const job = await enqueueMarketIndexJob();
  console.log(JSON.stringify({ queued: true, jobId: job.id }, null, 2));
} finally {
  await marketIndexerQueue.close();
}
