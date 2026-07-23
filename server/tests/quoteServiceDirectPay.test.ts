import { describe, expect, it } from "vitest";
import { createPaymentActivationRequote, type QuoteResponse } from "../quoteService";

const baseQuote: QuoteResponse = {
  id: "quote-estimate",
  status: "quoted",
  createdAt: "2026-07-13T12:00:00.000Z",
  expiresAt: "2026-07-13T12:00:15.000Z",
  sourceAsOf: "2026-07-13T12:00:00.000Z",
  stakeUsd: 25,
  operationFeeUsd: 2,
  totalCostUsd: 27,
  basketPrice: 0.25,
  basketProbability: 0.25,
  quoteSpread: 0.1,
  payoutMultiple: 3.6,
  potentialPayoutUsd: 90,
  riskDecision: "accept",
  riskChecks: [],
  legs: [
    {
      id: "btc-up-yes",
      marketId: "btc-up",
      question: "Bitcoin Up?",
      outcome: "Yes",
      price: 0.5
    },
    {
      id: "eth-up-yes",
      marketId: "eth-up",
      question: "Ethereum Up?",
      outcome: "Yes",
      price: 0.5
    }
  ]
};

function catalog(overrides: Record<string, unknown> = {}) {
  const evidence = {
    requestedNotionalUsd: 25,
    availableNotionalUsd: 250,
    bestAsk: 0.5,
    executablePrice: 0.5,
    vwapAsk: 0.5,
    orderbookTimestamp: "2026-07-13T12:00:00.000Z",
    orderbookHash: "book-hash-test",
    sufficientDepth: true,
    ...overrides
  };

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
        price: 0.5,
        source: "polymarket" as const,
        askDepthEvidence: evidence
      },
      {
        id: "eth-up-yes",
        marketId: "eth-up",
        question: "Ethereum Up?",
        category: "Crypto",
        outcome: "Yes",
        price: 0.5,
        source: "polymarket" as const,
        askDepthEvidence: evidence
      }
    ]
  };
}

describe("direct-pay activation requote evidence", () => {
  it("rejects insufficient ask depth for the requested stake notional", () => {
    expect(() =>
      createPaymentActivationRequote(baseQuote, catalog({ availableNotionalUsd: 24.99 }), {
        requestedNotionalUsdPerLeg: 25,
        nowMs: Date.parse("2026-07-13T12:00:00.000Z")
      })
    ).toThrow("insufficient_depth");
  });

  it("rejects stale orderbook evidence", () => {
    expect(() =>
      createPaymentActivationRequote(baseQuote, catalog({ orderbookTimestamp: "2026-07-13T11:59:00.000Z" }), {
        requestedNotionalUsdPerLeg: 25,
        maxEvidenceAgeMs: 30_000,
        nowMs: Date.parse("2026-07-13T12:00:00.000Z")
      })
    ).toThrow("stale_book");
  });

  it("rejects orderbook evidence with a materially future timestamp", () => {
    expect(() =>
      createPaymentActivationRequote(baseQuote, catalog({ orderbookTimestamp: "2026-07-13T12:00:31.000Z" }), {
        requestedNotionalUsdPerLeg: 25,
        maxEvidenceAgeMs: 30_000,
        nowMs: Date.parse("2026-07-13T12:00:00.000Z")
      })
    ).toThrow("stale_book");
  });

  it("requires canonical orderbook identity evidence", () => {
    expect(() =>
      createPaymentActivationRequote(baseQuote, catalog({ orderbookHash: undefined }), {
        requestedNotionalUsdPerLeg: 25,
        nowMs: Date.parse("2026-07-13T12:00:00.000Z")
      })
    ).toThrow("stale_book");
  });
});
