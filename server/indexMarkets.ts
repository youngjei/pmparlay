import { closePool } from "./db/client";
import { persistMarketCatalog } from "./db/marketRepository";
import { fetchLiveMarketCatalog } from "./marketCatalog";

try {
  const catalog = await fetchLiveMarketCatalog(0);
  const result = await persistMarketCatalog(catalog);
  console.log(
    JSON.stringify(
      {
        asOf: catalog.asOf,
        ...result
      },
      null,
      2
    )
  );
} finally {
  await closePool();
}
