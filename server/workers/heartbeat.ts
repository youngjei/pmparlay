import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function startWorkerHeartbeat(name: string, intervalMs = 10_000) {
  const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || `/tmp/legwork-${name}.heartbeat`;

  const beat = async () => {
    await mkdir(path.dirname(heartbeatFile), { recursive: true });
    await writeFile(heartbeatFile, `${Date.now()}\n`);
  };

  void beat().catch((error) => {
    console.error("worker heartbeat failed", error);
  });

  const timer = setInterval(() => {
    void beat().catch((error) => {
      console.error("worker heartbeat failed", error);
    });
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}
