import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp as buildRawApp } from "../app";
import { config } from "../config";
import { applyAdditionalRiskChecks, clearQuoteStore } from "../quoteService";

type AppDependencies = Parameters<typeof buildRawApp>[0];

const betaStakeUsd = 2;
const betaOperationFeeUsd = 1;
const betaAmountPaidUsd = betaStakeUsd + betaOperationFeeUsd;
const betaPotentialPayoutUsd = 4;
const betaPaymentAmountMicroUnits = "3000000";

function buildApp(dependencies: AppDependencies = {}) {
  return buildRawApp({
    assertFinancialGateOpen: async () => ({
      allowed: true,
      launchGate: "ready",
      operationGate: "open",
      reasons: [],
      maxSnapshotAgeMs: 300_000
    }),
    ...dependencies
  });
}

const openApps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  clearQuoteStore();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function catalogFixture() {
  return {
    asOf: "2026-07-05T15:35:28.638Z",
    source: "polymarket" as const,
    outcomes: [
      {
        id: "btc-up-yes",
        marketId: "btc-up",
        question: "Bitcoin Up or Down?",
        category: "Crypto",
        outcome: "Yes",
        price: 0.52,
        marketUrl: "https://polymarket.com/event/bitcoin-up-or-down",
        source: "polymarket" as const,
        sourceAsOf: "2026-07-05T15:35:20.000Z",
        volume: 1_000_000,
        liquidity: 1_000_000
      },
      {
        id: "btc-up-no",
        marketId: "btc-up",
        question: "Bitcoin Up or Down?",
        category: "Crypto",
        outcome: "No",
        price: 0.48,
        marketUrl: "https://polymarket.com/event/bitcoin-up-or-down",
        source: "polymarket" as const,
        sourceAsOf: "2026-07-05T15:35:20.000Z",
        volume: 1_000_000,
        liquidity: 1_000_000
      },
      {
        id: "newsom-no",
        marketId: "newsom-nominee",
        question: "Will Gavin Newsom win the 2028 Democratic presidential nomination?",
        category: "Politics",
        outcome: "No",
        price: 0.8,
        marketUrl: "https://polymarket.com/event/democratic-presidential-nominee-2028",
        source: "polymarket" as const,
        sourceAsOf: "2026-07-05T15:35:28.638Z",
        volume: 1_000_000,
        liquidity: 1_000_000
      },
      {
        id: "usa-no",
        marketId: "usa-world-cup",
        question: "Will USA win the 2026 FIFA World Cup?",
        category: "Sports",
        outcome: "No",
        price: 0.975,
        marketUrl: "https://polymarket.com/event/world-cup-winner",
        source: "polymarket" as const,
        sourceAsOf: "2026-07-05T15:35:18.000Z",
        volume: 1_000_000,
        liquidity: 1_000_000
      },
      {
        id: "morocco-yes",
        marketId: "morocco-world-cup",
        question: "Will Morocco win the 2026 FIFA World Cup?",
        category: "Sports",
        outcome: "Yes",
        price: 0.028,
        marketUrl: "https://polymarket.com/event/world-cup-winner",
        source: "polymarket" as const,
        sourceAsOf: "2026-07-05T15:35:18.000Z",
        volume: 1_000_000,
        liquidity: 1_000_000
      }
    ]
  };
}

describe("LEGWORK API", () => {
  it("does not allow the legacy accept endpoint in house-book mode", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    Object.assign(config, { ACCOUNTING_MODE: "house_book_usdc" });
    const app = buildApp({
      acceptQuote: async () => {
        throw new Error("accept_should_not_be_called");
      }
    });
    openApps.push(app);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/quotes/quote-test/accept"
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "payment_required" });
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });

  it("applies additional exposure risk blocks to quotes", () => {
    const quote = {
      id: "quote-test",
      status: "quoted" as const,
      createdAt: "2026-07-05T15:35:28.638Z",
      expiresAt: "2026-07-05T15:35:43.638Z",
      sourceAsOf: "2026-07-05T15:35:28.638Z",
      stakeUsd: betaStakeUsd,
      operationFeeUsd: betaOperationFeeUsd,
      totalCostUsd: betaAmountPaidUsd,
      basketPrice: 0.25,
      basketProbability: 0.25,
      quoteSpread: 0.1,
      payoutMultiple: 3.6,
      potentialPayoutUsd: betaPotentialPayoutUsd,
      riskDecision: "accept" as const,
      riskChecks: [],
      legs: []
    };

    const blocked = applyAdditionalRiskChecks(quote, [
      {
        level: "block",
        label: "Market exposure",
        detail: "Open liability would exceed the launch cap."
      }
    ]);

    expect(blocked.status).toBe("rejected");
    expect(blocked.riskDecision).toBe("reject");
    expect(blocked.potentialPayoutUsd).toBe(0);
    expect(blocked.riskChecks[0]).toMatchObject({
      level: "block",
      label: "Market exposure"
    });
  });

  it("applies additional exposure warnings without blocking quotes", () => {
    const quote = {
      id: "quote-test",
      status: "quoted" as const,
      createdAt: "2026-07-05T15:35:28.638Z",
      expiresAt: "2026-07-05T15:35:43.638Z",
      sourceAsOf: "2026-07-05T15:35:28.638Z",
      stakeUsd: betaStakeUsd,
      operationFeeUsd: betaOperationFeeUsd,
      totalCostUsd: betaAmountPaidUsd,
      basketPrice: 0.25,
      basketProbability: 0.25,
      quoteSpread: 0.1,
      payoutMultiple: 3.6,
      potentialPayoutUsd: betaPotentialPayoutUsd,
      riskDecision: "accept" as const,
      riskChecks: [],
      legs: []
    };

    const warned = applyAdditionalRiskChecks(quote, [
      {
        level: "warn",
        label: "Event exposure",
        detail: "Open liability is approaching the launch cap."
      }
    ]);

    expect(warned.status).toBe("quoted");
    expect(warned.riskDecision).toBe("review");
    expect(warned.potentialPayoutUsd).toBe(betaPotentialPayoutUsd);
  });

  it("reports health", async () => {
    const app = buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/healthz"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-ratelimit-limit"]).toBe("120");
    expect(response.json()).toMatchObject({
      ok: true,
      service: "legwork-api"
    });
  });

  it("reports readiness", async () => {
    const app = buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/readyz"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true
    });
  });

  it("fails production readiness when a required worker is stale", async () => {
    const previous = {
      nodeEnv: config.NODE_ENV,
      databaseUrl: config.DATABASE_URL,
      rateLimitBackend: config.RATE_LIMIT_BACKEND
    };
    Object.assign(config, { NODE_ENV: "production", DATABASE_URL: undefined, RATE_LIMIT_BACKEND: "memory" });
    try {
      const app = buildApp({
        getWorkerHeartbeatHealth: async () => ({
          healthy: false,
          checkedAt: new Date().toISOString(),
          maxAgeMs: 45_000,
          successMaxAgeMs: 180_000,
          workers: [{ name: "settlement-worker", status: "stale", heartbeatAt: new Date(0).toISOString(), ageMs: 60_000 }]
        })
      });
      openApps.push(app);

      const response = await app.inject({ method: "GET", url: "/readyz" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        ok: false,
        error: "required_workers_unhealthy",
        workers: [{ name: "settlement-worker", status: "stale" }]
      });
    } finally {
      Object.assign(config, {
        NODE_ENV: previous.nodeEnv,
        DATABASE_URL: previous.databaseUrl,
        RATE_LIMIT_BACKEND: previous.rateLimitBackend
      });
    }
  });

  it("rejects oversized JSON bodies before route handling", async () => {
    const app = buildApp({
      syncPrivyIdentityToken: async () => {
        throw new Error("sync_should_not_be_called");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/privy/sync",
      payload: {
        identityToken: "a".repeat(64 * 1024)
      }
    });

    expect(response.statusCode).toBe(413);
  });

  it("applies the stricter auth sync route limit", async () => {
    const app = buildApp();
    openApps.push(app);

    let response;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      response = await app.inject({
        method: "POST",
        url: "/api/auth/privy/sync",
        payload: { identityToken: "identity-token-for-rate-limit" }
      });
    }

    expect(response?.headers["x-ratelimit-limit"]).toBe("8");
    expect(response?.statusCode).toBe(429);
  });

  it("serves market catalog snapshots through the API", async () => {
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture()
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/markets"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, max-age=30, stale-while-revalidate=30");
    expect(response.json()).toMatchObject({
      asOf: "2026-07-05T15:35:28.638Z",
      source: "polymarket"
    });
    expect(response.json().outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "btc-up-yes",
          price: 0.52
        })
      ])
    );
  });

  it("validates and forwards bounded persisted market catalog queries", async () => {
    let receivedQuery: unknown;
    const app = buildApp({
      getPersistedMarketCatalogPage: async (query) => {
        receivedQuery = query;
        return {
          ...catalogFixture(),
          groups: [],
          pageInfo: {
            limit: query?.limit || 48,
            offset: 0,
            hasMore: false,
            total: 3
          }
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/markets?limit=24&category=Sports&sort=ending_soon&search=world%20cup"
    });

    expect(response.statusCode).toBe(200);
    expect(receivedQuery).toEqual({
      cursor: undefined,
      limit: 24,
      search: "world cup",
      category: "Sports",
      sort: "ending_soon",
      eventGroupKey: undefined
    });
  });

  it("refreshes persisted discovery candidates before returning public market prices", async () => {
    const now = new Date().toISOString();
    const candidate = {
      ...catalogFixture().outcomes[0],
      conditionId: "0xcondition",
      tokenId: "token-yes",
      eventGroupKey: "polymarket:event:bitcoin-up-or-down",
      eventTitle: "Bitcoin Up or Down?",
      eventSlug: "bitcoin-up-or-down",
      sourceActive: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      enableOrderBook: true
    };
    const oppositeCandidate = {
      ...catalogFixture().outcomes[1],
      conditionId: candidate.conditionId,
      tokenId: "token-no",
      eventGroupKey: candidate.eventGroupKey,
      eventTitle: candidate.eventTitle,
      eventSlug: candidate.eventSlug,
      sourceActive: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      enableOrderBook: true
    };
    const hydrateQuoteOutcomes = vi.fn(async (_outcomes, _signal, options) => ({
      complete: true,
      attemptedChunks: 1,
      successfulChunks: 1,
      outcomes: [candidate, oppositeCandidate].map((outcome, index) => {
        const price = index === 0 ? 0.61 : 0.41;
        return {
          ...outcome,
          price,
          bestBid: price - 0.01,
          bestAsk: price,
          executablePrice: price,
          vwapPrice: price,
          requestedNotionalUsd: 25,
          availableAskNotionalUsd: 100,
          spread: 0.01,
          priceSource: "clob_vwap" as const,
          orderbookTimestamp: now,
          sourceAsOf: now
        };
      })
    }));
    const app = buildApp({
      getPersistedMarketCatalogPage: async () => ({
        ...catalogFixture(),
        outcomes: [candidate, oppositeCandidate],
        groups: [],
        pageInfo: { limit: 48, offset: 0, hasMore: false, total: 1 }
      }),
      hydrateQuoteOutcomes
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/markets" });

    expect(response.statusCode).toBe(200);
    expect(response.json().asOf).toBe(catalogFixture().asOf);
    expect(hydrateQuoteOutcomes).toHaveBeenCalledWith(
      [candidate, oppositeCandidate],
      expect.any(AbortSignal),
      expect.objectContaining({ requestedNotionalUsd: 25, retainUnexecutable: true, requireExplicitLifecycle: true })
    );
    expect(response.json().outcomes).toEqual([
      expect.objectContaining({ id: candidate.id, price: 0.61, priceSource: "clob_vwap" }),
      expect.objectContaining({ id: oppositeCandidate.id, price: 0.41, priceSource: "clob_vwap" })
    ]);
  });

  it("fills a public market page past candidates without executable order books", async () => {
    const now = new Date().toISOString();
    const firstCandidate = {
      ...catalogFixture().outcomes[0],
      conditionId: "0xcondition-one",
      tokenId: "token-one",
      eventGroupKey: "polymarket:event:first",
      eventTitle: "First market",
      eventSlug: "first",
      sourceActive: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      enableOrderBook: true
    };
    const firstOppositeCandidate = {
      ...firstCandidate,
      id: "first-no",
      tokenId: "token-one-no",
      outcome: "No"
    };
    const secondCandidate = {
      ...firstCandidate,
      id: "second-yes",
      marketId: "second-market",
      conditionId: "0xcondition-two",
      tokenId: "token-two",
      eventGroupKey: "polymarket:event:second",
      eventTitle: "Second market",
      eventSlug: "second"
    };
    const secondOppositeCandidate = {
      ...secondCandidate,
      id: "second-no",
      tokenId: "token-two-no",
      outcome: "No"
    };
    const getPersistedMarketCatalogPage = vi.fn(async (query) => ({
      ...catalogFixture(),
      outcomes: query?.cursor ? [secondCandidate, secondOppositeCandidate] : [firstCandidate, firstOppositeCandidate],
      groups: [],
      pageInfo: query?.cursor
        ? { limit: 1, offset: 0, hasMore: false, total: 2 }
        : { limit: 1, offset: 0, nextCursor: "second-page", hasMore: true, total: 2 }
    }));
    const hydrateQuoteOutcomes = vi.fn(async (outcomes) => ({
      complete: true,
      attemptedChunks: 1,
      successfulChunks: 1,
      outcomes:
        outcomes[0]?.id === firstCandidate.id
          ? outcomes
          : outcomes.map((outcome: typeof secondCandidate, index: number) => ({
              ...outcome,
              price: index === 0 ? 0.61 : 0.41,
              bestBid: index === 0 ? 0.6 : 0.4,
              bestAsk: index === 0 ? 0.61 : 0.41,
              executablePrice: index === 0 ? 0.61 : 0.41,
              vwapPrice: index === 0 ? 0.61 : 0.41,
              requestedNotionalUsd: 25,
              availableAskNotionalUsd: 100,
              spread: 0.01,
              priceSource: "clob_vwap" as const,
              orderbookTimestamp: now,
              sourceAsOf: now
            }))
    }));
    const app = buildApp({ getPersistedMarketCatalogPage, hydrateQuoteOutcomes });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/markets?limit=1" });

    expect(response.statusCode).toBe(200);
    expect(getPersistedMarketCatalogPage).toHaveBeenCalledTimes(2);
    expect(getPersistedMarketCatalogPage.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ cursor: "second-page", limit: 1, requireFreshOrderBook: false })
    );
    expect(response.json()).toMatchObject({
      outcomes: [
        expect.objectContaining({ id: secondCandidate.id, marketId: secondCandidate.marketId }),
        expect.objectContaining({ id: secondOppositeCandidate.id, marketId: secondCandidate.marketId })
      ],
      pageInfo: { limit: 1, hasMore: false }
    });
  });

  it("removes the entire market when a refreshed side is at the skew boundary", async () => {
    const now = new Date().toISOString();
    const candidates = catalogFixture().outcomes.slice(0, 2).map((outcome, index) => ({
      ...outcome,
      conditionId: "0xskewed",
      tokenId: index === 0 ? "token-yes" : "token-no",
      sourceActive: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      enableOrderBook: true
    }));
    const app = buildApp({
      getPersistedMarketCatalogPage: async () => ({
        ...catalogFixture(),
        outcomes: candidates,
        groups: [],
        pageInfo: { limit: 48, offset: 0, hasMore: false, total: 1 }
      }),
      hydrateQuoteOutcomes: async () => ({
        complete: true,
        attemptedChunks: 1,
        successfulChunks: 1,
        outcomes: candidates.map((outcome, index) => ({
          ...outcome,
          price: index === 0 ? 0.01 : 0.99,
          bestBid: index === 0 ? 0.009 : 0.989,
          bestAsk: index === 0 ? 0.01 : 0.99,
          executablePrice: index === 0 ? 0.01 : 0.99,
          vwapPrice: index === 0 ? 0.01 : 0.99,
          requestedNotionalUsd: 25,
          availableAskNotionalUsd: 100,
          spread: 0.001,
          priceSource: "clob_vwap" as const,
          orderbookTimestamp: now,
          sourceAsOf: now
        }))
      })
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/markets" });

    expect(response.statusCode).toBe(200);
    expect(response.json().outcomes).toEqual([]);
  });

  it("rejects oversized market catalog pages", async () => {
    const app = buildApp({
      getPersistedMarketCatalogPage: async () => ({
        ...catalogFixture(),
        groups: [],
        pageInfo: { limit: 48, offset: 0, hasMore: false }
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/markets?limit=250"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_error" });
  });

  it("returns the authenticated account summary", async () => {
    const app = buildApp({
      getAccountSummary: async (userId) => ({
        balances: [
          {
            accountType: "user_usdc_available",
            currency: "USDC",
            balance: 123.45
          }
        ],
        openTickets: userId === "00000000-0000-0000-0000-000000000001" ? 2 : 0,
        openStakeUsd: 4,
        openPotentialPayoutUsd: 5,
        openNetLiabilityUsd: 3
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/account"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      balances: [
        {
          accountType: "user_usdc_available",
          currency: "USDC",
          balance: 123.45
        }
      ],
      openTickets: 2,
      openNetLiabilityUsd: 3
    });
  });

  it("creates withdrawal requests for the authenticated user", async () => {
    const app = buildApp({
      createWithdrawalRequest: async (input) => {
        expect(input).toMatchObject({
          userId: "00000000-0000-0000-0000-000000000001",
          destinationAddress: "0x1234567890abcdef1234567890abcdef12345678",
          chainId: config.SETTLEMENT_CHAIN_ID
        });
        expect(input.amountMicroUnits).toBe(12_500_000n);
        expect(input.idempotencyKey).toBe("withdrawal-test-1");
        return {
          id: "11111111-1111-4111-8111-111111111111",
          status: "requested",
          requestTransactionId: "22222222-2222-4222-8222-222222222222"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/withdrawals",
      headers: {
        "idempotency-key": "withdrawal-test-1"
      },
      payload: {
        amountUsdc: "12.5",
        destinationAddress: "0x1234567890abcdef1234567890abcdef12345678"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["x-ratelimit-limit"]).toBe("5");
    expect(response.json()).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      status: "requested"
    });
  });

  it("fails closed when the financial gate blocks a withdrawal", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    let withdrawalCalled = false;
    Object.assign(config, { ACCOUNTING_MODE: "house_book_usdc" });
    try {
      const app = buildApp({
        assertFinancialGateOpen: async () => {
          throw new Error("financial_gate_closed:reconciliation_snapshot_stale");
        },
        createWithdrawalRequest: async () => {
          withdrawalCalled = true;
          throw new Error("withdrawal_should_not_be_called");
        }
      });
      openApps.push(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/withdrawals",
        headers: {
          "idempotency-key": "withdrawal-gated-1"
        },
        payload: {
          amountUsdc: "1",
          destinationAddress: "0x1234567890abcdef1234567890abcdef12345678"
        }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: "financial_operations_unavailable"
      });
      expect(withdrawalCalled).toBe(false);
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });

  it("lists withdrawal requests for the authenticated user", async () => {
    const app = buildApp({
      listWithdrawalRequests: async (userId) => {
        expect(userId).toBe("00000000-0000-0000-0000-000000000001");
        return [
          {
            id: "11111111-1111-4111-8111-111111111111",
            status: "requested",
            chainId: 1,
            destinationAddress: "0x1234567890abcdef1234567890abcdef12345678",
            amountUsdc: 12.5,
            createdAt: "2026-07-06T06:00:00.000Z",
            updatedAt: "2026-07-06T06:00:00.000Z"
          }
        ];
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/withdrawals"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      withdrawals: [{ id: "11111111-1111-4111-8111-111111111111", status: "requested" }]
    });
  });

  it("allows a user to cancel an owned withdrawal before a Safe proposal", async () => {
    const app = buildApp({
      cancelWithdrawalRequest: async (input) => {
        expect(input).toEqual({
          withdrawalRequestId: "11111111-1111-4111-8111-111111111111",
          actor: "user",
          userId: "00000000-0000-0000-0000-000000000001",
          reason: undefined
        });
        return {
          id: input.withdrawalRequestId,
          status: "canceled",
          completionTransactionId: "22222222-2222-4222-8222-222222222222",
          result: "canceled"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/withdrawals/11111111-1111-4111-8111-111111111111/cancel",
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "canceled", result: "canceled" });
  });

  it("marks withdrawals sent for operators", async () => {
    const app = buildApp({
      markWithdrawalSent: async (input) => {
        expect(input).toMatchObject({
          id: "withdrawal-test",
          operatorId: "ops-a",
          onchainTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111"
        });
        return {
          id: "withdrawal-test",
          status: "sent",
          completionTransactionId: "33333333-3333-4333-8333-333333333333"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/ops/withdrawals/withdrawal-test/mark-sent",
      headers: {
        "x-operator-id": "ops-a"
      },
      payload: {
        onchainTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "withdrawal-test",
      status: "sent"
    });
  });

  it("records an already-executed verified withdrawal while the financial gate is closed", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    Object.assign(config, { ACCOUNTING_MODE: "house_book_usdc" });
    const markWithdrawalSent = vi.fn(async () => ({
      id: "withdrawal-test",
      status: "sent" as const,
      completionTransactionId: "33333333-3333-4333-8333-333333333333" as const
    }));
    try {
      const app = buildApp({
        assertFinancialGateOpen: async () => {
          throw new Error("financial_gate_closed:treasury_internal_delta");
        },
        markWithdrawalSent
      });
      openApps.push(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/ops/withdrawals/withdrawal-test/mark-sent",
        headers: { "x-operator-id": "ops-a" },
        payload: {
          onchainTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(markWithdrawalSent).toHaveBeenCalledOnce();
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });

  it("builds an auditable Safe withdrawal proposal without broadcasting it", async () => {
    const app = buildApp({
      buildAndPersistSafeWithdrawalProposal: async (input) => {
        expect(input).toEqual({
          withdrawalRequestId: "withdrawal-test",
          operatorId: "ops-a"
        });
        return {
          withdrawalRequestId: input.withdrawalRequestId,
          chainId: 11155111,
          safeAddress: "0x1d4fd58d9fc24c9f3c8da0deb4a05e7d122ef17b",
          tokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
          destinationAddress: "0xce59c7004182098fc430c204e9cd1474be9ee492",
          amountMicroUnits: "1000000",
          tokenTransferCall: {
            to: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
            value: "0",
            data: "0xa9059cbb"
          },
          status: "proposed",
          requestHash: "request-hash-test",
          safeProposalHash: "safe-proposal-hash-test",
          safeApiBroadcast: "disabled",
          safeApiBroadcastReason: "safe_signing_architecture_not_configured"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/ops/withdrawals/withdrawal-test/propose",
      headers: {
        "x-operator-id": "ops-a"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "proposed",
      safeProposalHash: "safe-proposal-hash-test",
      safeApiBroadcast: "disabled"
    });
  });

  it("reports the effective financial gate to operators", async () => {
    const app = buildApp({
      getFinancialGateDecision: async () => ({
        allowed: false,
        launchGate: "blocked",
        operationGate: "blocked",
        reasons: ["reconciliation_snapshot_stale"],
        snapshotId: "snapshot-test",
        snapshotAgeMs: 600_000,
        maxSnapshotAgeMs: 300_000
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/ops/financial-gate"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      gate: {
        allowed: false,
        operationGate: "blocked",
        reasons: ["reconciliation_snapshot_stale"]
      }
    });
  });

  it("returns the latest trusted reconciliation snapshot to operators", async () => {
    const app = buildApp({
      getLatestReconciliationSnapshot: async () => ({
        id: "snapshot-test",
        chainId: 11155111,
        currency: "USDC",
        treasuryAssetsMicroUnits: "14000000",
        internalCustodyMicroUnits: "0",
        userAvailableMicroUnits: "0",
        userClaimableMicroUnits: "0",
        userCheckoutMicroUnits: "0",
        openStakeMicroUnits: "0",
        openReserveMicroUnits: "0",
        pendingWithdrawalMicroUnits: "0",
        houseEquityMicroUnits: "14000000",
        unexplainedDeltaMicroUnits: "14000000",
        launchGate: "blocked",
        operationGate: "blocked",
        gateReasons: ["treasury_internal_delta"],
        treasuryAssets: [],
        metrics: {},
        source: "worker",
        createdAt: "2026-07-14T00:00:00.000Z"
      })
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/ops/reconciliation/latest" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      snapshot: {
        id: "snapshot-test",
        unexplainedDeltaMicroUnits: "14000000",
        gateReasons: ["treasury_internal_delta"]
      }
    });
  });

  it("protects reconciliation snapshots with the production ops bearer and reports an empty history", async () => {
    const previous = { NODE_ENV: config.NODE_ENV, OPS_API_KEY: config.OPS_API_KEY };
    Object.assign(config, { NODE_ENV: "production", OPS_API_KEY: "staging-ops-test-key-12345" });
    try {
      const app = buildApp({ getLatestReconciliationSnapshot: async () => undefined });
      openApps.push(app);

      const unauthorized = await app.inject({
        method: "GET",
        url: "/api/ops/reconciliation/latest",
        headers: { authorization: "Bearer wrong-key" }
      });
      expect(unauthorized.statusCode).toBe(401);

      const missing = await app.inject({
        method: "GET",
        url: "/api/ops/reconciliation/latest",
        headers: { authorization: "Bearer staging-ops-test-key-12345" }
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "reconciliation_snapshot_not_found" });
    } finally {
      Object.assign(config, previous);
    }
  });

  it("returns the authenticated Privy session wallet list", async () => {
    const app = buildApp({
      listUserWallets: async (userId) => [
        {
          id: "wallet-test",
          address: "0x1234567890abcdef1234567890abcdef12345678",
          chainId: config.SETTLEMENT_CHAIN_ID,
          source: "privy",
          verifiedAt: "2026-07-06T06:00:00.000Z",
          userId
        }
      ]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: "00000000-0000-0000-0000-000000000001",
      wallets: [
        {
          address: "0x1234567890abcdef1234567890abcdef12345678",
          chainId: config.SETTLEMENT_CHAIN_ID,
          source: "privy"
        }
      ]
    });
  });

  it("syncs Privy identity-token wallets for the current session", async () => {
    let expectedUserIdFromRoute: string | undefined;
    const app = buildApp({
      syncPrivyIdentityToken: async (_identityToken, expectedUserId) => {
        expectedUserIdFromRoute = expectedUserId;
        return {
          userId: "00000000-0000-0000-0000-000000000001",
          privyUserId: "privy-user-test",
          wallets: [{ address: "0x1234567890abcdef1234567890abcdef12345678", chainId: 1 }]
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/privy/sync",
      payload: {
        identityToken: "identity-token-long-enough-for-test"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBe("8");
    expect(expectedUserIdFromRoute).toBe("00000000-0000-0000-0000-000000000001");
    expect(response.json()).toMatchObject({
      privyUserId: "privy-user-test",
      wallets: [{ address: "0x1234567890abcdef1234567890abcdef12345678", chainId: 1 }]
    });
  });

  it("rejects Privy identity-token sync when it does not match the current session", async () => {
    const app = buildApp({
      syncPrivyIdentityToken: async () => {
        throw new Error("identity_token_user_mismatch");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/privy/sync",
      payload: {
        identityToken: "identity-token-long-enough-for-test"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "identity_token_user_mismatch"
    });
  });

  it("creates server-authored quotes from market outcome ids", async () => {
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture()
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["x-ratelimit-limit"]).toBe("20");
    expect(response.json()).toMatchObject({
      status: "quoted",
      sourceAsOf: "2026-07-05T15:35:20.000Z",
      stakeUsd: betaStakeUsd,
      riskDecision: "accept",
      legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
    });

    const quote = response.json();
    const stored = await app.inject({
      method: "GET",
      url: `/api/quotes/${quote.id}`
    });

    expect(stored.statusCode).toBe(200);
    expect(stored.json().id).toBe(quote.id);
  });

  it("reprices selected quote legs with fresh executable ask prices before quoting", async () => {
    let requestedNotionalUsd: number | undefined;
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture(),
      hydrateQuoteOutcomes: async (outcomes, _signal, options) => {
        requestedNotionalUsd = options?.requestedNotionalUsd;
        return {
        complete: true,
        attemptedChunks: 1,
        successfulChunks: 1,
        outcomes: outcomes.map((outcome) =>
          outcome.id === "btc-up-yes"
            ? {
                ...outcome,
                price: 0.61,
                bestBid: 0.6,
                bestAsk: 0.61,
                priceSource: "clob_ask" as const,
                sourceAsOf: "2026-07-05T15:35:35.000Z"
              }
            : {
                ...outcome,
                price: 0.81,
                bestBid: 0.8,
                bestAsk: 0.81,
                priceSource: "clob_ask" as const,
                sourceAsOf: "2026-07-05T15:35:34.000Z"
              }
        )
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(requestedNotionalUsd).toBe(betaStakeUsd);
    expect(response.json()).toMatchObject({
      status: "quoted",
      sourceAsOf: "2026-07-05T15:35:34.000Z",
      legs: [
        {
          id: "btc-up-yes",
          price: 0.61,
          bestAsk: 0.61,
          priceSource: "clob_ask"
        },
        {
          id: "newsom-no",
          price: 0.81,
          bestAsk: 0.81,
          priceSource: "clob_ask"
        }
      ]
    });
  });

  it("loads selected discovery outcomes exactly before quote-time CLOB hydration", async () => {
    const exactLookup = vi.fn(async (outcomeIds: string[]) => {
      const catalog = catalogFixture();
      return {
        ...catalog,
        outcomes: catalog.outcomes
          .filter((outcome) => outcomeIds.includes(outcome.id))
          .map((outcome) => ({
            ...outcome,
            bestBid: undefined,
            bestAsk: undefined,
            executablePrice: undefined,
            priceSource: "gamma" as const
          }))
      };
    });
    const fallbackCatalog = vi.fn(async () => {
      throw new Error("bounded_catalog_fallback_should_not_run");
    });
    const app = buildApp({
      getMarketCatalog: fallbackCatalog,
      getPersistedMarketOutcomesByIds: exactLookup,
      hydrateQuoteOutcomes: async (outcomes) => ({
        complete: true,
        attemptedChunks: 1,
        successfulChunks: 1,
        outcomes: outcomes.map((outcome) => ({
          ...outcome,
          price: outcome.id === "btc-up-yes" ? 0.61 : 0.81,
          bestBid: outcome.id === "btc-up-yes" ? 0.6 : 0.8,
          bestAsk: outcome.id === "btc-up-yes" ? 0.61 : 0.81,
          executablePrice: outcome.id === "btc-up-yes" ? 0.61 : 0.81,
          priceSource: "clob_ask" as const,
          sourceAsOf: "2026-07-05T15:35:40.000Z"
        }))
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(exactLookup).toHaveBeenCalledWith(
      ["btc-up-yes", "newsom-no"],
      expect.objectContaining({ maxSnapshotAgeMs: expect.any(Number) })
    );
    expect(fallbackCatalog).not.toHaveBeenCalled();
    expect(response.json().legs).toMatchObject([
      { id: "btc-up-yes", price: 0.61, priceSource: "clob_ask" },
      { id: "newsom-no", price: 0.81, priceSource: "clob_ask" }
    ]);
  });

  it("rejects same-event quote requests until server-side same-event pricing exists", async () => {
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture()
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "usa-no" }, { id: "morocco-yes" }]
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      status: "rejected",
      riskDecision: "reject"
    });
    expect(response.json().riskChecks[0]).toMatchObject({
      level: "block",
      label: "Event group"
    });
  });

  it("rejects direct API requests with multiple outcomes from one market", async () => {
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture()
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "btc-up-yes" }, { id: "btc-up-no" }]
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      status: "rejected",
      riskDecision: "reject"
    });
    expect(response.json().riskChecks[0]).toMatchObject({
      level: "block",
      label: "Market selection"
    });
  });

  it("rejects unknown market outcome ids", async () => {
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture()
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "btc-up-yes" }, { id: "missing" }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "unknown_market_outcome"
    });
  });

  it("replays completed idempotent quote requests", async () => {
    const app = buildApp({
      reserveIdempotencyKey: async () => ({
        kind: "replay",
        responseStatus: 201,
        responseBody: {
          id: "quote-replayed",
          status: "quoted"
        }
      }),
      getMarketCatalog: async () => {
        throw new Error("catalog_should_not_load_for_replay");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      headers: {
        "idempotency-key": "quote-replay-test"
      },
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["idempotency-replayed"]).toBe("true");
    expect(response.json()).toMatchObject({
      id: "quote-replayed",
      status: "quoted"
    });
  });

  it("rejects conflicting idempotency keys", async () => {
    const app = buildApp({
      reserveIdempotencyKey: async () => ({
        kind: "conflict"
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      headers: {
        "idempotency-key": "quote-conflict-test"
      },
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "idempotency_key_conflict"
    });
  });

  it("rejects malformed idempotency keys", async () => {
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture()
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      headers: {
        "idempotency-key": "bad key"
      },
      payload: {
        stakeUsd: betaStakeUsd,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_idempotency_key"
    });
  });

  it("accepts persisted quotes through the ticket endpoint", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    Object.assign(config, { ACCOUNTING_MODE: "play_money" });
    const app = buildApp({
      acceptQuote: async (quoteId, userId) => ({
        ticketId: "ticket-test",
        quoteId: `${quoteId}:${userId}`,
        status: "accepted",
        ledgerTransactionId: "ledger-test",
        accountingMode: "play_money",
        currency: "USD"
      })
    });
    openApps.push(app);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/quotes/quote-test/accept"
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        ticketId: "ticket-test",
        quoteId: "quote-test:00000000-0000-0000-0000-000000000001",
        status: "accepted",
        ledgerTransactionId: "ledger-test"
      });
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });

  it("creates USDC payment intents for quoted baskets", async () => {
    const app = buildApp({
      getActiveTreasuryConfig: async () => ({
        id: "treasury-config-test",
        chainId: 1,
        currency: "USDC",
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        requiredConfirmations: 12,
        updatedAt: "2026-07-06T06:00:00.000Z"
      }),
      createQuotePaymentIntent: async (input) => {
        expect(input).toMatchObject({
          quoteId: "quote-test",
          userId: "00000000-0000-0000-0000-000000000001",
          treasuryConfig: {
            chainId: 1,
            treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678"
          }
        });
        return {
          id: "payment-intent-test",
          quoteId: "quote-test",
          userId: input.userId,
          chainId: config.SETTLEMENT_CHAIN_ID,
          currency: "USDC",
          treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
          usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          amountMicroUnits: betaPaymentAmountMicroUnits,
          amountUsdc: betaAmountPaidUsd,
          requiredConfirmations: 12,
          status: "pending",
          expiresAt: "2026-07-06T06:20:00.000Z",
          createdAt: "2026-07-06T06:00:00.000Z",
          updatedAt: "2026-07-06T06:00:00.000Z"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-intent"
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["x-ratelimit-limit"]).toBe("10");
    expect(response.json()).toMatchObject({
      id: "payment-intent-test",
      quoteId: "quote-test",
      amountUsdc: betaAmountPaidUsd,
      status: "pending"
    });
  });

  it("does not enter payment-intent persistence when the financial gate is closed", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    const createPaymentIntent = vi.fn();
    const loadTreasury = vi.fn();
    Object.assign(config, { ACCOUNTING_MODE: "house_book_usdc" });
    try {
      const app = buildApp({
        assertFinancialGateOpen: async () => {
          throw new Error("financial_gate_closed:treasury_internal_delta");
        },
        getActiveTreasuryConfig: loadTreasury,
        createQuotePaymentIntent: createPaymentIntent
      });
      openApps.push(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/quotes/quote-test/payment-intent"
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: "financial_operations_unavailable",
        detail: "financial_gate_closed:treasury_internal_delta"
      });
      expect(loadTreasury).not.toHaveBeenCalled();
      expect(createPaymentIntent).not.toHaveBeenCalled();
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });

  it("submits payment transaction hashes for quote payment intents", async () => {
    const txHash = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const app = buildApp({
      submitQuotePaymentTransaction: async (input) => {
        expect(input).toMatchObject({
          quoteId: "quote-test",
          userId: "00000000-0000-0000-0000-000000000001",
          txHash
        });
        return {
          id: "payment-intent-test",
          quoteId: "quote-test",
          userId: input.userId,
          chainId: 1,
          currency: "USDC",
          treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
          usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          amountMicroUnits: betaPaymentAmountMicroUnits,
          amountUsdc: betaAmountPaidUsd,
          requiredConfirmations: 12,
          status: "submitted",
          txHash,
          expiresAt: "2026-07-06T06:20:00.000Z",
          createdAt: "2026-07-06T06:00:00.000Z",
          updatedAt: "2026-07-06T06:01:00.000Z"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-transaction",
      payload: { txHash }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBe("10");
    expect(response.json()).toMatchObject({
      status: "submitted",
      txHash
    });
  });

  it("maps expired payment intent transaction submissions to 409", async () => {
    const app = buildApp({
      submitQuotePaymentTransaction: async () => {
        throw new Error("payment_intent_expired");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-transaction",
      payload: {
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "payment_intent_expired"
    });
  });

  it("maps conflicting payment transaction hash resubmissions to 409", async () => {
    const app = buildApp({
      submitQuotePaymentTransaction: async () => {
        throw new Error("payment_intent_tx_hash_conflict");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-transaction",
      payload: {
        txHash: "0x2222222222222222222222222222222222222222222222222222222222222222"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "payment_intent_tx_hash_conflict"
    });
  });

  it("maps non-submittable payment intents to 409", async () => {
    const app = buildApp({
      submitQuotePaymentTransaction: async () => {
        throw new Error("payment_intent_not_submittable");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-transaction",
      payload: {
        txHash: "0x3333333333333333333333333333333333333333333333333333333333333333"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "payment_intent_not_submittable"
    });
  });

  it("lists submitted quote payments before ticket activation", async () => {
    const txHash = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const app = buildApp({
      listPendingQuotePayments: async (userId) => {
        expect(userId).toBe("00000000-0000-0000-0000-000000000001");
        return [
          {
            id: "payment-intent-test",
            quoteId: "quote-test",
            status: "submitted",
            txHash,
            chainId: 11155111,
            amountPaidUsd: betaAmountPaidUsd,
            potentialPayoutUsd: betaPotentialPayoutUsd,
            legs: 2,
            createdAt: "2026-07-08T00:00:00.000Z",
            updatedAt: "2026-07-08T00:01:00.000Z"
          }
        ];
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/payment-intents"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      paymentIntents: [
        {
          id: "payment-intent-test",
          quoteId: "quote-test",
          status: "submitted",
          amountPaidUsd: betaAmountPaidUsd,
          potentialPayoutUsd: betaPotentialPayoutUsd,
          legs: 2
        }
      ]
    });
  });

  it("keeps payment activation pending until the transfer is confirmed", async () => {
    const app = buildApp({
      acceptQuote: async () => {
        throw new Error("accept_should_not_be_called");
      },
      markQuotePaymentActivated: async () => {
        throw new Error("mark_should_not_be_called");
      },
      getQuotePaymentIntent: async () => ({
        id: "payment-intent-test",
        quoteId: "quote-test",
        userId: "00000000-0000-0000-0000-000000000001",
        chainId: 1,
        currency: "USDC",
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amountMicroUnits: betaPaymentAmountMicroUnits,
        amountUsdc: betaAmountPaidUsd,
        requiredConfirmations: 12,
        status: "submitted",
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        expiresAt: "2026-07-06T06:20:00.000Z",
        createdAt: "2026-07-06T06:00:00.000Z",
        updatedAt: "2026-07-06T06:01:00.000Z"
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-activate"
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "payment_pending"
    });
  });

  it("returns recoverable payment intents as a conflict without retrying activation", async () => {
    let acceptCalled = false;
    const app = buildApp({
      markQuotePaymentActivated: async () => {
        throw new Error("mark_should_not_be_called");
      },
      getQuotePaymentIntent: async () => ({
        id: "payment-intent-test",
        quoteId: "quote-test",
        userId: "00000000-0000-0000-0000-000000000001",
        chainId: 1,
        currency: "USDC",
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amountMicroUnits: betaPaymentAmountMicroUnits,
        amountUsdc: betaAmountPaidUsd,
        requiredConfirmations: 12,
        status: "recoverable",
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        recoveryReason: "requote_adverse",
        expiresAt: "2026-07-06T06:20:00.000Z",
        createdAt: "2026-07-06T06:00:00.000Z",
        updatedAt: "2026-07-06T06:01:00.000Z"
      }),
      acceptQuote: async () => {
        acceptCalled = true;
        throw new Error("accept_should_not_be_called");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-activate"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      status: "recoverable",
      error: "payment_intent_recoverable",
      reason: "requote_adverse",
      paymentIntent: {
        id: "payment-intent-test",
        status: "recoverable",
        recoveryReason: "requote_adverse"
      }
    });
    expect(acceptCalled).toBe(false);
  });

  it("activates confirmed USDC payment intents into tickets", async () => {
    const app = buildApp({
      getQuotePaymentIntent: async () => ({
        id: "payment-intent-test",
        quoteId: "quote-test",
        userId: "00000000-0000-0000-0000-000000000001",
        chainId: 1,
        currency: "USDC",
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amountMicroUnits: betaPaymentAmountMicroUnits,
        amountUsdc: betaAmountPaidUsd,
        requiredConfirmations: 12,
        status: "confirmed",
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        expiresAt: "2026-07-06T06:20:00.000Z",
        createdAt: "2026-07-06T06:00:00.000Z",
        updatedAt: "2026-07-06T06:01:00.000Z"
      }),
      acceptQuote: async (quoteId, userId, options) => {
        expect(options).toMatchObject({
          accountingMode: "house_book_usdc",
          currency: "USDC"
        });
        expect(options?.allowExpiredQuote).toBeUndefined();
        return {
          ticketId: "ticket-test",
          quoteId: `${quoteId}:${userId}`,
          status: "accepted",
          ledgerTransactionId: "ledger-test",
          reserveTransactionId: "reserve-test",
          accountingMode: "house_book_usdc",
          currency: "USDC"
        };
      },
      markQuotePaymentActivated: async (input) => {
        expect(input).toMatchObject({
          quoteId: "quote-test",
          userId: "00000000-0000-0000-0000-000000000001",
          ticketId: "ticket-test"
        });
        return {
          id: "payment-intent-test",
          quoteId: input.quoteId,
          userId: input.userId,
          chainId: 1,
          currency: "USDC",
          treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
          usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          amountMicroUnits: betaPaymentAmountMicroUnits,
          amountUsdc: betaAmountPaidUsd,
          requiredConfirmations: 12,
          status: "activated",
          ticketId: input.ticketId,
          expiresAt: "2026-07-06T06:20:00.000Z",
          createdAt: "2026-07-06T06:00:00.000Z",
          updatedAt: "2026-07-06T06:02:00.000Z"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-activate"
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["x-ratelimit-limit"]).toBe("10");
    expect(response.json()).toMatchObject({
      ticketId: "ticket-test",
      status: "accepted",
      accountingMode: "house_book_usdc",
      currency: "USDC"
    });
  });

  it("does not activate confirmed payments into expired quotes", async () => {
    const app = buildApp({
      getQuotePaymentIntent: async () => ({
        id: "payment-intent-test",
        quoteId: "quote-test",
        userId: "00000000-0000-0000-0000-000000000001",
        chainId: 1,
        currency: "USDC",
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amountMicroUnits: betaPaymentAmountMicroUnits,
        amountUsdc: betaAmountPaidUsd,
        requiredConfirmations: 12,
        status: "confirmed",
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        expiresAt: "2026-07-06T06:20:00.000Z",
        createdAt: "2026-07-06T06:00:00.000Z",
        updatedAt: "2026-07-06T06:01:00.000Z"
      }),
      acceptQuote: async () => {
        throw new Error("quote_expired");
      },
      markQuotePaymentActivated: async () => {
        throw new Error("mark_should_not_be_called");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-activate"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "quote_expired"
    });
  });

  it("returns the existing ticket when payment activation is retried after activation", async () => {
    let acceptCalled = false;
    let markCalled = false;
    const app = buildApp({
      getQuotePaymentIntent: async () => ({
        id: "payment-intent-test",
        quoteId: "quote-test",
        userId: "00000000-0000-0000-0000-000000000001",
        chainId: 1,
        currency: "USDC",
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amountMicroUnits: betaPaymentAmountMicroUnits,
        amountUsdc: betaAmountPaidUsd,
        requiredConfirmations: 12,
        status: "activated",
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        ticketId: "ticket-test",
        expiresAt: "2026-07-06T06:20:00.000Z",
        createdAt: "2026-07-06T06:00:00.000Z",
        updatedAt: "2026-07-06T06:03:00.000Z"
      }),
      getTicket: async (ticketId, userId) => {
        expect(ticketId).toBe("ticket-test");
        expect(userId).toBe("00000000-0000-0000-0000-000000000001");
        return {
          ticketId,
          quoteId: "quote-test",
          status: "accepted",
          createdAt: "2026-07-06T06:02:00.000Z",
          updatedAt: "2026-07-06T06:02:00.000Z",
          stakeUsd: betaStakeUsd,
          operationFeeUsd: betaOperationFeeUsd,
          amountPaidUsd: betaAmountPaidUsd,
          potentialPayoutUsd: betaPotentialPayoutUsd,
          claimableAmountUsd: betaPotentialPayoutUsd,
          accountingMode: "house_book_usdc",
          currency: "USDC",
          legs: []
        };
      },
      acceptQuote: async () => {
        acceptCalled = true;
        throw new Error("accept_should_not_be_called");
      },
      markQuotePaymentActivated: async () => {
        markCalled = true;
        throw new Error("mark_should_not_be_called");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/quote-test/payment-activate"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBe("10");
    expect(response.json()).toMatchObject({
      ticketId: "ticket-test",
      quoteId: "quote-test",
      status: "accepted"
    });
    expect(acceptCalled).toBe(false);
    expect(markCalled).toBe(false);
  });

  it("maps missing quotes to 404 on accept", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    Object.assign(config, { ACCOUNTING_MODE: "play_money" });
    const app = buildApp({
      acceptQuote: async () => {
        throw new Error("quote_not_found");
      }
    });
    openApps.push(app);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/quotes/missing/accept"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: "quote_not_found"
      });
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });

  it("lists persisted tickets", async () => {
    const app = buildApp({
      listTickets: async () => [
        {
          ticketId: "ticket-test",
          quoteId: "quote-test",
          status: "accepted",
          createdAt: "2026-07-05T15:35:28.638Z",
          updatedAt: "2026-07-05T15:35:28.638Z",
          stakeUsd: betaStakeUsd,
          operationFeeUsd: betaOperationFeeUsd,
          amountPaidUsd: betaAmountPaidUsd,
          potentialPayoutUsd: betaPotentialPayoutUsd,
          claimableAmountUsd: betaPotentialPayoutUsd,
          accountingMode: "house_book_usdc",
          currency: "USDC",
          legs: 2,
          legStatusCounts: {
            pending: 2,
            won: 0,
            lost: 0,
            voided: 0,
            disputed: 0
          }
        }
      ]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/tickets"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tickets: [
        {
          ticketId: "ticket-test",
          quoteId: "quote-test",
          status: "accepted",
          stakeUsd: betaStakeUsd,
          amountPaidUsd: betaAmountPaidUsd,
          potentialPayoutUsd: betaPotentialPayoutUsd,
          legs: 2,
          legStatusCounts: {
            pending: 2
          }
        }
      ]
    });
  });

  it("lists claimable tickets with a bounded cursor page", async () => {
    let receivedUserId: string | undefined;
    let receivedQuery: unknown;
    const app = buildApp({
      listClaimableTickets: async (userId, query) => {
        receivedUserId = userId;
        receivedQuery = query;
        return {
          tickets: [
            {
              ticketId: "00000000-0000-4000-8000-000000000001",
              quoteId: "quote-test",
              status: "claimable",
              createdAt: "2026-07-05T15:35:28.638Z",
              updatedAt: "2026-07-05T15:36:28.638Z",
              stakeUsd: betaStakeUsd,
              operationFeeUsd: betaOperationFeeUsd,
              amountPaidUsd: betaAmountPaidUsd,
              potentialPayoutUsd: betaPotentialPayoutUsd,
              claimableAmountUsd: betaPotentialPayoutUsd,
              accountingMode: "house_book_usdc",
              currency: "USDC",
              legs: 2,
              legStatusCounts: { pending: 0, won: 2, lost: 0, voided: 0, disputed: 0 }
            }
          ],
          pageInfo: {
            limit: query.limit,
            hasMore: true,
            nextCursor: "eyJjcmVhdGVkQXQiOiIyMDI2LTA3LTA1VDE1OjM1OjI4LjYzOFoiLCJ0aWNrZXRJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJ9"
          }
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/tickets/claimable?limit=24"
    });

    expect(response.statusCode).toBe(200);
    expect(receivedUserId).toBe("00000000-0000-0000-0000-000000000001");
    expect(receivedQuery).toEqual({ cursor: undefined, limit: 24 });
    expect(response.json()).toMatchObject({
      tickets: [{ status: "claimable", claimableAmountUsd: betaPotentialPayoutUsd }],
      pageInfo: { limit: 24, hasMore: true }
    });
  });

  it("rejects malformed claimable ticket cursors before querying tickets", async () => {
    let called = false;
    const app = buildApp({
      listClaimableTickets: async () => {
        called = true;
        throw new Error("should_not_query_claimable_tickets");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/tickets/claimable?cursor=not-a-cursor"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_claimable_ticket_cursor" });
    expect(called).toBe(false);
  });

  it("returns ticket detail with leg statuses", async () => {
    const app = buildApp({
      getTicket: async (ticketId) => ({
        ticketId,
        quoteId: "quote-test",
        status: "live",
        createdAt: "2026-07-05T15:35:28.638Z",
        updatedAt: "2026-07-05T15:36:28.638Z",
        stakeUsd: betaStakeUsd,
        operationFeeUsd: betaOperationFeeUsd,
        amountPaidUsd: betaAmountPaidUsd,
        potentialPayoutUsd: betaPotentialPayoutUsd,
        claimableAmountUsd: betaPotentialPayoutUsd,
        accountingMode: "house_book_usdc",
        currency: "USDC",
        purchaseTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        purchaseChainId: 11155111,
        legs: [
          {
            ticketLegId: "ticket-leg-test",
            status: "pending",
            question: "Will test pass?",
            outcome: "Yes",
            marketUrl: "https://polymarket.com/event/test"
          }
        ]
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/tickets/ticket-test"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ticketId: "ticket-test",
      status: "live",
      amountPaidUsd: betaAmountPaidUsd,
      purchaseTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      purchaseChainId: 11155111,
      legs: [
        {
          ticketLegId: "ticket-leg-test",
          status: "pending"
        }
      ]
    });
  });

  it("returns 404 for missing ticket detail", async () => {
    const app = buildApp({
      getTicket: async () => undefined
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/tickets/missing"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "ticket_not_found"
    });
  });

  it("claims a settled ticket into the authenticated user's available balance", async () => {
    const app = buildApp({
      claimTicketToAvailable: async (input) => {
        expect(input).toEqual({
          ticketId: "ticket-test",
          userId: "00000000-0000-0000-0000-000000000001",
          idempotencyKey: "ticket-claim-test-1"
        });
        return {
          ticketId: input.ticketId,
          userId: input.userId,
          status: "claimed",
          ticketStatus: "paid",
          amountMicroUnits: "4000000",
          currency: "USDC",
          ledgerTransactionId: "11111111-1111-4111-8111-111111111111",
          idempotencyKey: input.idempotencyKey
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/tickets/ticket-test/claim",
      headers: {
        "idempotency-key": "ticket-claim-test-1"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["x-ratelimit-limit"]).toBe("8");
    expect(response.json()).toMatchObject({
      ticketId: "ticket-test",
      status: "claimed",
      ticketStatus: "paid",
      amountMicroUnits: "4000000",
      currency: "USDC"
    });
  });

  it("allows a completed claim replay to reach the repository while the financial gate is closed", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    Object.assign(config, { ACCOUNTING_MODE: "house_book_usdc" });
    const claimTicketToAvailable = vi.fn(async (input: { ticketId: string; userId: string; idempotencyKey: string }) => ({
      ticketId: input.ticketId,
      userId: input.userId,
      status: "already_claimed" as const,
      ticketStatus: "paid" as const,
      amountMicroUnits: "4000000",
      currency: "USDC",
      ledgerTransactionId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: input.idempotencyKey
    }));
    try {
      const app = buildRawApp({
        assertFinancialGateOpen: async () => {
          throw new Error("financial_gate_closed:test");
        },
        claimTicketToAvailable
      });
      openApps.push(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/tickets/ticket-test/claim",
        headers: { "idempotency-key": "ticket-claim-replay" }
      });

      expect(response.statusCode).toBe(200);
      expect(claimTicketToAvailable).toHaveBeenCalledOnce();
      expect(response.json()).toMatchObject({ status: "already_claimed" });
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });

  it("requires an idempotency key before claiming a ticket", async () => {
    let claimCalled = false;
    const app = buildApp({
      claimTicketToAvailable: async () => {
        claimCalled = true;
        throw new Error("claim_should_not_be_called");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/tickets/ticket-test/claim"
    });

    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({
      error: "idempotency_key_required"
    });
    expect(claimCalled).toBe(false);
  });

  it("does not claim a ticket that has not reached claimable status", async () => {
    const app = buildApp({
      claimTicketToAvailable: async () => {
        throw new Error("ticket_not_claimable");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/tickets/ticket-test/claim",
      headers: {
        "idempotency-key": "ticket-claim-test-2"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "ticket_not_claimable"
    });
  });

  it("lists open market exposure for operators", async () => {
    const app = buildApp({
      listOpenMarketExposure: async () => [
        {
          marketId: "market-test",
          sourceMarketId: "source-market-test",
          question: "Will test pass?",
          marketUrl: "https://polymarket.com/event/test",
          outcome: "Yes",
          openTickets: 1,
          openPaymentIntents: 0,
          worstCaseLiabilityUsd: 123.45
        }
      ]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/ops/exposure"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBe("30");
    expect(response.json()).toMatchObject({
      markets: [
        {
          marketId: "market-test",
          openTickets: 1,
          openPaymentIntents: 0,
          worstCaseLiabilityUsd: 123.45
        }
      ]
    });
  });

  it("does not expose the staging bankroll funding route", async () => {
    const app = buildApp();
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/ops/bankroll/fund",
      headers: {
        "x-operator-id": "ops-a"
      },
      payload: {
        amountUsdc: 500,
        reason: "Seed Sepolia closed beta reserves",
        reference: "safe-tx-test"
      }
    });

    expect(response.statusCode).toBe(404);
  });

  it("keeps the production staging treasury static even when database mutation handlers are present", async () => {
    const previous = {
      NODE_ENV: config.NODE_ENV,
      OPS_API_KEY: config.OPS_API_KEY,
      TREASURY_SAFE_ADDRESS: config.TREASURY_SAFE_ADDRESS
    };
    const proposeTreasuryConfigChange = vi.fn();
    Object.assign(config, {
      NODE_ENV: "production",
      OPS_API_KEY: "staging-ops-test-key-12345",
      TREASURY_SAFE_ADDRESS: "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B"
    });
    try {
      const app = buildApp({ proposeTreasuryConfigChange });
      openApps.push(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/ops/treasury/config",
        headers: { authorization: "Bearer staging-ops-test-key-12345", "x-operator-id": "ops-a" },
        payload: {
          treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
          reason: "Attempt a runtime staging change"
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "treasury_config_mutation_disabled" });
      expect(proposeTreasuryConfigChange).not.toHaveBeenCalled();
    } finally {
      Object.assign(config, previous);
    }
  });

  it("creates a pending treasury config change for operators", async () => {
    const app = buildApp({
      proposeTreasuryConfigChange: async (input) => {
        expect(input).toMatchObject({
          chainId: config.SETTLEMENT_CHAIN_ID,
          currency: "USDC",
          treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
          requestedBy: "ops-a",
          reason: "Switch to initial Safe treasury"
        });
        return {
          id: "treasury-change-test",
          status: "pending"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/ops/treasury/config",
      headers: {
        "x-operator-id": "ops-a"
      },
      payload: {
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        reason: "Switch to initial Safe treasury"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      id: "treasury-change-test",
      status: "pending"
    });
  });

  it("applies a pending treasury config change with second-operator approval", async () => {
    const app = buildApp({
      approveTreasuryConfigChange: async (input) => {
        expect(input).toMatchObject({
          id: "treasury-change-test",
          approvedBy: "ops-b",
          reason: "Second approval for Safe treasury"
        });
        return {
          id: "treasury-change-test",
          status: "applied",
          configId: "treasury-config-test"
        };
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/ops/treasury/config/treasury-change-test/approve",
      headers: {
        "x-operator-id": "ops-b"
      },
      payload: {
        reason: "Second approval for Safe treasury"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "treasury-change-test",
      status: "applied",
      configId: "treasury-config-test"
    });
  });

  it("returns treasury config for operators", async () => {
    const app = buildApp({
      getActiveTreasuryConfig: async () => ({
        id: "treasury-config-test",
        chainId: 1,
        currency: "USDC",
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        requiredConfirmations: 12,
        updatedAt: "2026-07-06T06:00:00.000Z"
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/ops/treasury/config"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      config: {
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        currency: "USDC"
      }
    });
  });

  it("lists pending settlement legs for operators", async () => {
    const app = buildApp({
      listPendingSettlementLegs: async () => [
        {
          ticketLegId: "ticket-leg-test",
          ticketId: "ticket-test",
          quoteId: "quote-test",
          question: "Will test settle?",
          outcome: "Yes",
          marketUrl: "https://polymarket.com/event/test",
          status: "pending",
          ticketStatus: "live",
          createdAt: "2026-07-05T15:35:28.638Z"
        }
      ]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/ops/settlements/pending"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      legs: [
        {
          ticketLegId: "ticket-leg-test",
          status: "pending"
        }
      ]
    });
  });

  it("lists actionable settlement alerts for operators with a bounded limit", async () => {
    const listAlerts = vi.fn(async () => [
      {
        id: "incident-test",
        severity: "critical" as const,
        ticketLegId: "ticket-leg-test",
        ticketId: "ticket-test",
        resolutionState: "settlement_blocked",
        reason: "settlement_blocked" as const,
        resolutionAttempts: 4,
        createdAt: "2026-07-14T00:00:00.000Z"
      }
    ]);
    const app = buildApp({ listOpenSettlementOperationalAlerts: listAlerts });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/ops/settlements/alerts?limit=25"
    });

    expect(response.statusCode).toBe(200);
    expect(listAlerts).toHaveBeenCalledWith(25);
    expect(response.json()).toMatchObject({
      alerts: [
        {
          id: "incident-test",
          severity: "critical",
          ticketLegId: "ticket-leg-test"
        }
      ]
    });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/ops/settlements/alerts?limit=501"
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("requires operator authorization before reading settlement alerts", async () => {
    const previous = { NODE_ENV: config.NODE_ENV, OPS_API_KEY: config.OPS_API_KEY };
    Object.assign(config, { NODE_ENV: "production", OPS_API_KEY: "staging-ops-test-key-12345" });
    const listAlerts = vi.fn(async () => []);
    const app = buildApp({ listOpenSettlementOperationalAlerts: listAlerts });
    openApps.push(app);

    try {
      const response = await app.inject({ method: "GET", url: "/api/ops/settlements/alerts" });
      expect(response.statusCode).toBe(401);
      expect(listAlerts).not.toHaveBeenCalled();
    } finally {
      Object.assign(config, previous);
    }
  });

  it("lists settlement proofs for operators", async () => {
    const app = buildApp({
      listSettlementProofs: async (ticketLegId, limit) => [
        {
          id: "proof-test",
          ticketLegId,
          source: "polymarket_clob",
          proofKind: "clob_market_winner",
          result: "won",
          confidence: "api_signal",
          conditionId: "condition-test",
          tokenId: "token-test",
          winningTokenId: "token-test",
          checkedAt: "2026-07-05T15:40:28.638Z",
          createdAt: "2026-07-05T15:40:28.638Z",
          raw: {
            limit
          }
        }
      ]
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/ops/ticket-legs/ticket-leg-test/proofs?limit=10"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      proofs: [
        {
          id: "proof-test",
          ticketLegId: "ticket-leg-test",
          proofKind: "clob_market_winner",
          result: "won",
          raw: {
            limit: 10
          }
        }
      ]
    });
  });

  it("rejects manual settlement authority in house-book mode", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    Object.assign(config, { ACCOUNTING_MODE: "house_book_usdc" });
    let settlementCalled = false;
    const app = buildApp({
      recordLegSettlement: async () => {
        settlementCalled = true;
        throw new Error("settlement_should_not_be_called");
      }
    });
    openApps.push(app);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ops/ticket-legs/ticket-leg-test/settle",
        payload: {
          result: "won",
          proofReference: "manual://test"
        }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "verified_settlement_authority_required"
      });
      expect(settlementCalled).toBe(false);
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });

  it("maps conflicting play-money settlement results to 409", async () => {
    const previousAccountingMode = config.ACCOUNTING_MODE;
    Object.assign(config, { ACCOUNTING_MODE: "play_money" });
    const app = buildApp({
      recordLegSettlement: async () => {
        throw new Error("settlement_conflict:won");
      }
    });
    openApps.push(app);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ops/ticket-legs/ticket-leg-test/settle",
        payload: {
          result: "lost"
        }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "settlement_conflict"
      });
    } finally {
      Object.assign(config, { ACCOUNTING_MODE: previousAccountingMode });
    }
  });
});
