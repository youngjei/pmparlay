import { describe, expect, it } from "vitest";
import { buildSettlementRpcEndpoints } from "../config";
import { resolvePolymarketLeg, validateCtfSettlementIdentity, type CtfPayoutQuorumRead } from "../resolvers/polymarketSettlementResolver";

const conditionId = `0x${"11".repeat(32)}`;
const ctfAddress = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const collateralAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const leg = {
  conditionId,
  tokenId: "yes-token",
  outcome: "Yes",
  endDate: "2030-07-20T00:00:00Z",
  negRisk: false,
  settlementSource: "polymarket_ctf",
  settlementChainId: 137,
  settlementContractAddress: ctfAddress,
  settlementCollateralAddress: collateralAddress,
  settlementConditionId: conditionId,
  settlementTokenId: "yes-token",
  settlementOutcomeIndex: 0,
  settlementPayoutSlotCount: 2
};

function quorum(payoutDenominator: string | number | bigint, payoutNumerators: Array<string | number | bigint>): CtfPayoutQuorumRead {
  const denominator = payoutDenominator.toString();
  const numerators = payoutNumerators.map((value) => value.toString());
  return {
    snapshots: ["primary", "secondary"].map((provider, index) => ({
      provider,
      chainId: 137,
      contractAddress: ctfAddress,
      conditionId,
      payoutDenominator: denominator,
      payoutNumerators: numerators,
      blockNumber: 1000,
      blockHash: `0x${"1".repeat(64)}`
    })),
    providerEvidence: ["primary", "secondary"].map((provider) => ({
      provider,
      status: "ok" as const,
      chainId: 137,
      payoutDenominator: denominator,
      payoutNumerators: numerators
    }))
  };
}

describe("Polymarket CTF settlement resolver", () => {
  it("keeps unresolved CTF conditions pending without mutable market fallback", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: true,
      readCtfPayouts: async () => quorum(0, [0, 0])
    });

    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "pending",
      result: "pending",
      proofKind: "ctf_unresolved",
      proof: {
        source: "polymarket_ctf",
        confidence: "onchain_confirmed",
        payoutDenominator: "0",
        payoutVector: ["0", "0"]
      }
    });
  });

  it("finalizes selected winning outcome from CTF payout vector", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: true,
      readCtfPayouts: async () => quorum(1, [1, 0])
    });

    expect(decision).toMatchObject({
      kind: "final",
      result: "won",
      proof: {
        source: "polymarket_ctf",
        proofKind: "ctf_payout_vector",
        confidence: "onchain_confirmed",
        chainId: 137,
        contractAddress: ctfAddress,
        collateralAddress,
        conditionId,
        tokenId: "yes-token",
        outcomeIndex: 0,
        payoutNumerator: "1",
        payoutDenominator: "1",
        payoutVector: ["1", "0"]
      }
    });
  });

  it("keeps large CTF payout values as strings", async () => {
    const large = "900719925474099312345";
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: true,
      readCtfPayouts: async () => quorum(large, [large, "0"])
    });

    expect(decision).toMatchObject({
      kind: "final",
      result: "won",
      proof: {
        payoutNumerator: large,
        payoutDenominator: large,
        payoutVector: [large, "0"]
      }
    });
  });

  it("voids partial or canceled CTF payout vectors instead of multiplying the payout", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: true,
      readCtfPayouts: async () => quorum(2, [1, 1])
    });

    expect(decision).toMatchObject({
      kind: "final",
      result: "voided",
      proof: {
        proofKind: "ctf_partial_or_canceled_payout",
        payoutDenominator: "2",
        payoutVector: ["1", "1"]
      }
    });
  });

  it("treats RPC quorum disagreement as retryable and non-final", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: true,
      readCtfPayouts: async () => ({
        snapshots: [
          {
            provider: "primary",
            chainId: 137,
            contractAddress: ctfAddress,
            conditionId,
            payoutDenominator: "1",
            payoutNumerators: ["1", "0"],
            blockNumber: 100,
            blockHash: `0x${"a".repeat(64)}`
          },
          {
            provider: "secondary",
            chainId: 137,
            contractAddress: ctfAddress,
            conditionId,
            payoutDenominator: "1",
            payoutNumerators: ["0", "1"],
            blockNumber: 101,
            blockHash: `0x${"b".repeat(64)}`
          }
        ],
        providerEvidence: []
      })
    });

    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "disputed",
      result: "disputed",
      proofKind: "ctf_rpc_quorum_disagreement"
    });
  });

  it("rejects same payout vectors from unrelated proof blocks", async () => {
    const decision = await resolvePolymarketLeg(leg, {
      requireOnchain: true,
      readCtfPayouts: async () => ({
        snapshots: [
          {
            provider: "primary",
            chainId: 137,
            contractAddress: ctfAddress,
            conditionId,
            payoutDenominator: "1",
            payoutNumerators: ["1", "0"],
            blockNumber: 100,
            blockHash: `0x${"a".repeat(64)}`
          },
          {
            provider: "secondary",
            chainId: 137,
            contractAddress: ctfAddress,
            conditionId,
            payoutDenominator: "1",
            payoutNumerators: ["1", "0"],
            blockNumber: 101,
            blockHash: `0x${"b".repeat(64)}`
          }
        ],
        providerEvidence: []
      })
    });

    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "disputed",
      result: "disputed",
      proofKind: "ctf_rpc_quorum_disagreement"
    });
  });

  it("blocks retryably when the frozen CTF outcome index is missing", async () => {
    const decision = await resolvePolymarketLeg(
      {
        ...leg,
        settlementOutcomeIndex: undefined
      },
      {
        requireOnchain: true,
        readCtfPayouts: async () => quorum(1, [1, 0])
      }
    );

    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "settlement_identity_not_frozen",
      error: "condition_token_or_outcome_index_missing"
    });
  });

  it("validates frozen identity against recomputed CTF position ID", async () => {
    const validation = await validateCtfSettlementIdentity(
      {
        chainId: 137,
        contractAddress: ctfAddress,
        collateralAddress,
        conditionId,
        tokenId: "12345",
        outcomeIndex: 0,
        outcomeSlotCount: 2
      },
      {
        readCtfPositionIds: async () => ({
          snapshots: ["primary", "secondary"].map((provider) => ({
            provider,
            chainId: 137,
            contractAddress: ctfAddress,
            collateralAddress,
            conditionId,
            outcomeIndex: 0,
            collectionId: `0x${"2".repeat(64)}`,
            computedPositionId: "12345",
            blockNumber: 1000,
            blockHash: `0x${"3".repeat(64)}`
          })),
          providerEvidence: []
        })
      }
    );

    expect(validation).toMatchObject({
      valid: true,
      retryable: false,
      computedPositionId: "12345",
      blockNumber: 1000
    });
  });

  it("rejects frozen identity when token ID does not match the CTF position ID", async () => {
    const validation = await validateCtfSettlementIdentity(
      {
        chainId: 137,
        contractAddress: ctfAddress,
        collateralAddress,
        conditionId,
        tokenId: "12345",
        outcomeIndex: 0,
        outcomeSlotCount: 2
      },
      {
        readCtfPositionIds: async () => ({
          snapshots: ["primary", "secondary"].map((provider) => ({
            provider,
            chainId: 137,
            contractAddress: ctfAddress,
            collateralAddress,
            conditionId,
            outcomeIndex: 0,
            collectionId: `0x${"2".repeat(64)}`,
            computedPositionId: "67890",
            blockNumber: 1000,
            blockHash: `0x${"3".repeat(64)}`
          })),
          providerEvidence: []
        })
      }
    );

    expect(validation).toMatchObject({
      valid: false,
      retryable: false,
      computedPositionId: "67890",
      error: "ctf_position_id_mismatch"
    });
  });

  it("rejects duplicate normalized RPC URLs and operators", () => {
    expect(() =>
      buildSettlementRpcEndpoints([
        { url: "https://polygon.example/rpc?key=one", operator: "one" },
        { url: "https://POLYGON.example/rpc?key=two", operator: "two" }
      ])
    ).toThrow("POLYGON_RPC_URLS must be distinct");

    expect(() =>
      buildSettlementRpcEndpoints([
        { url: "https://polygon-a.example", operator: "same-operator" },
        { url: "https://polygon-b.example", operator: "same-operator" }
      ])
    ).toThrow("POLYGON_RPC operators must be distinct");
  });
});
