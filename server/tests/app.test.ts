import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { config } from "../config";
import { applyAdditionalRiskChecks, clearQuoteStore } from "../quoteService";

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
  it("applies additional exposure risk blocks to quotes", () => {
    const quote = {
      id: "quote-test",
      status: "quoted" as const,
      createdAt: "2026-07-05T15:35:28.638Z",
      expiresAt: "2026-07-05T15:35:43.638Z",
      sourceAsOf: "2026-07-05T15:35:28.638Z",
      stakeUsd: 25,
      operationFeeUsd: 2,
      totalCostUsd: 27,
      basketPrice: 0.25,
      basketProbability: 0.25,
      quoteSpread: 0.1,
      payoutMultiple: 3.6,
      potentialPayoutUsd: 90,
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
      stakeUsd: 25,
      operationFeeUsd: 2,
      totalCostUsd: 27,
      basketPrice: 0.25,
      basketProbability: 0.25,
      quoteSpread: 0.1,
      payoutMultiple: 3.6,
      potentialPayoutUsd: 90,
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
    expect(warned.potentialPayoutUsd).toBe(90);
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
        openStakeUsd: 50,
        openPotentialPayoutUsd: 300,
        openNetLiabilityUsd: 250
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
      openNetLiabilityUsd: 250
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
      payload: {
        amountUsdc: 12.5,
        destinationAddress: "0x1234567890abcdef1234567890abcdef12345678"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      status: "requested"
    });
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
        stakeUsd: 25,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "quoted",
      sourceAsOf: "2026-07-05T15:35:20.000Z",
      stakeUsd: 25,
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
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture(),
      hydrateQuoteOutcomes: async (outcomes) => ({
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
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      payload: {
        stakeUsd: 25,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(201);
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

  it("rejects same-event quote requests until server-side same-event pricing exists", async () => {
    const app = buildApp({
      getMarketCatalog: async () => catalogFixture()
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes",
      payload: {
        stakeUsd: 25,
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
        stakeUsd: 25,
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
        stakeUsd: 25,
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
        stakeUsd: 25,
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
        stakeUsd: 25,
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
        stakeUsd: 25,
        legs: [{ id: "btc-up-yes" }, { id: "newsom-no" }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_idempotency_key"
    });
  });

  it("accepts persisted quotes through the ticket endpoint", async () => {
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
          amountMicroUnits: "27000000",
          amountUsdc: 27,
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
    expect(response.json()).toMatchObject({
      id: "payment-intent-test",
      quoteId: "quote-test",
      amountUsdc: 27,
      status: "pending"
    });
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
          amountMicroUnits: "27000000",
          amountUsdc: 27,
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
            amountPaidUsd: 27,
            potentialPayoutUsd: 100,
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
          amountPaidUsd: 27,
          potentialPayoutUsd: 100,
          legs: 2
        }
      ]
    });
  });

  it("keeps payment activation pending until the transfer is confirmed", async () => {
    const app = buildApp({
      getQuotePaymentIntent: async () => ({
        id: "payment-intent-test",
        quoteId: "quote-test",
        userId: "00000000-0000-0000-0000-000000000001",
        chainId: 1,
        currency: "USDC",
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        amountMicroUnits: "27000000",
        amountUsdc: 27,
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
        amountMicroUnits: "27000000",
        amountUsdc: 27,
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
          amountMicroUnits: "27000000",
          amountUsdc: 27,
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
        amountMicroUnits: "27000000",
        amountUsdc: 27,
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
        amountMicroUnits: "27000000",
        amountUsdc: 27,
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
          stakeUsd: 25,
          operationFeeUsd: 2,
          amountPaidUsd: 27,
          potentialPayoutUsd: 100,
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
    expect(response.json()).toMatchObject({
      ticketId: "ticket-test",
      quoteId: "quote-test",
      status: "accepted"
    });
    expect(acceptCalled).toBe(false);
    expect(markCalled).toBe(false);
  });

  it("maps missing quotes to 404 on accept", async () => {
    const app = buildApp({
      acceptQuote: async () => {
        throw new Error("quote_not_found");
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/quotes/missing/accept"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "quote_not_found"
    });
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
          stakeUsd: 25,
          operationFeeUsd: 2,
          amountPaidUsd: 27,
          potentialPayoutUsd: 100,
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
          stakeUsd: 25,
          amountPaidUsd: 27,
          potentialPayoutUsd: 100,
          legs: 2,
          legStatusCounts: {
            pending: 2
          }
        }
      ]
    });
  });

  it("returns ticket detail with leg statuses", async () => {
    const app = buildApp({
      getTicket: async (ticketId) => ({
        ticketId,
        quoteId: "quote-test",
        status: "live",
        createdAt: "2026-07-05T15:35:28.638Z",
        updatedAt: "2026-07-05T15:36:28.638Z",
        stakeUsd: 25,
        operationFeeUsd: 2,
        amountPaidUsd: 27,
        potentialPayoutUsd: 100,
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
      amountPaidUsd: 27,
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
    expect(response.json()).toMatchObject({
      markets: [
        {
          marketId: "market-test",
          openTickets: 1,
          worstCaseLiabilityUsd: 123.45
        }
      ]
    });
  });

  it("funds house bankroll through an operator-only audited route", async () => {
    const app = buildApp({
      fundHouseBankroll: async (input) => {
        expect(input).toMatchObject({
          amountUsdc: 500,
          operatorId: "ops-a",
          reason: "Seed Sepolia closed beta reserves",
          reference: "safe-tx-test"
        });
        return {
          transactionId: "00000000-0000-0000-0000-000000000abc",
          currency: "USDC",
          amountUsdc: 500,
          houseOperatingBalanceUsdc: 500
        };
      }
    });
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

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      currency: "USDC",
      amountUsdc: 500,
      houseOperatingBalanceUsdc: 500
    });
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

  it("records manual settlement results for operators", async () => {
    const app = buildApp({
      recordLegSettlement: async (input) => ({
        ticketLegId: input.ticketLegId,
        ticketId: "ticket-test",
        legStatus: input.result,
        ticketStatus: "won"
      })
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/ops/ticket-legs/ticket-leg-test/settle",
      payload: {
        result: "won",
        proofReference: "manual://test"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ticketLegId: "ticket-leg-test",
      ticketId: "ticket-test",
      legStatus: "won",
      ticketStatus: "won"
    });
  });

  it("maps conflicting settlement results to 409", async () => {
    const app = buildApp({
      recordLegSettlement: async () => {
        throw new Error("settlement_conflict:won");
      }
    });
    openApps.push(app);

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
  });
});
