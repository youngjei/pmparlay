import { describe, expect, it } from "vitest";
import {
  readPolymarketApiResolution,
  validatePolymarketApiSettlementIdentity,
  type PolymarketApiSettlementDependencies,
  type PolymarketApiSettlementIdentity
} from "../resolvers/polymarketApiSettlement";

const conditionId = `0x${"ab".repeat(32)}`;
const identity: PolymarketApiSettlementIdentity = {
  sourceMarketId: "12345",
  conditionId,
  tokenId: "yes-token",
  outcome: "Yes",
  outcomeIndex: 0,
  outcomeSlotCount: 2,
  negRisk: false
};

function gamma(overrides: Record<string, unknown> = {}) {
  return {
    id: "12345",
    conditionId,
    active: true,
    closed: true,
    archived: false,
    outcomes: '["Yes", "No"]',
    outcomePrices: '["1", "0"]',
    clobTokenIds: '["yes-token", "no-token"]',
    umaResolutionStatus: "resolved",
    closedTime: "2026-07-21T08:00:00.000Z",
    negRisk: false,
    ...overrides
  };
}

function clob(overrides: Record<string, unknown> = {}) {
  return {
    condition_id: conditionId,
    active: true,
    closed: true,
    archived: false,
    accepting_orders: false,
    is_50_50_outcome: false,
    neg_risk: false,
    tokens: [
      { token_id: "yes-token", outcome: "Yes", price: 1, winner: true },
      { token_id: "no-token", outcome: "No", price: 0, winner: false }
    ],
    ...overrides
  };
}

function dependencies(gammaPayload: unknown, clobPayload: unknown): PolymarketApiSettlementDependencies {
  return {
    now: () => new Date("2026-07-21T09:00:00.000Z"),
    fetch: async (url) => ({
      ok: true,
      status: 200,
      async json() {
        return url.includes("gamma-api") ? gammaPayload : clobPayload;
      }
    })
  };
}

describe("Polymarket API settlement evidence", () => {
  it("validates the frozen source market, condition, token, outcome, and neg-risk identity", async () => {
    const result = await validatePolymarketApiSettlementIdentity(identity, dependencies(gamma(), clob()));
    expect(result).toMatchObject({
      authority: "polymarket_api",
      valid: true,
      retryable: false,
      computedPositionId: "yes-token"
    });
    expect(result.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.providerEvidence.map((item) => [item.provider, item.status])).toEqual([
      ["gamma", "ok"],
      ["clob", "ok"]
    ]);
  });

  it("returns a winning terminal candidate only when Gamma and CLOB agree", async () => {
    const result = await readPolymarketApiResolution(identity, dependencies(gamma(), clob()));
    expect(result).toMatchObject({
      status: "candidate",
      result: "won",
      proofKind: "polymarket_api_outcome",
      payoutNumerator: "1",
      payoutDenominator: "1",
      payoutVector: ["1", "0"],
      winningTokenId: "yes-token"
    });
  });

  it("keeps a market pending until both APIs are terminal", async () => {
    const result = await readPolymarketApiResolution(
      identity,
      dependencies(gamma(), clob({ closed: false, accepting_orders: true, tokens: clob().tokens }))
    );
    expect(result).toMatchObject({ status: "pending" });
  });

  it("blocks immutable identity mismatches instead of using API prices", async () => {
    const result = await readPolymarketApiResolution(
      identity,
      dependencies(gamma({ conditionId: `0x${"cd".repeat(32)}` }), clob())
    );
    expect(result).toMatchObject({
      status: "identity_invalid",
      error: "polymarket_api_identity_mismatch"
    });
  });

  it("treats terminal winner disagreement as non-final", async () => {
    const result = await readPolymarketApiResolution(
      identity,
      dependencies(
        gamma(),
        clob({
          tokens: [
            { token_id: "yes-token", outcome: "Yes", price: 1, winner: false },
            { token_id: "no-token", outcome: "No", price: 0, winner: true }
          ]
        })
      )
    );
    expect(result).toMatchObject({
      status: "disagreement",
      error: "polymarket_api_winner_disagreement"
    });
  });

  it("accepts only the explicit Gamma and CLOB 50/50 void shape", async () => {
    const result = await readPolymarketApiResolution(
      identity,
      dependencies(
        gamma({ outcomePrices: '["0.5", "0.5"]' }),
        clob({
          is_50_50_outcome: true,
          tokens: [
            { token_id: "yes-token", outcome: "Yes", price: 0.5, winner: false },
            { token_id: "no-token", outcome: "No", price: 0.5, winner: false }
          ]
        })
      )
    );
    expect(result).toMatchObject({
      status: "candidate",
      result: "voided",
      proofKind: "polymarket_api_50_50_void",
      payoutNumerator: "1",
      payoutDenominator: "2",
      payoutVector: ["1", "1"]
    });
  });

  it("rejects neg-risk disagreement and treats transport errors as retryable", async () => {
    const mismatch = await validatePolymarketApiSettlementIdentity(
      identity,
      dependencies(gamma({ negRisk: true }), clob())
    );
    expect(mismatch).toMatchObject({ valid: false, retryable: false, error: "polymarket_api_identity_mismatch" });

    const unavailable = await validatePolymarketApiSettlementIdentity(identity, {
      fetch: async () => {
        throw new Error("network secret detail");
      }
    });
    expect(unavailable).toMatchObject({ valid: false, retryable: true, error: "polymarket_api_unavailable" });
    expect(unavailable.providerEvidence.every((item) => item.error === "request_failed")).toBe(true);
  });
});
