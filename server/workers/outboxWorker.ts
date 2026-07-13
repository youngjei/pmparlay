import { closePool } from "../db/client";
import { claimOutboxBatch, markOutboxFailed, markOutboxSent } from "../db/outboxRepository";
import { startWorkerHeartbeat } from "./heartbeat";

const pollIntervalMs = 5_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let shouldStop = false;
const stopHeartbeat = startWorkerHeartbeat("outbox-worker");
process.on("SIGINT", () => {
  shouldStop = true;
});
process.on("SIGTERM", () => {
  shouldStop = true;
});

async function handleMessage(message: Awaited<ReturnType<typeof claimOutboxBatch>>[number]) {
  console.log(
    JSON.stringify({
      event: "outbox.message",
      id: message.id,
      topic: message.topic,
      attempts: message.attempts
    })
  );
}

try {
  while (!shouldStop) {
    const messages = await claimOutboxBatch(10);
    if (messages.length === 0) {
      await sleep(pollIntervalMs);
      continue;
    }

    for (const message of messages) {
      try {
        await handleMessage(message);
        await markOutboxSent(message.id);
      } catch (error) {
        console.error(error);
        await markOutboxFailed(message.id, Math.min(900, 30 * message.attempts));
      }
    }
  }
} finally {
  stopHeartbeat();
  await closePool();
}
