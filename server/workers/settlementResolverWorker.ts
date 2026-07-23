import { config } from "../config";
import { closePool } from "../db/client";
import { syncSettlementOperationalAlerts } from "../db/settlementAlertRepository";
import { markWorkerFailure, markWorkerSuccess, sanitizeWorkerFailure } from "../db/workerHeartbeatRepository";
import {
  listBlockedSettlementLegs,
  listPendingSettlementLegs,
  getLatestPolymarketApiSettlementCandidate,
  recordLegSettlement,
  recordSettlementObservation,
  type PendingSettlementLeg
} from "../db/settlementRepository";
import { resolvePolymarketLeg, type PolymarketSettlementDecision } from "../resolvers/polymarketSettlementResolver";
import { startWorkerHeartbeat } from "./heartbeat";
import { createInterruptibleSleeper } from "./interruptibleSleep";
import { acquireWorkerSingletonLease } from "./singletonLease";

type SettlementWorkerDependencies = {
  listPendingSettlementLegs?: typeof listPendingSettlementLegs;
  listBlockedSettlementLegs?: typeof listBlockedSettlementLegs;
  recordLegSettlement?: typeof recordLegSettlement;
  recordSettlementObservation?: typeof recordSettlementObservation;
  resolveLeg?: typeof resolvePolymarketLeg;
  getLatestApiCandidate?: typeof getLatestPolymarketApiSettlementCandidate;
  syncOperationalAlerts?: typeof syncSettlementOperationalAlerts;
};

function retrySeconds(leg: PendingSettlementLeg) {
  const attempts = leg.resolutionAttempts || 0;
  return Math.min(3600, 60 * Math.max(1, attempts + 1));
}

function sanitizeSettlementEvidence<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSettlementEvidence(item)) as T;
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === "string" && key.toLowerCase().includes("error")
        ? sanitizeWorkerFailure(item)
        : sanitizeSettlementEvidence(item)
    ])
  ) as T;
}

export async function processSettlementLeg(
  leg: PendingSettlementLeg,
  dependencies: SettlementWorkerDependencies = {}
): Promise<PolymarketSettlementDecision> {
  const resolveLeg = dependencies.resolveLeg || resolvePolymarketLeg;
  const settleLeg = dependencies.recordLegSettlement || recordLegSettlement;
  const observeLeg = dependencies.recordSettlementObservation || recordSettlementObservation;
  const authority = leg.settlementAuthority || config.SETTLEMENT_AUTHORITY;
  const previousApiCandidate =
    authority === "polymarket_api"
      ? await (dependencies.getLatestApiCandidate || getLatestPolymarketApiSettlementCandidate)(leg.ticketLegId)
      : undefined;

  const decision = await resolveLeg(leg, {
    requireOnchain: authority === "polygon_ctf",
    authority,
    previousApiCandidate
  });

  if (decision.kind === "final") {
    const proof = sanitizeSettlementEvidence(decision.proof);
    await settleLeg({
      ticketLegId: leg.ticketLegId,
      result: decision.result,
      source: proof.source,
      proofReference: proof.proofKind,
      proof,
      raw: proof.raw
    });
    return decision;
  }

  const proof = decision.proof ? sanitizeSettlementEvidence(decision.proof) : undefined;
  await observeLeg({
    ticketLegId: leg.ticketLegId,
    resolutionState: decision.resolutionState,
    source: proof?.source || "polymarket_ctf",
    proofKind: proof?.proofKind || decision.proofKind,
    result: proof?.result || decision.result,
    confidence: proof?.confidence,
    chainId: proof?.chainId,
    contractAddress: proof?.contractAddress,
    collateralAddress: proof?.collateralAddress,
    conditionId: proof?.conditionId || leg.settlementConditionId || leg.conditionId,
    tokenId: proof?.tokenId || leg.settlementTokenId || leg.tokenId,
    outcomeIndex: proof?.outcomeIndex ?? leg.settlementOutcomeIndex,
    payoutNumerator: proof?.payoutNumerator,
    payoutDenominator: proof?.payoutDenominator,
    payoutVector: proof?.payoutVector,
    blockNumber: proof?.blockNumber,
    blockHash: proof?.blockHash,
    providerEvidence: proof?.providerEvidence,
    nextCheckSeconds: decision.nextCheckSeconds,
    error: decision.error ? sanitizeWorkerFailure(decision.error) : undefined,
    raw: sanitizeSettlementEvidence(proof?.raw || decision.raw)
  });

  return decision;
}

export async function processSettlementBatch(dependencies: SettlementWorkerDependencies = {}) {
  const listLegs = dependencies.listPendingSettlementLegs || listPendingSettlementLegs;
  const listBlockedLegs = dependencies.listBlockedSettlementLegs || listBlockedSettlementLegs;
  const normalLegs = await listLegs(config.SETTLEMENT_BATCH_SIZE, {
    dueOnly: true,
    includeBlocked: false
  });
  const blockedLegs = await listBlockedLegs(config.SETTLEMENT_BLOCKED_BATCH_SIZE, {
    dueOnly: true
  });
  const legs = [...normalLegs, ...blockedLegs];
  const results: Array<{ ticketLegId: string; status: "processed" | "failed"; error?: string }> = [];

  for (const leg of legs) {
    try {
      await processSettlementLeg(leg, dependencies);
      results.push({ ticketLegId: leg.ticketLegId, status: "processed" });
    } catch (error) {
      const failure = sanitizeWorkerFailure(error);
      await (dependencies.recordSettlementObservation || recordSettlementObservation)({
        ticketLegId: leg.ticketLegId,
        resolutionState: leg.resolutionState === "settlement_blocked" ? "settlement_blocked" : "pending",
        source: "legwork_settlement_worker",
        proofKind: "resolver_error",
        result: "blocked",
        chainId: leg.settlementChainId,
        contractAddress: leg.settlementContractAddress,
        collateralAddress: leg.settlementCollateralAddress,
        conditionId: leg.settlementConditionId || leg.conditionId,
        tokenId: leg.settlementTokenId || leg.tokenId,
        outcomeIndex: leg.settlementOutcomeIndex,
        nextCheckSeconds: retrySeconds(leg),
        error: failure,
        raw: {
          error: failure
        }
      });
      results.push({
        ticketLegId: leg.ticketLegId,
        status: "failed",
        error: failure
      });
    }
  }

  return {
    checked: legs.length,
    normalChecked: normalLegs.length,
    blockedChecked: blockedLegs.length,
    results
  };
}

export async function processSettlementCycle(dependencies: SettlementWorkerDependencies = {}) {
  const batch = await processSettlementBatch(dependencies);
  const alerts = await (dependencies.syncOperationalAlerts || syncSettlementOperationalAlerts)();
  return {
    ...batch,
    alerts
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let shouldStop = false;
  const sleeper = createInterruptibleSleeper();
  const releaseWorkerLease = await acquireWorkerSingletonLease("settlement-worker");
  const stopHeartbeat = startWorkerHeartbeat("settlement-worker");

  process.on("SIGINT", () => {
    shouldStop = true;
    sleeper.interrupt();
  });
  process.on("SIGTERM", () => {
    shouldStop = true;
    sleeper.interrupt();
  });

  try {
    console.log("settlement resolver worker started");
    while (!shouldStop) {
      try {
        const result = await processSettlementCycle();
        const failures = result.results.filter((item) => item.status === "failed");
        if (failures.length > 0) {
          await markWorkerFailure("settlement-worker", `settlement_batch_leg_failures:${failures.length}`);
        } else {
          await markWorkerSuccess("settlement-worker");
        }
        if (
          result.checked > 0 ||
          result.alerts.opened > 0 ||
          result.alerts.escalated > 0 ||
          result.alerts.reasonChanged > 0 ||
          result.alerts.remediated > 0
        ) {
          console.log(
            JSON.stringify({
              event: "settlement.batch",
              ...result,
              results: result.results.map((item) =>
                item.error ? { ...item, error: sanitizeWorkerFailure(item.error) } : item
              )
            })
          );
        }
      } catch (error) {
        const failure = sanitizeWorkerFailure(error);
        await markWorkerFailure("settlement-worker", failure).catch((heartbeatError) => {
          console.error(JSON.stringify({ event: "settlement.batch.health.error", error: sanitizeWorkerFailure(heartbeatError) }));
        });
        console.error(JSON.stringify({ event: "settlement.batch.error", error: failure }));
      }
      await sleeper.sleep(config.SETTLEMENT_POLL_INTERVAL_MS);
    }
  } finally {
    stopHeartbeat();
    await releaseWorkerLease();
    await closePool();
  }
}
