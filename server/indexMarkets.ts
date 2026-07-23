import { closePool } from "./db/client";
import { getMarketCatalogSweepState, persistMarketCatalog } from "./db/marketRepository";
import { fetchLiveMarketCatalog } from "./marketCatalog";

try {
  const sweepState = await getMarketCatalogSweepState().catch(() => undefined);
  const afterCursor = process.env.MARKET_INDEX_AFTER_CURSOR || sweepState?.nextCursor;
  const catalog = await fetchLiveMarketCatalog(0, undefined, {
    purpose: "index",
    afterCursor,
    maxPages: process.env.MARKET_INDEX_MAX_PAGES ? Number(process.env.MARKET_INDEX_MAX_PAGES) : undefined,
    expectedGenerationVersion: sweepState?.generationVersion ?? 0
  });
  const result = await persistMarketCatalog(catalog);
  console.log(
    JSON.stringify(
      {
        asOf: catalog.asOf,
        complete: catalog.complete,
        nextCursor: catalog.nextCursor,
        sweep: catalog.sweep,
        ...result
      },
      null,
      2
    )
  );
} finally {
  await closePool();
}
