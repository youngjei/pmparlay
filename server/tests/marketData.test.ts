import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOrderBookPrices, fetchMarketCatalog, normalizeGammaMarket } from "../../src/marketData";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Polymarket market normalization", () => {
  it("preserves LEGWORK API catalog freshness metadata", async () => {
    const catalog = {
      asOf: "2026-07-05T15:35:28.638Z",
      source: "polymarket" as const,
      complete: false,
      totalFeeds: 11,
      successfulFeeds: 8,
      outcomes: [
        {
          id: "btc-up-yes",
          marketId: "btc-up",
          tokenId: "token-yes",
          question: "Bitcoin Up or Down?",
          category: "Crypto",
          outcome: "Yes",
          price: 0.52,
          marketUrl: "https://polymarket.com/event/bitcoin-up-or-down",
          sourceAsOf: "2026-07-05T15:35:20.000Z",
          source: "polymarket" as const
        }
      ]
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMarketCatalog();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      asOf: catalog.asOf,
      complete: false,
      totalFeeds: 11,
      successfulFeeds: 8
    });
    expect(result.outcomes).toEqual(catalog.outcomes);
  });

  it("uses token-level CLOB best ask as the executable buy price", () => {
    const outcomes = [
      {
        id: "usa-yes",
        marketId: "usa-market",
        tokenId: "token-yes",
        question: "Will USA win?",
        category: "Sports",
        outcome: "Yes",
        price: 0.0325,
        source: "polymarket" as const
      },
      {
        id: "usa-no",
        marketId: "usa-market",
        tokenId: "token-no",
        question: "Will USA win?",
        category: "Sports",
        outcome: "No",
        price: 0.9675,
        source: "polymarket" as const
      }
    ];

    const priced = applyOrderBookPrices(outcomes, [
      {
        asset_id: "token-yes",
        timestamp: "1783314410822",
        hash: "yes-hash",
        bids: [{ price: "0.001" }, { price: "0.032" }],
        asks: [{ price: "0.999" }, { price: "0.033" }]
      },
      {
        asset_id: "token-no",
        timestamp: "1783314410822",
        hash: "no-hash",
        bids: [{ price: "0.001" }, { price: "0.967" }],
        asks: [{ price: "0.999" }, { price: "0.968" }]
      }
    ]);

    expect(priced).toMatchObject([
      {
        outcome: "Yes",
        price: 0.033,
        bestBid: 0.032,
        bestAsk: 0.033,
        spread: 0.001,
        priceSource: "clob_ask",
        orderbookHash: "yes-hash"
      },
      {
        outcome: "No",
        price: 0.968,
        bestBid: 0.967,
        bestAsk: 0.968,
        spread: 0.001,
        priceSource: "clob_ask",
        orderbookHash: "no-hash"
      }
    ]);
  });

  it("drops outcomes without executable ask liquidity", () => {
    const priced = applyOrderBookPrices(
      [
        {
          id: "thin-yes",
          marketId: "thin-market",
          tokenId: "thin-token",
          question: "Will thin market quote?",
          category: "Testing",
          outcome: "Yes",
          price: 0.4,
          source: "polymarket" as const
        }
      ],
      [
        {
          asset_id: "thin-token",
          bids: [{ price: "0.39" }],
          asks: []
        }
      ]
    );

    expect(priced).toEqual([]);
  });

  it("keeps outcome labels, prices, and token ids aligned when Polymarket sends reversed order", () => {
    const outcomes = normalizeGammaMarket(
      {
        id: "reverse-market",
        conditionId: "reverse-condition",
        question: "Will the reversed fixture pass?",
        outcomes: '["No","Yes"]',
        outcomePrices: '["0.80","0.20"]',
        clobTokenIds: '["token-no","token-yes"]',
        active: true,
        closed: false,
        acceptingOrders: true,
        endDate: "2027-07-20T00:00:00Z"
      },
      {
        slug: "reverse-fixture",
        active: true,
        closed: false,
        archived: false,
        category: "Testing"
      }
    );

    expect(outcomes).toMatchObject([
      {
        outcome: "No",
        price: 0.8,
        tokenId: "token-no"
      },
      {
        outcome: "Yes",
        price: 0.2,
        tokenId: "token-yes"
      }
    ]);
  });

  it("rejects malformed outcome arrays instead of showing a misleading partial market", () => {
    const outcomes = normalizeGammaMarket(
      {
        id: "bad-market",
        conditionId: "bad-condition",
        question: "Will malformed arrays be rejected?",
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.40"]',
        clobTokenIds: '["token-yes","token-no"]',
        active: true,
        closed: false,
        acceptingOrders: true,
        endDate: "2027-07-20T00:00:00Z"
      },
      {
        slug: "bad-fixture",
        active: true,
        closed: false,
        archived: false
      }
    );

    expect(outcomes).toEqual([]);
  });

  it("rejects duplicate outcome labels instead of collapsing token mappings", () => {
    const outcomes = normalizeGammaMarket(
      {
        id: "duplicate-label-market",
        conditionId: "duplicate-label-condition",
        question: "Will duplicate labels be rejected?",
        outcomes: '["Yes","Yes"]',
        outcomePrices: '["0.40","0.60"]',
        clobTokenIds: '["token-a","token-b"]',
        active: true,
        closed: false,
        acceptingOrders: true,
        endDate: "2027-07-20T00:00:00Z"
      },
      {
        slug: "duplicate-label-fixture",
        active: true,
        closed: false,
        archived: false
      }
    );

    expect(outcomes).toEqual([]);
  });

  it("rejects inactive and non-orderable markets", () => {
    expect(
      normalizeGammaMarket(
        {
          id: "inactive-market",
          question: "Will inactive markets be hidden?",
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.40","0.60"]',
          clobTokenIds: '["token-yes","token-no"]',
          active: false,
          closed: false,
          acceptingOrders: true,
          endDate: "2027-07-20T00:00:00Z"
        },
        { slug: "inactive-fixture", active: true, closed: false, archived: false }
      )
    ).toEqual([]);

    expect(
      normalizeGammaMarket(
        {
          id: "non-orderable-market",
          question: "Will non-orderable markets be hidden?",
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.40","0.60"]',
          clobTokenIds: '["token-yes","token-no"]',
          active: true,
          closed: false,
          acceptingOrders: false,
          endDate: "2027-07-20T00:00:00Z"
        },
        { slug: "non-orderable-fixture", active: true, closed: false, archived: false }
      )
    ).toEqual([]);
  });
});
