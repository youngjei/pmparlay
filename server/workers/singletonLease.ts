import { getPool } from "../db/client";

function workerLeaseName(workerName: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(workerName)) throw new Error("invalid_worker_name");
  return `legwork-worker:${workerName}`;
}

export async function acquireWorkerSingletonLease(workerName: string) {
  const leaseName = workerLeaseName(workerName);
  const client = await getPool().connect();
  let released = false;

  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [leaseName]
    );
    if (!result.rows[0]?.acquired) throw new Error(`worker_already_running:${workerName}`);
  } catch (error) {
    client.release();
    throw error;
  }

  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [leaseName]);
    } finally {
      client.release();
    }
  };
}
