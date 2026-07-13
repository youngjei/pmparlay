import { closePool } from "./db/client";
import { getPersistedMarketCatalog } from "./db/marketRepository";
import { fetchLiveMarketCatalog } from "./marketCatalog";

const maxAgeMs = Number(process.env.MARKET_QA_MAX_AGE_MS || 30_000);
const maxPriceDiff = Number(process.env.MARKET_QA_MAX_PRICE_DIFF || 0.05);

function keyFor(outcome: { marketId: string; outcome: string }) {
  return `${outcome.marketId}:${outcome.outcome}`;
}

try {
  const persisted = await getPersistedMarketCatalog();
  const ageMs = Date.now() - new Date(persisted.asOf).getTime();
  const live = await fetchLiveMarketCatalog(0);
  const liveByKey = new Map(live.outcomes.map((outcome) => [keyFor(outcome), outcome]));
  const persistedKeys = new Set(persisted.outcomes.map(keyFor));
  const missingLiveKeys = live.outcomes
    .filter((outcome) => !persistedKeys.has(keyFor(outcome)))
    .map((outcome) => ({
      question: outcome.question,
      outcome: outcome.outcome,
      price: outcome.price
    }))
    .slice(0, 20);
  const mismatches = persisted.outcomes
    .map((outcome) => {
      const liveOutcome = liveByKey.get(keyFor(outcome));
      if (!liveOutcome) return undefined;
      const priceDiff = Math.abs(outcome.price - liveOutcome.price);
      if (priceDiff <= maxPriceDiff) return undefined;
      return {
        question: outcome.question,
        outcome: outcome.outcome,
        persistedPrice: outcome.price,
        livePrice: liveOutcome.price,
        priceDiff
      };
    })
    .filter(Boolean)
    .slice(0, 20);

  const report = {
    persistedAsOf: persisted.asOf,
    liveAsOf: live.asOf,
    ageMs,
    persistedOutcomes: persisted.outcomes.length,
    liveOutcomes: live.outcomes.length,
    comparedOutcomes: persisted.outcomes.filter((outcome) => liveByKey.has(keyFor(outcome))).length,
    missingLiveKeys,
    mismatches
  };

  console.log(JSON.stringify(report, null, 2));

  if (!live.complete) {
    throw new Error(`Live market fetch incomplete: ${live.successfulFeeds || 0}/${live.totalFeeds || 0} feeds succeeded`);
  }

  if (!persisted.complete) {
    throw new Error(`Persisted market catalog was produced by an incomplete fetch: ${persisted.successfulFeeds || 0}/${persisted.totalFeeds || 0}`);
  }

  if (ageMs > maxAgeMs) {
    throw new Error(`Persisted market catalog is stale: ${Math.round(ageMs)}ms old`);
  }

  if (mismatches.length > 0) {
    throw new Error(`Persisted market catalog has ${mismatches.length} sampled price mismatches`);
  }

  if (missingLiveKeys.length > 0) {
    throw new Error(`Persisted market catalog is missing ${missingLiveKeys.length} sampled live outcomes`);
  }
} finally {
  await closePool();
}
