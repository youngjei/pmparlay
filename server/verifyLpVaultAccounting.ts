import { closePool, getPool } from "./db/client";
import {
  loadLatestVerifiedLpVaultAccounting,
  replayLpVaultAccounting
} from "./db/lpVaultAccountingRepository";
import { FOUNDER_SEPOLIA_SHADOW_VAULT_ID } from "./db/lpVaultRepository";

try {
  const pool = getPool();
  const accounting = await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID, pool);
  if (!accounting) throw new Error("lp_vault_accounting_missing");
  const replay = await replayLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID, pool);
  if (
    replay.lastClosedBookVersion !== accounting.bookVersion
    || replay.replayedShareSupplyUnits !== accounting.activeShareUnits
    || replay.economicNavMicroUnits !== accounting.economicNavMicroUnits
  ) {
    throw new Error("lp_vault_accounting_verification_mismatch");
  }
  console.log(JSON.stringify({
    status: "verified",
    vaultId: accounting.vaultId,
    cycleId: accounting.cycleId,
    cutoffDate: accounting.cutoffDate,
    closeMode: accounting.closeMode,
    sourceDelayMs: accounting.sourceDelayMs.toString(),
    bookVersion: accounting.bookVersion.toString(),
    eventCount: replay.eventCount,
    lastEventHash: replay.lastEventHash,
    activeShareUnits: accounting.activeShareUnits.toString(),
    economicNavMicroUnits: accounting.economicNavMicroUnits.toString()
  }, null, 2));
} finally {
  await closePool();
}
