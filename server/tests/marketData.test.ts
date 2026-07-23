import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyOrderBookPrices,
  fetchMarketCatalog,
  fetchPolymarketOutcomeResult,
  hydrateOutcomesWithOrderBooks,
  normalizeGammaMarket
} from "../../src/marketData";
import { annotateCatalogOutcomes, evaluateMarketEligibility, normalizeMarketTaxonomy } from "../marketTaxonomy";

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

  it("sends catalog query parameters to the LEGWORK API", async () => {
    const catalog = {
      asOf: "2026-07-05T15:35:28.638Z",
      source: "polymarket" as const,
      outcomes: [
        {
          id: "btc-up-yes",
          marketId: "btc-up",
          tokenId: "token-yes",
          question: "Bitcoin Up or Down?",
          category: "Crypto",
          outcome: "Yes",
          price: 0.52,
          source: "polymarket" as const
        }
      ]
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMarketCatalog(undefined, {
      cursor: "cursor-one",
      limit: 24,
      search: " world cup ",
      category: "Sports",
      sort: "ending_soon",
      eventGroupKey: "polymarket:event:world-cup"
    });

    const firstFetchCall = fetchMock.mock.calls[0] as unknown[];
    const url = new URL(String(firstFetchCall[0]), "http://localhost");
    expect(url.pathname).toBe("/api/markets");
    expect(url.searchParams.get("cursor")).toBe("cursor-one");
    expect(url.searchParams.get("limit")).toBe("24");
    expect(url.searchParams.get("search")).toBe("world cup");
    expect(url.searchParams.get("category")).toBe("Sports");
    expect(url.searchParams.get("sort")).toBe("ending_soon");
    expect(url.searchParams.get("eventGroupKey")).toBe("polymarket:event:world-cup");
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
        bids: [{ price: "0.001", size: "10" }, { price: "0.032", size: "10" }],
        asks: [{ price: "0.999", size: "10" }, { price: "0.033", size: "10" }]
      },
      {
        asset_id: "token-no",
        timestamp: "1783314410822",
        hash: "no-hash",
        bids: [{ price: "0.001", size: "10" }, { price: "0.967", size: "10" }],
        asks: [{ price: "0.999", size: "10" }, { price: "0.968", size: "10" }]
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
        orderbookTimestamp: new Date(1783314410822).toISOString(),
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

  it("uses ask-side VWAP for requested notional and keeps best ask for display", () => {
    const priced = applyOrderBookPrices(
      [
        {
          id: "btc-yes",
          marketId: "btc-market",
          tokenId: "btc-token",
          question: "Will Bitcoin close higher?",
          category: "Crypto",
          outcome: "Yes",
          price: 0.5,
          source: "polymarket" as const
        }
      ],
      [
        {
          asset_id: "btc-token",
          timestamp: "1783314410822",
          hash: "btc-hash",
          bids: [{ price: "0.49", size: "100" }],
          asks: [
            { price: "0.50", size: "20" },
            { price: "0.60", size: "25" }
          ]
        }
      ],
      { requestedNotionalUsd: 25 }
    );

    expect(priced[0]).toMatchObject({
      bestAsk: 0.5,
      price: 0.555556,
      executablePrice: 0.555556,
      vwapPrice: 0.555556,
      requestedNotionalUsd: 25,
      availableAskNotionalUsd: 25,
      priceSource: "clob_vwap",
      orderbookHash: "btc-hash"
    });
  });

  it("drops notional quotes when ask depth is insufficient", () => {
    const priced = applyOrderBookPrices(
      [
        {
          id: "thin-yes",
          marketId: "thin-market",
          tokenId: "thin-token",
          question: "Will thin market quote?",
          category: "Other",
          outcome: "Yes",
          price: 0.4,
          source: "polymarket" as const
        }
      ],
      [
        {
          asset_id: "thin-token",
          bids: [{ price: "0.39", size: "5" }],
          asks: [{ price: "0.40", size: "10" }]
        }
      ],
      { requestedNotionalUsd: 25 }
    );

    expect(priced).toEqual([]);
  });

  it("ignores malformed orderbook levels", () => {
    const priced = applyOrderBookPrices(
      [
        {
          id: "malformed-yes",
          marketId: "malformed-market",
          tokenId: "malformed-token",
          question: "Will malformed levels be ignored?",
          category: "Other",
          outcome: "Yes",
          price: 0.4,
          source: "polymarket" as const
        }
      ],
      [
        {
          asset_id: "malformed-token",
          bids: [{ price: "0.39", size: "5" }, { price: "0.99", size: "0" }],
          asks: [
            { price: "bad", size: "100" },
            { price: "0.40", size: "0" },
            { price: "0.41", size: "100" }
          ]
        }
      ],
      { requestedNotionalUsd: 25 }
    );

    expect(priced[0]).toMatchObject({
      bestAsk: 0.41,
      price: 0.41,
      availableAskNotionalUsd: 41
    });
  });

  it("retains immutable insufficient-depth evidence for index-time hiding", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            asset_id: "deep-token",
            timestamp: "2026-07-14T00:00:00.000Z",
            bids: [{ price: "0.39", size: "100" }],
            asks: [{ price: "0.40", size: "100" }]
          },
          {
            asset_id: "thin-token",
            timestamp: "2026-07-14T00:00:00.000Z",
            bids: [{ price: "0.59", size: "10" }],
            asks: [{ price: "0.60", size: "10" }]
          }
        ]),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await hydrateOutcomesWithOrderBooks(
      [
        {
          id: "deep",
          marketId: "depth-market",
          tokenId: "deep-token",
          question: "Will the deep side execute?",
          category: "Other",
          outcome: "Yes",
          price: 0.4,
          source: "polymarket"
        },
        {
          id: "thin",
          marketId: "depth-market",
          tokenId: "thin-token",
          question: "Will the thin side execute?",
          category: "Other",
          outcome: "No",
          price: 0.6,
          source: "polymarket"
        }
      ],
      undefined,
      { requestedNotionalUsd: 25, retainUnexecutable: true }
    );

    expect(result.complete).toBe(true);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]).toMatchObject({
      priceSource: "clob_vwap",
      executablePrice: 0.4,
      requestedNotionalUsd: 25,
      availableAskNotionalUsd: 40
    });
    expect(result.outcomes[1]).toMatchObject({
      priceSource: "gamma",
      requestedNotionalUsd: 25,
      availableAskNotionalUsd: 6,
      orderbookTimestamp: "2026-07-14T00:00:00.000Z"
    });
    expect(result.outcomes[1].executablePrice).toBeUndefined();
  });

  it("hydrates only live order-book candidates and retains non-orderable lifecycle records for indexing", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(
          JSON.stringify([
            {
              asset_id: "live-token",
              bids: [{ price: "0.49", size: "100" }],
              asks: [{ price: "0.50", size: "100" }]
            }
          ]),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcomes = [
      { id: "live", tokenId: "live-token" },
      { id: "inactive", tokenId: "inactive-token", sourceActive: false },
      { id: "closed", tokenId: "closed-token", closed: true },
      { id: "archived", tokenId: "archived-token", archived: true },
      { id: "not-accepting", tokenId: "not-accepting-token", acceptingOrders: false },
      { id: "disabled-book", tokenId: "disabled-book-token", enableOrderBook: false },
      { id: "missing-token", tokenId: "   " }
    ].map((outcome) => ({
      marketId: "candidate-market",
      question: "Will only live records request books?",
      category: "Other",
      outcome: outcome.id,
      price: 0.5,
      source: "polymarket" as const,
      ...outcome
    }));

    const publicResult = await hydrateOutcomesWithOrderBooks(outcomes);
    const indexResult = await hydrateOutcomesWithOrderBooks(outcomes, undefined, { retainUnexecutable: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual([{ token_id: "live-token" }]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual([{ token_id: "live-token" }]);
    expect(publicResult.complete).toBe(true);
    expect(publicResult.outcomes.map((outcome) => outcome.id)).toEqual(["live"]);
    expect(indexResult.complete).toBe(true);
    expect(indexResult.outcomes.map((outcome) => outcome.id)).toEqual(outcomes.map((outcome) => outcome.id));
  });

  it("fails closed when CLOB omits a live candidate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await hydrateOutcomesWithOrderBooks([
      {
        id: "live",
        marketId: "live-market",
        tokenId: "live-token",
        question: "Will the book be omitted?",
        category: "Other",
        outcome: "Yes",
        price: 0.5,
        source: "polymarket"
      }
    ]);

    expect(result).toMatchObject({ complete: false, attemptedChunks: 1, successfulChunks: 1 });
    expect(result.outcomes).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains confirmed no-orderbook omissions as non-executable index evidence", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/books")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                asset_id: "live-token",
                bids: [{ price: "0.39", size: "100" }],
                asks: [{ price: "0.40", size: "100" }]
              }
            ]),
            { status: 200 }
          )
        );
      }
      if (url.includes("/book?token_id=missing-token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "No orderbook exists for the requested token id" }), { status: 404 })
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await hydrateOutcomesWithOrderBooks(
      [
        {
          id: "live",
          marketId: "mixed-market",
          tokenId: "live-token",
          question: "Will index hydration retain absent books safely?",
          category: "Other",
          outcome: "Yes",
          price: 0.4,
          source: "polymarket"
        },
        {
          id: "missing",
          marketId: "mixed-market",
          tokenId: "missing-token",
          question: "Will index hydration retain absent books safely?",
          category: "Other",
          outcome: "No",
          price: 0.6,
          bestAsk: 0.61,
          executablePrice: 0.61,
          priceSource: "gamma",
          source: "polymarket"
        }
      ],
      undefined,
      { requestedNotionalUsd: 25, retainUnexecutable: true }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(true);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]).toMatchObject({ priceSource: "clob_vwap", executablePrice: 0.4 });
    expect(result.outcomes[1]).toMatchObject({ price: 0.6, priceSource: "gamma", requestedNotionalUsd: 25, availableAskNotionalUsd: 0 });
    expect(result.outcomes[1].bestAsk).toBeUndefined();
    expect(result.outcomes[1].executablePrice).toBeUndefined();
    expect(result.outcomes[1].orderbookTimestamp).toBeUndefined();
  });

  it("fails index hydration when an omitted token is not confirmed as having no orderbook", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      return Promise.resolve(
        url.endsWith("/books")
          ? new Response(JSON.stringify([]), { status: 200 })
          : new Response(JSON.stringify({ error: "unknown token" }), { status: 404 })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await hydrateOutcomesWithOrderBooks(
      [
        {
          id: "missing",
          marketId: "missing-market",
          tokenId: "missing-token",
          question: "Will ambiguous omissions stay closed?",
          category: "Other",
          outcome: "Yes",
          price: 0.5,
          source: "polymarket"
        }
      ],
      undefined,
      { retainUnexecutable: true }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(false);
    expect(result.outcomes[0].executablePrice).toBeUndefined();
  });

  it("rejects duplicate CLOB asset ids even when the response cardinality matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { asset_id: "token-a", asks: [{ price: "0.5", size: "100" }] },
            { asset_id: "token-a", asks: [{ price: "0.5", size: "100" }] }
          ]),
          { status: 200 }
        )
      )
    );

    const result = await hydrateOutcomesWithOrderBooks(
      ["token-a", "token-b"].map((tokenId) => ({
        id: tokenId,
        marketId: "duplicate-book-market",
        tokenId,
        question: "Will duplicate books be rejected?",
        category: "Other",
        outcome: tokenId,
        price: 0.5,
        source: "polymarket" as const
      }))
    );

    expect(result.complete).toBe(false);
    expect(result.outcomes).toEqual([]);
  });

  it.each([
    ["unexpected", [{ asset_id: "other-token", asks: [{ price: "0.5", size: "100" }] }]],
    ["empty", [{ asks: [{ price: "0.5", size: "100" }] }]]
  ])("rejects %s CLOB asset ids", async (_kind, books) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(books), { status: 200 })));

    const result = await hydrateOutcomesWithOrderBooks([
      {
        id: "expected",
        marketId: "book-id-market",
        tokenId: "expected-token",
        question: "Will invalid CLOB ids be rejected?",
        category: "Other",
        outcome: "Yes",
        price: 0.5,
        source: "polymarket"
      }
    ]);

    expect(result.complete).toBe(false);
    expect(result.outcomes).toEqual([]);
  });

  it("treats an empty candidate set as complete without requesting CLOB books", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await hydrateOutcomesWithOrderBooks([
      {
        id: "inactive",
        marketId: "inactive-market",
        tokenId: "inactive-token",
        question: "Will inactive records skip CLOB?",
        category: "Other",
        outcome: "Yes",
        price: 0.5,
        sourceActive: false,
        source: "polymarket"
      }
    ]);

    expect(result).toMatchObject({ complete: true, attemptedChunks: 0, successfulChunks: 0 });
    expect(result.outcomes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("rejects markets without an immutable CTF condition id", () => {
    const outcomes = normalizeGammaMarket(
      {
        id: "gamma-only-id",
        question: "Will an unstable identity be rejected?",
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.40","0.60"]',
        clobTokenIds: '["token-yes","token-no"]',
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true
      },
      { slug: "unstable-identity", active: true, closed: false, archived: false }
    );

    expect(outcomes).toEqual([]);
  });

  it("requires explicit source lifecycle fields for production quote hydration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            asset_id: "explicit-token",
            bids: [{ price: "0.39", size: "100" }],
            asks: [{ price: "0.40", size: "100" }]
          }
        ]),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const base = {
      marketId: "lifecycle-market",
      question: "Will unknown lifecycle records stay unquoteable?",
      category: "Other",
      outcome: "Yes",
      price: 0.4,
      source: "polymarket" as const
    };
    const result = await hydrateOutcomesWithOrderBooks(
      [
        {
          ...base,
          id: "explicit",
          tokenId: "explicit-token",
          sourceActive: true,
          closed: false,
          archived: false,
          acceptingOrders: true,
          enableOrderBook: true
        },
        { ...base, id: "unknown", tokenId: "unknown-token" }
      ],
      undefined,
      { requireExplicitLifecycle: true }
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual([{ token_id: "explicit-token" }]);
    expect(result.outcomes.map((outcome) => outcome.id)).toEqual(["explicit"]);
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

  it("preserves inactive and non-orderable source records for persistence-time hiding", () => {
    const inactive = normalizeGammaMarket(
      {
        id: "inactive-market",
        conditionId: "inactive-condition",
        question: "Will inactive markets be hidden?",
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.40","0.60"]',
        clobTokenIds: '["token-yes","token-no"]',
        active: false,
        closed: true,
        acceptingOrders: false,
        endDate: "2026-01-01T00:00:00Z"
      },
      { slug: "inactive-fixture", active: true, closed: false, archived: false }
    );

    expect(inactive).toHaveLength(2);
    expect(inactive[0]).toMatchObject({
      sourceActive: false,
      closed: true,
      acceptingOrders: false,
      endDate: "2026-01-01T00:00:00Z"
    });
    expect(
      evaluateMarketEligibility(inactive[0] as Parameters<typeof evaluateMarketEligibility>[0], new Date("2026-07-13T00:00:00Z")).status
    ).toBe("ended");
  });
});

describe("Polymarket keyset pagination", () => {
  function eventPage(id: string, cursor?: string) {
    return {
      events: [
        {
          id: `event-${id}`,
          slug: `event-${id}`,
          title: `Event ${id}`,
          active: true,
          closed: false,
          archived: false,
          category: "Politics",
          tags: [{ label: "Politics", slug: "politics" }],
          markets: [
            {
              id: `market-${id}`,
              conditionId: `condition-${id}`,
              question: `Will candidate ${id} win the US election?`,
              outcomes: '["Yes","No"]',
              outcomePrices: '["0.40","0.60"]',
              clobTokenIds: `["token-${id}-yes","token-${id}-no"]`,
              active: true,
              closed: false,
              archived: false,
              acceptingOrders: true,
              enableOrderBook: true,
              endDate: "2027-07-20T00:00:00Z",
              liquidityNum: 2_500,
              volumeNum: 10_000
            }
          ]
        }
      ],
      next_cursor: cursor
    };
  }

  it("requests active open page 2 with after_cursor while preserving ordering", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(eventPage("one", "cursor-two")), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(eventPage("two")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPolymarketOutcomeResult(undefined, { maxPages: 5 });
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));

    expect(secondUrl.pathname).toBe("/events/keyset");
    expect(secondUrl.searchParams.get("after_cursor")).toBe("cursor-two");
    expect(secondUrl.searchParams.get("active")).toBe("true");
    expect(secondUrl.searchParams.get("closed")).toBe("false");
    expect(secondUrl.searchParams.get("order")).toBe("volume24hr");
    expect(secondUrl.searchParams.get("ascending")).toBe("false");
    expect(secondUrl.searchParams.has("archived")).toBe(false);
    expect(secondUrl.searchParams.has("enableOrderBook")).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.eventGroupKey)).toContain("polymarket:event:event-two");
  });

  it("preserves Gamma invalid-cursor failures for durable sweep recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ type: "validation error", error: "invalid cursor" }), {
          status: 422,
          headers: { "content-type": "application/json" }
        })
      )
    );

    await expect(fetchPolymarketOutcomeResult(undefined, { afterCursor: "expired", maxPages: 1 })).rejects.toMatchObject({
      name: "PolymarketApiError",
      status: 422,
      detail: "invalid cursor"
    });
  });

  it("marks safety-capped sweeps incomplete and exposes continuation cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(eventPage("one", "cursor-two")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPolymarketOutcomeResult(undefined, { maxPages: 1 });

    expect(result.complete).toBe(false);
    expect(result.nextCursor).toBe("cursor-two");
    expect(result.sweep).toMatchObject({
      truncated: true,
      stoppedReason: "page_cap",
      maxPages: 1
    });
  });

  it("emits tombstones for settled and malformed explicitly closed markets", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          events: [
            {
              slug: "settled-event",
              title: "Settled event",
              closed: true,
              markets: [
                {
                  id: "settled-market",
                  conditionId: "settled-condition",
                  question: "Did the settled event happen?",
                  outcomes: '["Yes","No"]',
                  outcomePrices: '["1","0"]',
                  clobTokenIds: '["settled-yes","settled-no"]',
                  active: false,
                  closed: true,
                  archived: false
                },
                {
                  id: "archived-malformed-market",
                  conditionId: "archived-malformed-condition",
                  question: "Was the malformed market archived?",
                  outcomes: '["Yes","No"]',
                  outcomePrices: '["1"]',
                  clobTokenIds: '[]',
                  active: false,
                  closed: false,
                  archived: true
                }
              ]
            }
          ]
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPolymarketOutcomeResult(undefined, { hydrate: true, maxPages: 1 });

    expect(result.outcomes).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.tombstones).toMatchObject([
      {
        marketId: "archived-malformed-condition",
        archived: true,
        sourceActive: false
      },
      {
        marketId: "settled-condition",
        closed: true,
        sourceActive: false
      }
    ]);
  });
});

describe("market taxonomy and eligibility", () => {
  it("normalizes US politics to Politics", () => {
    expect(
      normalizeMarketTaxonomy({
        question: "Will a Democrat win the US presidential election?",
        sourceCategory: "US",
        sourceTags: ["Elections"]
      }).category
    ).toBe("Politics");
  });

  it("normalizes Bitcoin topics to Crypto", () => {
    expect(
      normalizeMarketTaxonomy({
        question: "Will Bitcoin hit $150k?",
        sourceTags: ["BTC"]
      }).category
    ).toBe("Crypto");
  });

  it("matches taxonomy terms on token boundaries", () => {
    expect(normalizeMarketTaxonomy({ question: "Will it rain in Seoul tomorrow?" }).category).toBe("World and Weather");
    expect(normalizeMarketTaxonomy({ question: "Will the word said appear in the transcript?" }).category).toBe("Other");
    expect(normalizeMarketTaxonomy({ question: "Will the resolution pass?" }).category).toBe("Other");
  });

  it("builds deterministic event grouping metadata", () => {
    const [outcome] = annotateCatalogOutcomes([
      {
        id: "world-cup-yes",
        marketId: "world-cup",
        question: "Will USA win the World Cup?",
        category: "Sports",
        outcome: "Yes",
        price: 0.1,
        marketUrl: "https://polymarket.com/event/world-cup-winner",
        liquidity: 2_000,
        volume: 10_000,
        source: "polymarket" as const
      }
    ]);

    expect(outcome).toMatchObject({
      eventGroupKey: "polymarket:event:world-cup-winner",
      eventSlug: "world-cup-winner",
      eventTitle: "World Cup Winner"
    });
    expect(outcome.relationships?.hard[0]).toMatchObject({
      type: "same_event",
      key: "polymarket:event:world-cup-winner"
    });
  });

  it("applies liquidity-or-volume eligibility boundaries", () => {
    const now = new Date("2026-07-13T00:00:00Z");
    const base = {
      id: "boundary-yes",
      marketId: "boundary",
      conditionId: "boundary-condition",
      question: "Will boundary market pass?",
      category: "Other",
      outcome: "Yes",
      price: 0.5,
      endDate: "2026-07-14T00:00:00Z",
      sourceActive: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      enableOrderBook: true,
      bestAsk: 0.51,
      executablePrice: 0.51,
      requestedNotionalUsd: 25,
      availableAskNotionalUsd: 100,
      orderbookTimestamp: "2026-07-13T00:00:00.000Z",
      priceSource: "clob_ask" as const,
      tokenId: "token",
      source: "polymarket" as const
    };

    expect(evaluateMarketEligibility({ ...base, liquidity: 999, volume: 4_999 }, now).eligible).toBe(false);
    expect(evaluateMarketEligibility({ ...base, liquidity: 1_000, volume: 0 }, now).eligible).toBe(true);
    expect(evaluateMarketEligibility({ ...base, liquidity: 0, volume: 5_000 }, now).eligible).toBe(true);
    expect(
      evaluateMarketEligibility({ ...base, liquidity: undefined, volume: undefined }, now, {
        minLiquidityUsd: 1_000,
        minVolumeUsd: 5_000,
        maxSpread: 0.2,
        maxPublicAgeMs: 60_000,
        requireOrderBook: true,
        allowUnknownLiquiditySignals: true
      }).eligible
    ).toBe(true);
  });

  it("handles date rollover at query time", () => {
    const base = {
      id: "rollover-yes",
      marketId: "rollover",
      conditionId: "rollover-condition",
      question: "Will rollover market stay live?",
      category: "Other",
      outcome: "Yes",
      price: 0.5,
      liquidity: 1_000,
      volume: 5_000,
      sourceActive: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      enableOrderBook: true,
      bestAsk: 0.51,
      executablePrice: 0.51,
      requestedNotionalUsd: 25,
      availableAskNotionalUsd: 100,
      orderbookTimestamp: "2026-07-13T23:59:59.000Z",
      priceSource: "clob_ask" as const,
      tokenId: "token",
      source: "polymarket" as const
    };

    expect(evaluateMarketEligibility({ ...base, endDate: "2026-07-14T00:00:00Z" }, new Date("2026-07-13T23:59:59Z")).eligible).toBe(true);
    expect(evaluateMarketEligibility({ ...base, endDate: "2026-07-14T00:00:00Z" }, new Date("2026-07-14T00:00:00Z")).status).toBe("ended");
  });

  it("rejects stale or insufficient indexed order-book evidence", () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    const outcome = {
      id: "strict-evidence",
      marketId: "strict-market",
      conditionId: "strict-condition",
      tokenId: "strict-token",
      question: "Will strict evidence pass?",
      category: "Other",
      outcome: "Yes",
      price: 0.4,
      bestAsk: 0.4,
      executablePrice: 0.4,
      requestedNotionalUsd: 25,
      availableAskNotionalUsd: 25,
      priceSource: "clob_vwap" as const,
      orderbookTimestamp: now.toISOString(),
      liquidity: 2_000,
      volume: 10_000,
      sourceActive: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      enableOrderBook: true,
      source: "polymarket" as const
    };

    expect(evaluateMarketEligibility(outcome, now).eligible).toBe(true);
    expect(evaluateMarketEligibility({ ...outcome, availableAskNotionalUsd: 24.99 }, now).status).toBe("no_orderbook");
    expect(evaluateMarketEligibility({ ...outcome, orderbookTimestamp: "2026-07-13T23:57:00.000Z" }, now).status).toBe("no_orderbook");
  });
});
