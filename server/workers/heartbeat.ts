import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordWorkerHeartbeat, sanitizeWorkerFailure } from "../db/workerHeartbeatRepository";

export function startWorkerHeartbeat(name: string, intervalMs = 10_000) {
  const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || `/tmp/legwork-${name}.heartbeat`;

  const beat = async () => {
    const now = new Date();
    await Promise.all([
      (async () => {
        await mkdir(path.dirname(heartbeatFile), { recursive: true });
        await writeFile(heartbeatFile, `${now.getTime()}\n`);
      })(),
      recordWorkerHeartbeat(name, { now })
    ]);
  };

  void beat().catch((error) => {
    console.error("worker heartbeat failed", sanitizeWorkerFailure(error));
  });

  const timer = setInterval(() => {
    void beat().catch((error) => {
      console.error("worker heartbeat failed", sanitizeWorkerFailure(error));
    });
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}
