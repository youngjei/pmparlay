import { config } from "../config";
import { closePool } from "../db/client";
import {
  listPendingSettlementLegs,
  recordLegSettlement,
  recordSettlementObservation,
  type PendingSettlementLeg
} from "../db/settlementRepository";
import { resolvePolymarketLeg, type PolymarketSettlementDecision } from "../resolvers/polymarketSettlementResolver";
import { startWorkerHeartbeat } from "./heartbeat";

type SettlementWorkerDependencies = {
  listPendingSettlementLegs?: typeof listPendingSettlementLegs;
  recordLegSettlement?: typeof recordLegSettlement;
  recordSettlementObservation?: typeof recordSettlementObservation;
  resolveLeg?: typeof resolvePolymarketLeg;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retrySeconds(leg: PendingSettlementLeg) {
  const attempts = leg.resolutionAttempts || 0;
  return Math.min(3600, 60 * Math.max(1, attempts + 1));
}

export async function processSettlementLeg(
  leg: PendingSettlementLeg,
  dependencies: SettlementWorkerDependencies = {}
): Promise<PolymarketSettlementDecision> {
  const resolveLeg = dependencies.resolveLeg || resolvePolymarketLeg;
  const settleLeg = dependencies.recordLegSettlement || recordLegSettlement;
  const observeLeg = dependencies.recordSettlementObservation || recordSettlementObservation;

  const decision = await resolveLeg(leg, {
    requireOnchain: config.SETTLEMENT_REQUIRE_ONCHAIN
  });

  if (decision.kind === "final") {
    await settleLeg({
      ticketLegId: leg.ticketLegId,
      result: decision.result,
      source: decision.proof.source,
      proofReference: decision.proof.proofKind,
      proof: decision.proof,
      raw: decision.proof.raw
    });
    return decision;
  }

  await observeLeg({
    ticketLegId: leg.ticketLegId,
    resolutionState: decision.resolutionState,
    source: "polymarket_clob",
    proofKind: decision.proofKind,
    result: decision.result,
    conditionId: leg.conditionId,
    tokenId: leg.tokenId,
    nextCheckSeconds: decision.nextCheckSeconds,
    error: decision.error,
    raw: decision.raw
  });

  return decision;
}

export async function processSettlementBatch(dependencies: SettlementWorkerDependencies = {}) {
  const listLegs = dependencies.listPendingSettlementLegs || listPendingSettlementLegs;
  const legs = await listLegs(config.SETTLEMENT_BATCH_SIZE, {
    dueOnly: true,
    includeBlocked: false
  });
  const results: Array<{ ticketLegId: string; status: "processed" | "failed"; error?: string }> = [];

  for (const leg of legs) {
    try {
      await processSettlementLeg(leg, dependencies);
      results.push({ ticketLegId: leg.ticketLegId, status: "processed" });
    } catch (error) {
      await (dependencies.recordSettlementObservation || recordSettlementObservation)({
        ticketLegId: leg.ticketLegId,
        resolutionState: "pending",
        source: "legwork_settlement_worker",
        proofKind: "resolver_error",
        result: "blocked",
        conditionId: leg.conditionId,
        tokenId: leg.tokenId,
        nextCheckSeconds: retrySeconds(leg),
        error: error instanceof Error ? error.message : "resolver_failed",
        raw: {
          error: error instanceof Error ? error.message : error
        }
      });
      results.push({
        ticketLegId: leg.ticketLegId,
        status: "failed",
        error: error instanceof Error ? error.message : "resolver_failed"
      });
    }
  }

  return {
    checked: legs.length,
    results
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let shouldStop = false;
  const stopHeartbeat = startWorkerHeartbeat("settlement-worker");

  process.on("SIGINT", () => {
    shouldStop = true;
  });
  process.on("SIGTERM", () => {
    shouldStop = true;
  });

  try {
    console.log("settlement resolver worker started");
    while (!shouldStop) {
      const result = await processSettlementBatch();
      if (result.checked > 0) {
        console.log(JSON.stringify({ event: "settlement.batch", ...result }));
      }
      await sleep(config.SETTLEMENT_POLL_INTERVAL_MS);
    }
  } finally {
    stopHeartbeat();
    await closePool();
  }
}
