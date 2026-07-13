import { describe, expect, it } from "vitest";
import { resolvePolymarketLeg } from "../resolvers/polymarketSettlementResolver";

const leg = {
  conditionId: "condition-1",
  tokenId: "yes-token",
  outcome: "Yes",
  endDate: "2026-07-20T00:00:00Z"
};

describe("Polymarket settlement resolver", () => {
  it("keeps open markets pending", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: false,
      fetchMarket: async () => ({
        condition_id: "condition-1",
        closed: false,
        tokens: [{ token_id: "yes-token", outcome: "Yes", winner: false }]
      })
    });

    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "pending",
      result: "pending",
      proofKind: "clob_market_open"
    });
  });

  it("marks selected winning token as final when onchain confirmation is not required", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: false,
      fetchMarket: async () => ({
        condition_id: "condition-1",
        closed: true,
        tokens: [
          { token_id: "yes-token", outcome: "Yes", winner: true },
          { token_id: "no-token", outcome: "No", winner: false }
        ]
      })
    });

    expect(decision).toMatchObject({
      kind: "final",
      result: "won",
      proof: {
        source: "polymarket_clob",
        proofKind: "clob_market_winner",
        confidence: "api_signal",
        winningTokenId: "yes-token"
      }
    });
  });

  it("blocks finalization when onchain confirmation is required", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: true,
      fetchMarket: async () => ({
        condition_id: "condition-1",
        closed: true,
        tokens: [
          { token_id: "yes-token", outcome: "Yes", winner: true },
          { token_id: "no-token", outcome: "No", winner: false }
        ]
      })
    });

    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "onchain_confirmation_required"
    });
  });

  it("blocks ambiguous 50/50 outcomes until policy exists", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: false,
      fetchMarket: async () => ({
        condition_id: "condition-1",
        closed: true,
        is_50_50_outcome: true,
        tokens: [{ token_id: "yes-token", outcome: "Yes", winner: true }]
      })
    });

    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      error: "partial_or_50_50_resolution_requires_policy"
    });
  });
});
