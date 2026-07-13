import { stat } from "node:fs/promises";

const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE;
const maxAgeMs = Number(process.env.WORKER_HEARTBEAT_MAX_AGE_MS || 45_000);

if (!heartbeatFile) {
  console.error("WORKER_HEARTBEAT_FILE is required");
  process.exit(1);
}

try {
  const file = await stat(heartbeatFile);
  const ageMs = Date.now() - file.mtimeMs;
  if (ageMs > maxAgeMs) {
    console.error(`Worker heartbeat stale: ${Math.round(ageMs)}ms old`);
    process.exit(1);
  }

  console.log(`Worker heartbeat fresh: ${Math.round(ageMs)}ms old`);
} catch (error) {
  console.error("Worker heartbeat missing or unreadable", error);
  process.exit(1);
}
