import { fetchPolymarketOutcomeResult, type PolymarketMarketTombstone } from "../src/marketData";
import type { MarketOutcome } from "../packages/domain/src/types";
import { config } from "./config";
import { getMarketCatalogSweepState, getPersistedMarketCatalog, persistMarketCatalog } from "./db/marketRepository";
import { annotateCatalogOutcomes, isMarketCurrentlyLive, marketEligibilityConfigFromEnv } from "./marketTaxonomy";

export type MarketCatalogTombstone = PolymarketMarketTombstone;

export type MarketCatalogSnapshot = {
  asOf: string;
  source: "polymarket";
  outcomes: MarketOutcome[];
  tombstones?: MarketCatalogTombstone[];
  totalFeeds?: number;
  successfulFeeds?: number;
  complete?: boolean;
  nextCursor?: string;
  sweep?: {
    resource: "events";
    expectedGenerationVersion?: number;
    startedAfterCursor?: string;
    attemptedPages: number;
    successfulPages: number;
    maxPages: number;
    nextCursor?: string;
    complete: boolean;
    truncated: boolean;
    stoppedReason: "end" | "request_failed" | "duplicate_page" | "duplicate_cursor" | "page_cap";
  };
};

export type MarketCatalogSort = "volume" | "liquidity" | "ending_soon" | "newest";

export type MarketCatalogQuery = {
  cursor?: string;
  offset?: number;
  limit?: number;
  search?: string;
  category?: string;
  sort?: MarketCatalogSort;
  eventGroupKey?: string;
};

export type MarketCatalogGroup = {
  eventGroupKey: string;
  eventTitle?: string;
  eventSlug?: string;
  category?: string;
  marketCount: number;
  outcomeCount: number;
};

export type MarketCatalogPage = MarketCatalogSnapshot & {
  groups?: MarketCatalogGroup[];
  pageInfo: {
    limit: number;
    offset: number;
    nextCursor?: string;
    hasMore: boolean;
    total?: number;
  };
};

type FetchLiveMarketCatalogOptions = {
  purpose?: "index" | "public";
  hydrateLimit?: number;
  requestedNotionalUsd?: number;
  afterCursor?: string;
  maxPages?: number;
  expectedGenerationVersion?: number;
};

type CacheEntry = {
  expiresAt: number;
  snapshot: MarketCatalogSnapshot;
};

type GetMarketCatalogOptions = {
  requestedNotionalUsd?: number;
  requestedNotionalUsdPerLeg?: number;
};

const cache = new Map<string, CacheEntry>();
let databaseRefresh: Promise<MarketCatalogSnapshot> | undefined;

function cacheKeyFor(options: FetchLiveMarketCatalogOptions) {
  return `${options.purpose || "public"}:${options.hydrateLimit ?? "default"}:${options.requestedNotionalUsd ?? 25}:${options.afterCursor ?? "start"}:${options.maxPages ?? "default"}:${options.expectedGenerationVersion ?? 0}`;
}

function withoutEndedOutcomes(snapshot: MarketCatalogSnapshot, now: Date): MarketCatalogSnapshot {
  return {
    ...snapshot,
    outcomes: snapshot.outcomes.filter((outcome) => isMarketCurrentlyLive(outcome.endDate, now))
  };
}

export async function fetchLiveMarketCatalog(
  ttlMs: number,
  signal?: AbortSignal,
  options: FetchLiveMarketCatalogOptions = {}
): Promise<MarketCatalogSnapshot> {
  const now = Date.now();
  const purpose = options.purpose || "public";
  const cacheKey = cacheKeyFor(options);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return purpose === "public" ? withoutEndedOutcomes(cached.snapshot, new Date(now)) : cached.snapshot;
  }

  try {
    const hydrate = purpose === "public";
    const hydrateLimit = hydrate ? options.hydrateLimit ?? 100 : 0;
    const result = await fetchPolymarketOutcomeResult(signal, {
      hydrate,
      hydrateLimit,
      requestedNotionalUsd: options.requestedNotionalUsd ?? 25,
      retainUnexecutable: false,
      requireCompleteHydration: false,
      afterCursor: options.afterCursor,
      maxPages: options.maxPages
    });
    const asOf = new Date().toISOString();
    const snapshot = {
      asOf,
      source: "polymarket" as const,
      outcomes: hydrate
        ? annotateCatalogOutcomes(result.outcomes, {
            now: new Date(asOf),
            eligibilityConfig: marketEligibilityConfigFromEnv()
          })
        : result.outcomes,
      tombstones: result.tombstones,
      totalFeeds: result.totalFeeds,
      successfulFeeds: result.successfulFeeds,
      complete: result.complete,
      nextCursor: result.nextCursor,
      sweep: {
        ...result.sweep,
        expectedGenerationVersion: options.expectedGenerationVersion ?? 0
      }
    };

    cache.set(cacheKey, {
      expiresAt: now + ttlMs,
      snapshot
    });

    return purpose === "public" ? withoutEndedOutcomes(snapshot, new Date(now)) : snapshot;
  } catch (error) {
    if (cached?.snapshot.outcomes.length) {
      const staleSnapshot = {
        ...cached.snapshot,
        complete: false
      };
      return purpose === "public" ? withoutEndedOutcomes(staleSnapshot, new Date(now)) : staleSnapshot;
    }

    throw error;
  }
}

async function fetchIndexMarketCatalog(signal?: AbortSignal, requestedNotionalUsd?: number) {
  const sweepState = await getMarketCatalogSweepState().catch(() => undefined);
  return fetchLiveMarketCatalog(0, signal, {
    purpose: "index",
    requestedNotionalUsd,
    afterCursor: sweepState?.nextCursor,
    expectedGenerationVersion: sweepState?.generationVersion ?? 0
  });
}

export async function getMarketCatalog(ttlMs: number, signal?: AbortSignal, options: GetMarketCatalogOptions = {}): Promise<MarketCatalogSnapshot> {
  const requestedNotionalUsd = options.requestedNotionalUsd ?? options.requestedNotionalUsdPerLeg;
  if (config.DATABASE_URL && config.NODE_ENV !== "test") {
    let persisted: MarketCatalogSnapshot | undefined;

    try {
      persisted = await getPersistedMarketCatalog({
        requireFreshOrderBook: false,
        maxSnapshotAgeMs: config.MARKET_CATALOG_HARD_MAX_AGE_MS
      });
    } catch (error) {
      return fetchLiveMarketCatalog(ttlMs, signal, { requestedNotionalUsd });
    }

    const ageMs = Date.now() - new Date(persisted.asOf).getTime();
    if (Number.isFinite(ageMs) && ageMs <= config.MARKET_CATALOG_MAX_AGE_MS) {
      return persisted;
    }

    if (Number.isFinite(ageMs) && ageMs > config.MARKET_CATALOG_HARD_MAX_AGE_MS) {
      try {
        const live = await fetchIndexMarketCatalog(signal, requestedNotionalUsd);
        await persistMarketCatalog(live);
        return getPersistedMarketCatalog();
      } catch (error) {
        throw new Error("market_catalog_stale");
      }
    }

    databaseRefresh ||= (async () => {
      try {
        const live = await fetchIndexMarketCatalog(signal, requestedNotionalUsd);
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

  return fetchLiveMarketCatalog(ttlMs, signal, { requestedNotionalUsd });
}

export function clearMarketCatalogCache() {
  cache.clear();
}
