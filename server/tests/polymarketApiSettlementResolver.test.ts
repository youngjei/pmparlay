import { describe, expect, it } from "vitest";
import type { PolymarketApiResolutionRead } from "../resolvers/polymarketApiSettlement";
import { resolvePolymarketLeg } from "../resolvers/polymarketSettlementResolver";

const conditionId = `0x${"12".repeat(32)}`;
const leg = {
  conditionId,
  tokenId: "yes-token",
  outcome: "Yes",
  endDate: "2026-07-21T08:00:00.000Z",
  negRisk: false,
  settlementAuthority: "polymarket_api" as const,
  settlementChainId: 137,
  settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  settlementConditionId: conditionId,
  settlementTokenId: "yes-token",
  settlementOutcomeIndex: 0,
  settlementPayoutSlotCount: 2,
  settlementSourceMarketId: "12345",
  settlementOutcome: "Yes",
  settlementNegRisk: false
};

const candidate: Extract<PolymarketApiResolutionRead, { status: "candidate" }> = {
  status: "candidate",
  result: "won",
  proofKind: "polymarket_api_outcome",
  payoutNumerator: "1",
  payoutDenominator: "1",
  payoutVector: ["1", "0"],
  winningTokenId: "yes-token",
  fingerprint: "a".repeat(64),
  identityFingerprint: "b".repeat(64),
  resolvedAt: "2026-07-21T08:00:00.000Z",
  providerEvidence: [
    { provider: "gamma", status: "ok", fetchedAt: "2026-07-21T09:00:00.000Z" },
    { provider: "clob", status: "ok", fetchedAt: "2026-07-21T09:00:00.000Z" }
  ]
};

describe("Polymarket API settlement stability", () => {
  it("persists the first terminal result as a candidate instead of settling", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: false,
      authority: "polymarket_api",
      nowMs: Date.parse("2026-07-21T09:00:00.000Z"),
      stabilityMs: 120_000,
      readPolymarketApiResolution: async () => candidate
    });
    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "resolution_candidate",
      result: "won",
      proofKind: "polymarket_api_resolution_candidate",
      proof: {
        source: "polymarket_api",
        payoutVector: ["1", "0"]
      },
      raw: {
        fingerprint: candidate.fingerprint,
        firstObservedAt: "2026-07-21T09:00:00.000Z"
      }
    });
  });

  it("finalizes only after a matching persisted candidate has remained stable", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: false,
      authority: "polymarket_api",
      nowMs: Date.parse("2026-07-21T09:02:01.000Z"),
      stabilityMs: 120_000,
      previousApiCandidate: {
        proofId: "candidate-proof-id",
        fingerprint: candidate.fingerprint,
        firstObservedAt: "2026-07-21T09:00:00.000Z",
        observedAt: "2026-07-21T09:00:00.000Z",
        result: "won"
      },
      readPolymarketApiResolution: async () => candidate
    });
    expect(decision).toMatchObject({
      kind: "final",
      result: "won",
      proof: {
        source: "polymarket_api",
        proofKind: "polymarket_api_outcome",
        confidence: "api_signal",
        raw: {
          candidateProofId: "candidate-proof-id",
          fingerprint: candidate.fingerprint,
          firstObservedAt: "2026-07-21T09:00:00.000Z",
          confirmedAt: "2026-07-21T09:02:01.000Z",
          stableForMs: 121_000
        }
      }
    });
  });

  it("does not inherit stability from a different result fingerprint", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: false,
      authority: "polymarket_api",
      nowMs: Date.parse("2026-07-21T09:10:00.000Z"),
      stabilityMs: 120_000,
      previousApiCandidate: {
        proofId: "old-proof",
        fingerprint: "c".repeat(64),
        firstObservedAt: "2026-07-21T09:00:00.000Z",
        observedAt: "2026-07-21T09:00:00.000Z",
        result: "lost"
      },
      readPolymarketApiResolution: async () => candidate
    });
    expect(decision).toMatchObject({
      kind: "observe",
      raw: { firstObservedAt: "2026-07-21T09:10:00.000Z" }
    });
  });

  it("fails closed when the frozen API identity is incomplete", async () => {
    const decision = await resolvePolymarketLeg(
      { ...leg, settlementSourceMarketId: undefined },
      {
        requireOnchain: false,
        authority: "polymarket_api",
        readPolymarketApiResolution: async () => candidate
      }
    );
    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "settlement_blocked",
      proofKind: "polymarket_api_identity_incomplete"
    });
  });
});
