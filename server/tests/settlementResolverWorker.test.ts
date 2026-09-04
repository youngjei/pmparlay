import { describe, expect, it, vi } from "vitest";
import { resolvePolymarketLeg } from "../resolvers/polymarketSettlementResolver";
import { processSettlementBatch, processSettlementCycle, processSettlementLeg } from "../workers/settlementResolverWorker";

const pendingLeg = {
  ticketLegId: "leg-1",
  ticketId: "ticket-1",
  quoteId: "quote-1",
  question: "Will test resolve?",
  outcome: "Yes",
  conditionId: "condition-1",
  tokenId: "token-yes",
  settlementChainId: 137,
  settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  settlementConditionId: "condition-1",
  settlementTokenId: "token-yes",
  settlementOutcomeIndex: 0,
  settlementPayoutSlotCount: 2,
  settlementAuthority: "polygon_ctf" as const,
  endDate: "2026-07-01T00:00:00.000Z",
  status: "pending",
  resolutionState: "pending",
  resolutionAttempts: 0,
  ticketStatus: "live",
  createdAt: "2026-07-06T00:00:00.000Z"
};

describe("settlement resolver worker", () => {
  it("uses the configured API default when a leg has no settlement authority", async () => {
    const { settlementAuthority, ...legUsingConfiguredDefault } = pendingLeg;
    const candidate = {
      proofId: "proof-1",
      fingerprint: "candidate-fingerprint",
      firstObservedAt: "2026-07-06T00:00:00.000Z",
      observedAt: "2026-07-06T00:01:00.000Z",
      result: "won" as const
    };
    const getLatestApiCandidate = vi.fn(async () => candidate);
    const observe = vi.fn(async () => true);
    const resolveLeg = vi.fn(async (_leg, options) => {
      expect(options).toMatchObject({
        requireOnchain: false,
        authority: "polymarket_api",
        previousApiCandidate: candidate
      });
      return {
        kind: "observe" as const,
        resolutionState: "resolution_candidate" as const,
        result: "won" as const,
        proofKind: "polymarket_api_resolution_candidate",
        nextCheckSeconds: 30,
        raw: {}
      };
    });

    expect(settlementAuthority).toBe("polygon_ctf");
    await processSettlementLeg(legUsingConfiguredDefault, {
      getLatestApiCandidate,
      recordSettlementObservation: observe,
      resolveLeg
    });

    expect(getLatestApiCandidate).toHaveBeenCalledWith("leg-1");
    expect(resolveLeg).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
  });

  it("settles a leg when the resolver returns a final decision", async () => {
    const settle = vi.fn(async () => ({
      ticketLegId: "leg-1",
      ticketId: "ticket-1",
      legStatus: "won" as const,
      ticketStatus: "live" as const
    }));
    const observe = vi.fn();

    await processSettlementLeg(pendingLeg, {
      recordLegSettlement: settle,
      recordSettlementObservation: observe,
      resolveLeg: async () => ({
        kind: "final",
        result: "won",
        proof: {
          source: "polymarket_ctf",
          proofKind: "ctf_payout_vector",
          result: "won",
          confidence: "onchain_confirmed",
          chainId: 137,
          contractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
          conditionId: "condition-1",
          tokenId: "token-yes",
          outcomeIndex: 0,
          payoutNumerator: "1",
          payoutDenominator: "1",
          payoutVector: ["1", "0"],
          raw: {}
        }
      })
    });

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketLegId: "leg-1",
        result: "won",
        source: "polymarket_ctf"
      })
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it("records observations without settling non-final decisions", async () => {
    const settle = vi.fn();
    const observe = vi.fn(async () => true);

    await processSettlementLeg(pendingLeg, {
      recordLegSettlement: settle,
      recordSettlementObservation: observe,
      resolveLeg: async () => ({
        kind: "observe",
        resolutionState: "awaiting_oracle",
        result: "pending",
        proofKind: "ctf_unresolved",
        proof: {
          source: "polymarket_ctf",
          proofKind: "ctf_unresolved",
          result: "pending",
          confidence: "onchain_confirmed",
          chainId: 137,
          contractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
          conditionId: "condition-1",
          tokenId: "token-yes",
          outcomeIndex: 0,
          payoutDenominator: "0",
          payoutVector: ["0", "0"],
          raw: {}
        },
        nextCheckSeconds: 300,
        raw: {}
      })
    });

    expect(settle).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketLegId: "leg-1",
        resolutionState: "awaiting_oracle",
        result: "pending",
        source: "polymarket_ctf",
        proofKind: "ctf_unresolved",
        chainId: 137,
        outcomeIndex: 0,
        payoutDenominator: "0",
        payoutVector: ["0", "0"]
      })
    );
  });

  it("never treats Gamma or CLOB winner-shaped fields as settlement authority", async () => {
    const settle = vi.fn();
    const observe = vi.fn(async () => true);
    const conditionId = `0x${"1".repeat(64)}`;

    await processSettlementLeg(
      {
        ...pendingLeg,
        conditionId,
        settlementConditionId: conditionId,
        closed: true,
        resolved: true,
        winner: "Yes",
        winningTokenId: "token-yes",
        tokens: [{ outcome: "Yes", winner: true }],
        outcomePrices: ["1", "0"],
        websocketMessage: { market: conditionId, price: "1" }
      } as typeof pendingLeg,
      {
        recordLegSettlement: settle,
        recordSettlementObservation: observe,
        resolveLeg: (leg) =>
          resolvePolymarketLeg(leg, {
            requireOnchain: true,
            readCtfPayouts: async () => ({
              snapshots: ["primary", "secondary"].map((provider) => ({
                provider,
                chainId: 137,
                contractAddress: leg.settlementContractAddress!,
                conditionId,
                payoutDenominator: "0",
                payoutNumerators: ["0", "0"],
                blockNumber: 100,
                blockHash: `0x${"a".repeat(64)}`
              })),
              providerEvidence: []
            })
          })
      }
    );

    expect(settle).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "polymarket_ctf",
        proofKind: "ctf_unresolved",
        result: "pending",
        payoutDenominator: "0"
      })
    );
  });

  it("keeps processing a batch when one resolver call fails", async () => {
    const observe = vi.fn(async () => true);
    const result = await processSettlementBatch({
      listPendingSettlementLegs: async () => [pendingLeg],
      listBlockedSettlementLegs: async () => [],
      recordSettlementObservation: observe,
      resolveLeg: async () => {
        throw new Error("clob_timeout");
      }
    });

    expect(result).toMatchObject({
      checked: 1,
      results: [{ ticketLegId: "leg-1", status: "failed", error: "clob_timeout" }]
    });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        resolutionState: "pending",
        proofKind: "resolver_error",
        error: "clob_timeout"
      })
    );
  });

  it("redacts upstream credentials before persisting resolver failures", async () => {
    const observe = vi.fn(async () => true);
    const result = await processSettlementBatch({
      listPendingSettlementLegs: async () => [pendingLeg],
      listBlockedSettlementLegs: async () => [],
      recordSettlementObservation: observe,
      resolveLeg: async () => {
        throw new Error("rpc failed at https://user:pass@example.test/path?api_key=secret authorization=top-secret");
      }
    });

    expect(result.results[0]?.error).toBe("rpc failed at [url] authorization=[redacted]");
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "rpc failed at [url] authorization=[redacted]",
        raw: { error: "rpc failed at [url] authorization=[redacted]" }
      })
    );
  });

  it("redacts provider evidence errors before storing non-final observations", async () => {
    const observe = vi.fn(async () => true);

    await processSettlementLeg(pendingLeg, {
      recordSettlementObservation: observe,
      resolveLeg: async () => ({
        kind: "observe",
        resolutionState: "settlement_blocked",
        result: "blocked",
        proofKind: "ctf_rpc_quorum_unavailable",
        error: "token=raw-secret",
        nextCheckSeconds: 300,
        raw: {},
        proof: {
          source: "polymarket_ctf",
          proofKind: "ctf_rpc_quorum_unavailable",
          result: "blocked",
          confidence: "api_signal",
          providerEvidence: [
            {
              provider: "provider-1",
              status: "error",
              error: "rpc failed at https://example.test/path?token=raw-secret"
            }
          ],
          raw: {
            providerEvidence: [{ error: "authorization: Bearer raw-secret" }]
          }
        }
      })
    });

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "token=[redacted]",
        providerEvidence: [expect.objectContaining({ error: "rpc failed at [url]" })],
        raw: { providerEvidence: [{ error: "authorization:[redacted]" }] }
      })
    );
  });

  it("processes due ended legs while keeping blocked rows retryable", async () => {
    const listLegs = vi.fn(async () => [pendingLeg]);
    const listBlockedLegs = vi.fn(async () => []);
    const settle = vi.fn(async () => ({
      ticketLegId: "leg-1",
      ticketId: "ticket-1",
      legStatus: "lost" as const,
      ticketStatus: "lost" as const
    }));
    const resolveLeg = vi.fn(async () => ({
      kind: "final" as const,
      result: "lost" as const,
      proof: {
        source: "polymarket_ctf",
        proofKind: "ctf_payout_vector",
        result: "lost" as const,
        confidence: "onchain_confirmed" as const,
        conditionId: "condition-1",
        tokenId: "token-yes",
        outcomeIndex: 0,
        payoutNumerator: "0",
        payoutDenominator: "1",
        payoutVector: ["0", "1"],
        raw: {}
      }
    }));

    const result = await processSettlementBatch({
      listPendingSettlementLegs: listLegs,
      listBlockedSettlementLegs: listBlockedLegs,
      recordLegSettlement: settle,
      resolveLeg
    });

    expect(listLegs).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        dueOnly: true,
        includeBlocked: false
      })
    );
    expect(listBlockedLegs).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        dueOnly: true
      })
    );
    expect(resolveLeg).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketLegId: "leg-1",
        endDate: "2026-07-01T00:00:00.000Z"
      }),
      expect.any(Object)
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketLegId: "leg-1",
        result: "lost"
      })
    );
    expect(result).toMatchObject({
      checked: 1,
      normalChecked: 1,
      blockedChecked: 0,
      results: [{ ticketLegId: "leg-1", status: "processed" }]
    });
  });

  it("processes blocked retry legs from a separate queue", async () => {
    const blockedLeg = {
      ...pendingLeg,
      ticketLegId: "blocked-leg-1",
      resolutionState: "settlement_blocked"
    };
    const listLegs = vi.fn(async () => []);
    const listBlockedLegs = vi.fn(async () => [blockedLeg]);
    const observe = vi.fn(async () => true);

    const result = await processSettlementBatch({
      listPendingSettlementLegs: listLegs,
      listBlockedSettlementLegs: listBlockedLegs,
      recordSettlementObservation: observe,
      resolveLeg: async () => ({
        kind: "observe",
        resolutionState: "settlement_blocked",
        result: "blocked",
        proofKind: "ctf_rpc_quorum_unavailable",
        nextCheckSeconds: 300,
        raw: {}
      })
    });

    expect(result).toMatchObject({
      checked: 1,
      normalChecked: 0,
      blockedChecked: 1,
      results: [{ ticketLegId: "blocked-leg-1", status: "processed" }]
    });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketLegId: "blocked-leg-1",
        resolutionState: "settlement_blocked",
        proofKind: "ctf_rpc_quorum_unavailable"
      })
    );
  });

  it("keeps a failed blocked retry in the blocked queue", async () => {
    const blockedLeg = {
      ...pendingLeg,
      ticketLegId: "blocked-leg-failure",
      resolutionState: "settlement_blocked"
    };
    const observe = vi.fn(async () => true);

    const result = await processSettlementBatch({
      listPendingSettlementLegs: async () => [],
      listBlockedSettlementLegs: async () => [blockedLeg],
      recordSettlementObservation: observe,
      resolveLeg: async () => {
        throw new Error("polygon_rpc_unavailable");
      }
    });

    expect(result.results).toEqual([
      { ticketLegId: "blocked-leg-failure", status: "failed", error: "polygon_rpc_unavailable" }
    ]);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketLegId: "blocked-leg-failure",
        resolutionState: "settlement_blocked",
        proofKind: "resolver_error"
      })
    );
  });

  it("synchronizes durable operational alerts after every settlement batch", async () => {
    const syncOperationalAlerts = vi.fn(async () => ({
      candidates: 1,
      opened: 1,
      escalated: 0,
      reasonChanged: 0,
      remediated: 0
    }));

    const result = await processSettlementCycle({
      listPendingSettlementLegs: async () => [],
      listBlockedSettlementLegs: async () => [],
      syncOperationalAlerts
    });

    expect(syncOperationalAlerts).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      checked: 0,
      alerts: {
        opened: 1
      }
    });
  });

  it("fails the worker cycle when operational alert synchronization fails", async () => {
    await expect(
      processSettlementCycle({
        listPendingSettlementLegs: async () => [],
        listBlockedSettlementLegs: async () => [],
        syncOperationalAlerts: async () => {
          throw new Error("settlement_alert_sync_failed");
        }
      })
    ).rejects.toThrow("settlement_alert_sync_failed");
  });
});
