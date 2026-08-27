import { performance } from "node:perf_hooks";
import { closePool } from "./db/client";
import { getPersistedMarketCatalogPage } from "./db/marketRepository";

const configuredLimit = Number(process.env.MARKET_QA_LIMIT || 12);
const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 && configuredLimit <= 250 ? configuredLimit : 12;
const maxDatabaseLatencyMs = Number(process.env.MARKET_QA_MAX_DB_LATENCY_MS || 2_500);

try {
  const startedAt = performance.now();
  const page = await getPersistedMarketCatalogPage({
    limit,
    sort: "volume",
    requireFreshOrderBook: true,
    maxSnapshotAgeMs: 6 * 60 * 60_000
  });
  const firstPageDatabaseLatencyMs = Math.round(performance.now() - startedAt);

  if (page.outcomes.length === 0) throw new Error("Market performance QA returned no outcomes");
  if (!Number.isFinite(maxDatabaseLatencyMs) || maxDatabaseLatencyMs <= 0) {
    throw new Error("MARKET_QA_MAX_DB_LATENCY_MS must be a positive number");
  }
  if (firstPageDatabaseLatencyMs > maxDatabaseLatencyMs) {
    throw new Error(
      `First persisted market page exceeded its database budget: ${firstPageDatabaseLatencyMs}ms > ${maxDatabaseLatencyMs}ms`
    );
  }

  if (!page.pageInfo.nextCursor) throw new Error("Market performance QA requires a second catalog page");
  const secondPageStartedAt = performance.now();
  const secondPage = await getPersistedMarketCatalogPage({
    cursor: page.pageInfo.nextCursor,
    limit,
    sort: "volume",
    requireFreshOrderBook: true,
    maxSnapshotAgeMs: 6 * 60 * 60_000
  });
  const secondPageDatabaseLatencyMs = Math.round(performance.now() - secondPageStartedAt);
  if (secondPageDatabaseLatencyMs > maxDatabaseLatencyMs) {
    throw new Error(
      `Second persisted market page exceeded its database budget: ${secondPageDatabaseLatencyMs}ms > ${maxDatabaseLatencyMs}ms`
    );
  }

  const firstPageMarketIds = new Set(page.outcomes.map((outcome) => outcome.marketId));
  const duplicateMarketIds = [...new Set(secondPage.outcomes.map((outcome) => outcome.marketId))].filter((marketId) =>
    firstPageMarketIds.has(marketId)
  );
  if (duplicateMarketIds.length > 0) {
    throw new Error(`Market cursor replayed ${duplicateMarketIds.length} first-page markets`);
  }

  console.log(
    JSON.stringify(
      {
        firstPageDatabaseLatencyMs,
        secondPageDatabaseLatencyMs,
        maxDatabaseLatencyMs,
        requestedMarkets: limit,
        firstPageMarkets: firstPageMarketIds.size,
        secondPageMarkets: new Set(secondPage.outcomes.map((outcome) => outcome.marketId)).size,
        hasMore: secondPage.pageInfo.hasMore
      },
      null,
      2
    )
  );
} finally {
  await closePool();
}
