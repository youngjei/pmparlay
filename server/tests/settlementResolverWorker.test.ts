import { describe, expect, it, vi } from "vitest";
import { processSettlementBatch, processSettlementLeg } from "../workers/settlementResolverWorker";

const pendingLeg = {
  ticketLegId: "leg-1",
  ticketId: "ticket-1",
  quoteId: "quote-1",
  question: "Will test resolve?",
  outcome: "Yes",
  conditionId: "condition-1",
  tokenId: "token-yes",
  endDate: "2026-07-01T00:00:00.000Z",
  status: "pending",
  resolutionState: "pending",
  resolutionAttempts: 0,
  ticketStatus: "live",
  createdAt: "2026-07-06T00:00:00.000Z"
};

describe("settlement resolver worker", () => {
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
          source: "polymarket_clob",
          proofKind: "clob_market_winner",
          result: "won",
          confidence: "api_signal",
          conditionId: "condition-1",
          tokenId: "token-yes",
          winningTokenId: "token-yes",
          raw: {}
        }
      })
    });

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketLegId: "leg-1",
        result: "won",
        source: "polymarket_clob"
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
        proofKind: "clob_market_open",
        nextCheckSeconds: 300,
        raw: {}
      })
    });

    expect(settle).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketLegId: "leg-1",
        resolutionState: "awaiting_oracle",
        result: "pending"
      })
    );
  });

  it("keeps processing a batch when one resolver call fails", async () => {
    const observe = vi.fn(async () => true);
    const result = await processSettlementBatch({
      listPendingSettlementLegs: async () => [pendingLeg],
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

  it("processes due ended legs while excluding blocked settlement rows", async () => {
    const listLegs = vi.fn(async () => [pendingLeg]);
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
        source: "polymarket_clob",
        proofKind: "clob_market_winner",
        result: "lost" as const,
        confidence: "api_signal" as const,
        conditionId: "condition-1",
        tokenId: "token-yes",
        winningTokenId: "token-no",
        raw: {}
      }
    }));

    const result = await processSettlementBatch({
      listPendingSettlementLegs: listLegs,
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
      results: [{ ticketLegId: "leg-1", status: "processed" }]
    });
  });
});
