import { fetchPolymarketOutcomeResult } from "../src/marketData";
import type { MarketOutcome } from "../packages/domain/src/types";
import { config } from "./config";
import { getPersistedMarketCatalog, persistMarketCatalog } from "./db/marketRepository";

export type MarketCatalogSnapshot = {
  asOf: string;
  source: "polymarket";
  outcomes: MarketOutcome[];
  totalFeeds?: number;
  successfulFeeds?: number;
  complete?: boolean;
};

type CacheEntry = {
  expiresAt: number;
  snapshot: MarketCatalogSnapshot;
};

let cache: CacheEntry | undefined;
let databaseRefresh: Promise<MarketCatalogSnapshot> | undefined;

export async function fetchLiveMarketCatalog(ttlMs: number, signal?: AbortSignal): Promise<MarketCatalogSnapshot> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.snapshot;
  }

  try {
    const result = await fetchPolymarketOutcomeResult(signal);
    const snapshot = {
      asOf: new Date().toISOString(),
      source: "polymarket" as const,
      outcomes: result.outcomes,
      totalFeeds: result.totalFeeds,
      successfulFeeds: result.successfulFeeds,
      complete: result.complete
    };

    cache = {
      expiresAt: now + ttlMs,
      snapshot
    };

    return snapshot;
  } catch (error) {
    if (cache?.snapshot.outcomes.length) {
      return {
        ...cache.snapshot,
        complete: false
      };
    }

    throw error;
  }
}

export async function getMarketCatalog(ttlMs: number, signal?: AbortSignal): Promise<MarketCatalogSnapshot> {
  if (config.DATABASE_URL && config.NODE_ENV !== "test") {
    let persisted: MarketCatalogSnapshot | undefined;

    try {
      persisted = await getPersistedMarketCatalog();
    } catch (error) {
      return fetchLiveMarketCatalog(ttlMs, signal);
    }

    const ageMs = Date.now() - new Date(persisted.asOf).getTime();
    if (Number.isFinite(ageMs) && ageMs <= config.MARKET_CATALOG_MAX_AGE_MS) {
      return persisted;
    }

    if (Number.isFinite(ageMs) && ageMs > config.MARKET_CATALOG_HARD_MAX_AGE_MS) {
      try {
        const live = await fetchLiveMarketCatalog(0, signal);
        await persistMarketCatalog(live);
        return getPersistedMarketCatalog();
      } catch (error) {
        throw new Error("market_catalog_stale");
      }
    }

    databaseRefresh ||= (async () => {
      try {
        const live = await fetchLiveMarketCatalog(0, signal);
        await persistMarketCatalog(live);
        return getPersistedMarketCatalog();
      } catch (error) {
        return {
          ...persisted,
          complete: false
        };
      } finally {
        databaseRefresh = undefined;
      }
    })();

    return {
      ...persisted,
      complete: false
    };
  }

  return fetchLiveMarketCatalog(ttlMs, signal);
}

export function clearMarketCatalogCache() {
  cache = undefined;
}
