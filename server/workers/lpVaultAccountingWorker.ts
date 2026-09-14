import { closePool } from "../db/client";
import { runDueLpVaultAccountingCycle } from "../db/lpVaultAccountingRepository";
import { markWorkerFailure, markWorkerSuccess, sanitizeWorkerFailure } from "../db/workerHeartbeatRepository";
import { startWorkerHeartbeat } from "./heartbeat";
import { createInterruptibleSleeper } from "./interruptibleSleep";
import { acquireWorkerSingletonLease } from "./singletonLease";

export const LP_VAULT_ACCOUNTING_WORKER_NAME = "lp-vault-accounting";
export const DEFAULT_LP_VAULT_ACCOUNTING_POLL_INTERVAL_MS = 60_000;

type AccountingCycleRunner = typeof runDueLpVaultAccountingCycle;

export async function processDueLpVaultAccountingCycle(
  dependencies: { runCycle?: AccountingCycleRunner } = {}
) {
  return await (dependencies.runCycle || runDueLpVaultAccountingCycle)();
}

export function lpVaultAccountingPollIntervalMs(value = process.env.LP_VAULT_ACCOUNTING_POLL_INTERVAL_MS) {
  if (value === undefined || value === "") return DEFAULT_LP_VAULT_ACCOUNTING_POLL_INTERVAL_MS;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("invalid_lp_vault_accounting_poll_interval");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 3_600_000) {
    throw new Error("invalid_lp_vault_accounting_poll_interval");
  }
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let shouldStop = false;
  const sleeper = createInterruptibleSleeper();
  const pollIntervalMs = lpVaultAccountingPollIntervalMs();
  const releaseWorkerLease = await acquireWorkerSingletonLease(LP_VAULT_ACCOUNTING_WORKER_NAME);
  const stopHeartbeat = startWorkerHeartbeat(LP_VAULT_ACCOUNTING_WORKER_NAME);

  process.on("SIGINT", () => {
    shouldStop = true;
    sleeper.interrupt();
  });
  process.on("SIGTERM", () => {
    shouldStop = true;
    sleeper.interrupt();
  });

  try {
    console.log("LP vault accounting worker started");
    while (!shouldStop) {
      try {
        const result = await processDueLpVaultAccountingCycle();
        await markWorkerSuccess(LP_VAULT_ACCOUNTING_WORKER_NAME);
        console.log(JSON.stringify({ event: "lp_vault.accounting.cycle", ...result }));
      } catch (error) {
        const failure = sanitizeWorkerFailure(error);
        await markWorkerFailure(LP_VAULT_ACCOUNTING_WORKER_NAME, failure).catch((heartbeatError) => {
          console.error(JSON.stringify({
            event: "lp_vault.accounting.health.error",
            error: sanitizeWorkerFailure(heartbeatError)
          }));
        });
        console.error(JSON.stringify({ event: "lp_vault.accounting.error", error: failure }));
      }
      await sleeper.sleep(pollIntervalMs);
    }
  } finally {
    stopHeartbeat();
    await releaseWorkerLease();
    await closePool();
  }
}
