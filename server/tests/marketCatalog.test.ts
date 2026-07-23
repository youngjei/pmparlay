import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPolymarketOutcomeResult: vi.fn()
}));

vi.mock("../../src/marketData", () => ({
  fetchPolymarketOutcomeResult: mocks.fetchPolymarketOutcomeResult
}));

vi.mock("../db/marketRepository", () => ({
  getMarketCatalogSweepState: vi.fn(),
  getPersistedMarketCatalog: vi.fn(),
  persistMarketCatalog: vi.fn()
}));

import { clearMarketCatalogCache, fetchLiveMarketCatalog } from "../marketCatalog";

beforeEach(() => {
  mocks.fetchPolymarketOutcomeResult.mockReset();
  clearMarketCatalogCache();
});

describe("market catalog discovery indexing", () => {
  it("does not fetch every CLOB book during a background index sweep", async () => {
    mocks.fetchPolymarketOutcomeResult.mockResolvedValue({
      outcomes: [
        {
          id: "discovery-yes",
          marketId: "discovery-market",
          conditionId: "condition-discovery",
          tokenId: "token-discovery-yes",
          question: "Will discovery happen?",
          category: "Other",
          outcome: "Yes",
          price: 0.4,
          endDate: "2027-01-01T00:00:00.000Z",
          liquidity: 2_000,
          volume: 10_000,
          sourceActive: true,
          closed: false,
          archived: false,
          acceptingOrders: true,
          enableOrderBook: true,
          source: "polymarket"
        }
      ],
      tombstones: [],
      totalFeeds: 10,
      successfulFeeds: 10,
      complete: false,
      nextCursor: "cursor-eleven",
      sweep: {
        resource: "events",
        attemptedPages: 10,
        successfulPages: 10,
        maxPages: 10,
        nextCursor: "cursor-eleven",
        complete: false,
        truncated: true,
        stoppedReason: "page_cap"
      }
    });

    const catalog = await fetchLiveMarketCatalog(0, undefined, {
      purpose: "index",
      maxPages: 10
    });

    expect(mocks.fetchPolymarketOutcomeResult).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        hydrate: false,
        hydrateLimit: 0,
        requireCompleteHydration: false,
        maxPages: 10
      })
    );
    expect(catalog.outcomes[0].eligibility).toBeUndefined();
    expect(catalog.outcomes[0].bestAsk).toBeUndefined();
  });
});
