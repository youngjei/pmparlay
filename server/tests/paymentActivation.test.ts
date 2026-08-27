import { describe, expect, it, vi } from "vitest";
import { activateConfirmedQuotePayment, activateConfirmedQuotePayments, getFreshRequoteCatalog } from "../paymentActivation";
import type { QuotePaymentIntent } from "../db/paymentIntentRepository";
import type { QuoteResponse } from "../quoteService";

const userId = "00000000-0000-0000-0000-000000000001";
const now = Date.parse("2026-07-13T12:00:00.000Z");
const betaStakeUsd = 1;
const betaPaymentAmountUsdc = 2;
const betaPaymentAmountMicroUnits = "2000000";
const betaPotentialPayoutUsd = 3.72;
const betaPotentialPayoutMicroUsd = "3720000";
const betaMinimumFinalPayoutMicroUsd = "3701400";

function confirmedIntent(overrides: Partial<QuotePaymentIntent> = {}): QuotePaymentIntent {
  return {
    id: "payment-intent-test",
    quoteId: "quote-estimate",
    userId,
    chainId: 1,
    currency: "USDC",
    treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
    usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    amountMicroUnits: betaPaymentAmountMicroUnits,
    amountUsdc: betaPaymentAmountUsdc,
    requiredConfirmations: 12,
    status: "confirmed",
    txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    expiresAt: "2026-07-13T12:15:00.000Z",
    submissionDeadlineAt: "2026-07-13T12:03:00.000Z",
    trackingDeadlineAt: "2026-07-13T12:15:00.000Z",
    maxAdverseBps: 50,
    estimatedPayoutMicroUsd: betaPotentialPayoutMicroUsd,
    minFinalPayoutMicroUsd: betaMinimumFinalPayoutMicroUsd,
    amountReceivedMicroUnits: betaPaymentAmountMicroUnits,
    surplusMicroUnits: "0",
    confirmedAt: "2026-07-13T12:01:00.000Z",
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:01:00.000Z",
    ...overrides
  };
}

function originalQuote(): QuoteResponse {
  return {
    id: "quote-estimate",
    status: "quoted",
    createdAt: "2026-07-13T12:00:00.000Z",
    expiresAt: "2026-07-13T12:00:15.000Z",
    sourceAsOf: "2026-07-13T11:59:59.000Z",
    stakeUsd: betaStakeUsd,
    operationFeeUsd: 1,
    totalCostUsd: betaPaymentAmountUsdc,
    basketPrice: 0.25,
    basketProbability: 0.25,
    quoteSpread: 0.1,
    payoutMultiple: 3.6,
    potentialPayoutUsd: betaPotentialPayoutUsd,
    riskDecision: "accept",
    riskChecks: [{ level: "ok", label: "Risk checks passed", detail: "This basket is inside current launch limits." }],
    legs: [
      {
        id: "btc-up-yes",
        marketId: "btc-up",
        question: "Bitcoin Up?",
        outcome: "Yes",
        price: 0.5,
        marketUrl: "https://polymarket.com/event/btc-up",
        sourceAsOf: "2026-07-13T11:59:59.000Z"
      },
      {
        id: "eth-up-yes",
        marketId: "eth-up",
        question: "Ethereum Up?",
        outcome: "Yes",
        price: 0.5,
        marketUrl: "https://polymarket.com/event/eth-up",
        sourceAsOf: "2026-07-13T11:59:59.000Z"
      }
    ]
  };
}

function freshCatalog(price = 0.5) {
  return {
    asOf: "2026-07-13T12:00:00.000Z",
    source: "polymarket" as const,
    outcomes: [
      {
        id: "btc-up-yes",
        marketId: "btc-up",
        question: "Bitcoin Up?",
        category: "Crypto",
        outcome: "Yes",
        price,
        marketUrl: "https://polymarket.com/event/btc-up",
        source: "polymarket" as const,
        sourceAsOf: "2026-07-13T12:00:00.000Z",
        volume: 1_000_000,
        liquidity: 1_000_000,
        orderbookTimestamp: "2026-07-13T12:00:00.000Z",
        askDepthEvidence: {
          requestedNotionalUsd: betaStakeUsd,
          availableNotionalUsd: 5,
          bestAsk: price,
          executablePrice: price,
          vwapAsk: price,
          orderbookTimestamp: "2026-07-13T12:00:00.000Z",
          orderbookHash: "book-hash-btc",
          sufficientDepth: true
        }
      },
      {
        id: "eth-up-yes",
        marketId: "eth-up",
        question: "Ethereum Up?",
        category: "Crypto",
        outcome: "Yes",
        price,
        marketUrl: "https://polymarket.com/event/eth-up",
        source: "polymarket" as const,
        sourceAsOf: "2026-07-13T12:00:00.000Z",
        volume: 1_000_000,
        liquidity: 1_000_000,
        orderbookTimestamp: "2026-07-13T12:00:00.000Z",
        askDepthEvidence: {
          requestedNotionalUsd: betaStakeUsd,
          availableNotionalUsd: 5,
          bestAsk: price,
          executablePrice: price,
          vwapAsk: price,
          orderbookTimestamp: "2026-07-13T12:00:00.000Z",
          orderbookHash: "book-hash-eth",
          sufficientDepth: true
        }
      }
    ]
  };
}

describe("direct-pay activation requote", () => {
  it("loads the exact paid outcome ids before final CLOB repricing", async () => {
    const outcomeIds = ["btc-up-yes", "eth-up-yes"];
    const getCandidates = vi.fn(async () => ({
      asOf: "2026-07-13T12:00:00.000Z",
      source: "polymarket" as const,
      complete: true,
      outcomes: outcomeIds.map((id) => ({
        id,
        marketId: id.replace("-yes", ""),
        conditionId: `${id}-condition`,
        tokenId: `${id}-token`,
        question: `${id}?`,
        category: "Crypto",
        outcome: "Yes",
        price: 0.5,
        volume: 1_000_000,
        liquidity: 1_000_000,
        sourceActive: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        source: "polymarket" as const,
        priceSource: "gamma" as const
      }))
    }));
    const hydrate = vi.fn(async (outcomes: Awaited<ReturnType<typeof getCandidates>>["outcomes"]) => ({
      complete: true,
      attemptedChunks: 1,
      successfulChunks: 1,
      outcomes: outcomes.map((outcome) => ({
        ...outcome,
        bestAsk: 0.51,
        executablePrice: 0.51,
        requestedNotionalUsd: betaStakeUsd,
        availableAskNotionalUsd: 5,
        priceSource: "clob_vwap" as const,
        sourceAsOf: "2026-07-13T12:00:01.000Z"
      }))
    }));

    const catalog = await getFreshRequoteCatalog(
      { requestedNotionalUsdPerLeg: betaStakeUsd, outcomeIds },
      { getCandidates: getCandidates as never, hydrate: hydrate as never }
    );

    expect(getCandidates).toHaveBeenCalledWith(
      outcomeIds,
      expect.objectContaining({ maxSnapshotAgeMs: expect.any(Number) })
    );
    expect(hydrate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "btc-up-yes" }), expect.objectContaining({ id: "eth-up-yes" })]),
      undefined,
      expect.objectContaining({ requestedNotionalUsd: betaStakeUsd, requireExplicitLifecycle: true })
    );
    expect(catalog.outcomes).toHaveLength(2);
    expect(catalog.outcomes.every((outcome) => outcome.priceSource === "clob_vwap")).toBe(true);
  });

  it("persists and accepts a distinct final quote without mutating the initial estimate", async () => {
    const estimate = originalQuote();
    const estimateAudit = JSON.stringify(estimate);
    let requestedNotional: number | undefined;
    let requestedOutcomeIds: string[] | undefined;
    let persistedFinalQuoteId: string | undefined;
    let acceptedQuoteId: string | undefined;
    let activatedQuoteId: string | undefined;
    let gateChecked = false;

    const ticket = await activateConfirmedQuotePayment(
      { quoteId: "quote-estimate", userId },
      {
        nowMs: now,
        getPaymentIntent: async () => confirmedIntent(),
        assertFinancialGateOpen: async () => {
          gateChecked = true;
          return undefined as never;
        },
        getOriginalQuote: async () => estimate,
        getRequoteCatalog: async (input) => {
          requestedNotional = input.requestedNotionalUsdPerLeg;
          requestedOutcomeIds = input.outcomeIds;
          return freshCatalog();
        },
        exposureChecks: async () => [],
        persistFinalQuote: async (input) => {
          expect(input.quoteId).toBe("quote-estimate");
          expect(input.finalQuote.id).not.toBe("quote-estimate");
          expect(input.evidenceByLegId?.size).toBe(2);
          expect(
            [...(input.evidenceByLegId as Map<string, unknown>).values()].every(
              (item) =>
                (item as { liveOrderbookFetchedAt?: string }).liveOrderbookFetchedAt === "2026-07-13T12:00:00.000Z" &&
                !("catalogSnapshotCapturedAt" in (item as Record<string, unknown>))
            )
          ).toBe(true);
          persistedFinalQuoteId = input.finalQuote.id;
          return confirmedIntent({
            finalQuoteId: input.finalQuote.id,
            finalPayoutMicroUsd: String(Math.round(input.finalQuote.potentialPayoutUsd * 1_000_000))
          });
        },
        prepareCheckoutFunds: async () => confirmedIntent(),
        acceptFinalQuote: async (quoteId) => {
          acceptedQuoteId = quoteId;
          return {
            ticketId: "ticket-final",
            quoteId,
            status: "accepted",
            ledgerTransactionId: "ledger-test",
            accountingMode: "house_book_usdc",
            currency: "USDC"
          };
        },
        markActivated: async (input) => {
          activatedQuoteId = input.quoteId;
          return confirmedIntent({ status: "activated", ticketId: input.ticketId });
        }
      }
    );

    expect(requestedNotional).toBe(betaStakeUsd);
    expect(requestedOutcomeIds).toEqual(["btc-up-yes", "eth-up-yes"]);
    expect(gateChecked).toBe(true);
    expect(persistedFinalQuoteId).toBeDefined();
    expect(acceptedQuoteId).toBe(persistedFinalQuoteId);
    expect(activatedQuoteId).toBe("quote-estimate");
    expect(ticket).toMatchObject({ ticketId: "ticket-final", quoteId: persistedFinalQuoteId });
    expect(JSON.stringify(estimate)).toBe(estimateAudit);
  });

  it("moves adverse requotes outside tolerance to recovery before releasing checkout funds", async () => {
    let prepared = false;
    let accepted = false;
    let recoveryReason: string | undefined;

    await expect(
      activateConfirmedQuotePayment(
        { quoteId: "quote-estimate", userId },
        {
          nowMs: now,
          getPaymentIntent: async () => confirmedIntent(),
          getOriginalQuote: async () => originalQuote(),
          getRequoteCatalog: async () => freshCatalog(0.6),
          exposureChecks: async () => [],
          markRecoverable: async (input) => {
            recoveryReason = input.reason;
            return confirmedIntent({ status: "recoverable", recoveryReason: input.reason });
          },
          prepareCheckoutFunds: async () => {
            prepared = true;
            return confirmedIntent();
          },
          acceptFinalQuote: async () => {
            accepted = true;
            throw new Error("should_not_accept");
          }
        }
      )
    ).rejects.toThrow("requote_adverse");

    expect(recoveryReason).toBe("requote_adverse");
    expect(prepared).toBe(false);
    expect(accepted).toBe(false);
  });

  it("requires the financial gate before background activation can mutate payment state", async () => {
    let loadedOriginalQuote = false;
    await expect(
      activateConfirmedQuotePayment(
        { quoteId: "quote-estimate", userId },
        {
          getPaymentIntent: async () => confirmedIntent(),
          assertFinancialGateOpen: async () => {
            throw new Error("financial_gate_closed:reconciliation_snapshot_stale");
          },
          getOriginalQuote: async () => {
            loadedOriginalQuote = true;
            return originalQuote();
          }
        }
      )
    ).rejects.toThrow("financial_gate_closed");

    expect(loadedOriginalQuote).toBe(false);
  });

  it("requires healthy settlement controls before background activation loads the payment intent", async () => {
    let loadedIntent = false;

    await expect(
      activateConfirmedQuotePayment(
        { quoteId: "quote-estimate", userId },
        {
          requiredWorkerNames: ["financial-reconciliation", "settlement-worker"],
          assertWorkerHeartbeatsHealthy: async () => {
            throw new Error("required_financial_workers_unhealthy:settlement-worker");
          },
          getPaymentIntent: async () => {
            loadedIntent = true;
            return confirmedIntent();
          }
        }
      )
    ).rejects.toThrow("required_financial_workers_unhealthy:settlement-worker");

    expect(loadedIntent).toBe(false);
  });

  it("keeps a confirmed payment retryable when the financial gate closes during activation", async () => {
    let markedRecoverable = false;

    await expect(
      activateConfirmedQuotePayment(
        { quoteId: "quote-estimate", userId },
        {
          nowMs: now,
          getPaymentIntent: async () => confirmedIntent(),
          assertFinancialGateOpen: async () => undefined as never,
          getOriginalQuote: async () => originalQuote(),
          getRequoteCatalog: async () => freshCatalog(),
          exposureChecks: async () => [],
          persistFinalQuote: async (input) => confirmedIntent({ finalQuoteId: input.finalQuote.id }),
          prepareCheckoutFunds: async () => {
            throw new Error("financial_gate_closed:reconciliation_snapshot_stale");
          },
          markRecoverable: async () => {
            markedRecoverable = true;
            return confirmedIntent({ status: "recoverable" });
          }
        }
      )
    ).rejects.toThrow("financial_gate_closed:reconciliation_snapshot_stale");

    expect(markedRecoverable).toBe(false);
  });

  it("allows a gate-approved expired activation lease to be selected for retry", async () => {
    const recovered: number[] = [];
    const activated: string[] = [];
    const result = await activateConfirmedQuotePayments(25, {
      recoverStale: async (limit) => {
        recovered.push(limit ?? 0);
        return { scanned: 0, recovered: 0 };
      },
      listCandidates: async () => [{ quoteId: "quote-estimate", userId }],
      activate: async (input) => {
        activated.push(input.quoteId);
        return {
          ticketId: "ticket-final",
          quoteId: "quote-final",
          status: "accepted",
          ledgerTransactionId: "ledger-test",
          accountingMode: "house_book_usdc",
          currency: "USDC"
        };
      }
    });

    expect(recovered).toEqual([25]);
    expect(activated).toEqual(["quote-estimate"]);
    expect(result).toMatchObject({ scanned: 1, activated: 1, failed: [] });
  });
});
