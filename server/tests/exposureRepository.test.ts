import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteResponse } from "../quoteService";

const query = vi.hoisted(() => vi.fn());

vi.mock("../db/client", () => ({
  getPool: () => ({ query })
}));

import { exposureChecksForQuote } from "../db/exposureRepository";

function quoteWithLiability(incrementalLiabilityUsd: number): QuoteResponse {
  return {
    id: "quote-test",
    status: "quoted",
    createdAt: "2026-07-13T12:00:00.000Z",
    expiresAt: "2026-07-13T12:00:15.000Z",
    sourceAsOf: "2026-07-13T12:00:00.000Z",
    stakeUsd: 25,
    operationFeeUsd: 1,
    totalCostUsd: 26,
    basketPrice: 0.25,
    basketProbability: 0.25,
    quoteSpread: 0.07,
    payoutMultiple: 1 + incrementalLiabilityUsd / 25,
    potentialPayoutUsd: 25 + incrementalLiabilityUsd,
    riskDecision: "accept",
    riskChecks: [],
    legs: [
      {
        id: "outcome-test",
        marketId: "market-test",
        question: "Will the exact exposure boundary hold?",
        outcome: "Yes",
        price: 0.5,
        marketUrl: "https://polymarket.com/event/exposure-test",
        sourceAsOf: "2026-07-13T12:00:00.000Z"
      }
    ]
  };
}

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("open_market_exposure")) {
      return {
        rows: [
          {
            source_market_id: "market-test",
            outcome: "Yes",
            worst_case_liability_micro_usd: "999999999"
          }
        ]
      };
    }
    if (text.includes("open_event_exposure")) return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  });
});

describe("exposure arithmetic", () => {
  it("blocks a quote that exceeds the cap by one micro-unit", async () => {
    const checks = await exposureChecksForQuote(quoteWithLiability(0.000002), {
      maxMarketLiabilityUsd: 1_000,
      maxEventLiabilityUsd: 1_000
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        level: "block",
        label: "Market exposure"
      })
    );
  });

  it("fails closed when a configured USD cap cannot be represented exactly", async () => {
    await expect(
      exposureChecksForQuote(quoteWithLiability(1), {
        maxMarketLiabilityUsd: 10_000_000_000,
        maxEventLiabilityUsd: 1_000
      })
    ).rejects.toThrow("invalid_exposure_value:market_limit");
  });
});
