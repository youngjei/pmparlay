import { hydrateOutcomesWithOrderBooks } from "../src/marketData";
import { closePool } from "./db/client";
import { getMarketCatalogSweepState, getPersistedMarketCatalogPage } from "./db/marketRepository";
import { annotateCatalogOutcomes, isMarketCurrentlyLive, marketEligibilityConfigFromEnv } from "./marketTaxonomy";

const maxCompletionAgeMs = Number(process.env.MARKET_QA_MAX_COMPLETION_AGE_MS || 6 * 60 * 60_000);
const maxProgressAgeMs = Number(process.env.MARKET_QA_MAX_PROGRESS_AGE_MS || 5 * 60_000);
const maxSnapshotAgeMs = Number(process.env.MARKET_QA_MAX_SNAPSHOT_AGE_MS || maxCompletionAgeMs);
const sampleSize = Math.min(Math.max(Number(process.env.MARKET_QA_SAMPLE_SIZE || 48), 1), 100);

try {
  const now = new Date();
  const sweep = await getMarketCatalogSweepState();
  if (!sweep?.completedAt) {
    throw new Error("Persisted market discovery has not completed an end-to-end sweep");
  }

  const sweepAgeMs = now.getTime() - new Date(sweep.completedAt).getTime();
  if (!Number.isFinite(sweepAgeMs) || sweepAgeMs < 0 || sweepAgeMs > maxCompletionAgeMs) {
    throw new Error(`Last completed market discovery sweep is stale: ${Math.round(sweepAgeMs)}ms old`);
  }

  const progressAgeMs = now.getTime() - new Date(sweep.updatedAt).getTime();
  if (!Number.isFinite(progressAgeMs) || progressAgeMs < 0 || progressAgeMs > maxProgressAgeMs) {
    throw new Error(`Current market discovery progress is stale: ${Math.round(progressAgeMs)}ms old`);
  }

  const candidates = await getPersistedMarketCatalogPage({
    limit: sampleSize,
    now,
    requireFreshOrderBook: false,
    maxSnapshotAgeMs
  });
  const malformedIdentity = candidates.outcomes.filter((outcome) => !outcome.conditionId || !outcome.tokenId);
  const ended = candidates.outcomes.filter((outcome) => !isMarketCurrentlyLive(outcome.endDate, now));
  if (malformedIdentity.length > 0) throw new Error(`Discovery sample has ${malformedIdentity.length} outcomes without immutable identity`);
  if (ended.length > 0) throw new Error(`Discovery sample has ${ended.length} ended outcomes`);

  const refreshed = await hydrateOutcomesWithOrderBooks(candidates.outcomes, undefined, {
    requestedNotionalUsd: 25,
    retainUnexecutable: true,
    requireExplicitLifecycle: true
  });
  if (!refreshed.complete) throw new Error("CLOB hydration was incomplete for the public discovery sample");

  const quoteable = annotateCatalogOutcomes(refreshed.outcomes, {
    now: new Date(),
    eligibilityConfig: {
      ...marketEligibilityConfigFromEnv(),
      requireOrderBook: true
    }
  }).filter((outcome) => outcome.eligibility?.eligible === true);
  if (quoteable.length === 0) throw new Error("No quoteable outcomes remained after current CLOB hydration");

  console.log(
    JSON.stringify(
      {
        sweepCompletedAt: sweep.completedAt,
        sweepAgeMs,
        sweepProgressAgeMs: progressAgeMs,
        sweepPages: sweep.successfulPages,
        sourceMarketIdsSeen: sweep.seenMarketIds.length,
        candidateOutcomes: candidates.outcomes.length,
        quoteableOutcomes: quoteable.length,
        filteredOutcomes: refreshed.outcomes.length - quoteable.length
      },
      null,
      2
    )
  );
} finally {
  await closePool();
}
