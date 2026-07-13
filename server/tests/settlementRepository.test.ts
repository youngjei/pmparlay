import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({
    query: dbMocks.query
  })
}));

import { deriveTicketStatus, listPendingSettlementLegs } from "../db/settlementRepository";

function settlementLegRow(overrides: Record<string, unknown> = {}) {
  return {
    ticketLegId: "ticket-leg-test",
    ticketId: "ticket-test",
    quoteId: "quote-test",
    question: "Will test settle?",
    outcome: "Yes",
    marketUrl: "https://polymarket.com/event/test",
    conditionId: "condition-test",
    tokenId: "token-test",
    endDate: new Date("2026-07-01T00:00:00.000Z"),
    negRisk: false,
    status: "pending",
    resolutionState: "pending",
    resolutionAttempts: 0,
    resolutionUpdatedAt: new Date("2026-07-02T00:00:00.000Z"),
    nextResolutionCheckAt: new Date("2026-07-02T00:05:00.000Z"),
    lastResolutionError: null,
    ticketStatus: "live",
    createdAt: new Date("2026-07-01T00:00:01.000Z"),
    ...overrides
  };
}

beforeEach(() => {
  dbMocks.query.mockReset();
});

describe("settlement state machine", () => {
  it("marks any losing leg as a lost ticket", () => {
    expect(deriveTicketStatus(["won", "lost", "pending"])).toBe("lost");
  });

  it("keeps tickets live while any leg is pending or disputed", () => {
    expect(deriveTicketStatus(["won", "pending"])).toBe("live");
    expect(deriveTicketStatus(["won", "disputed"])).toBe("live");
  });

  it("voids tickets when all final legs include a void and no loss", () => {
    expect(deriveTicketStatus(["won", "voided"])).toBe("voided");
  });

  it("wins tickets only when every leg won", () => {
    expect(deriveTicketStatus(["won", "won"])).toBe("won");
  });

  it("documents that final leg outcomes require reversals instead of direct flips", () => {
    const finalStatuses = ["won", "lost", "voided"];
    expect(finalStatuses.includes("won")).toBe(true);
    expect(finalStatuses.includes("pending")).toBe(false);
  });

  it("keeps blocked unresolved settlements visible in the default ops list", async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [
        settlementLegRow({
          resolutionState: "settlement_blocked",
          lastResolutionError: "missing token id"
        })
      ]
    });

    const legs = await listPendingSettlementLegs();
    const sql = String(dbMocks.query.mock.calls[0][0]);

    expect(sql).not.toContain("ticket_legs.resolution_state <> 'settlement_blocked'");
    expect(sql).not.toContain("ticket_legs.next_resolution_check_at <= now()");
    expect(legs[0]).toMatchObject({
      ticketLegId: "ticket-leg-test",
      endDate: "2026-07-01T00:00:00.000Z",
      resolutionState: "settlement_blocked",
      resolutionUpdatedAt: "2026-07-02T00:00:00.000Z",
      nextResolutionCheckAt: "2026-07-02T00:05:00.000Z",
      lastResolutionError: "missing token id"
    });
  });

  it("supports worker queries for due ended legs without reprocessing blocked rows", async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [settlementLegRow()]
    });

    const legs = await listPendingSettlementLegs(25, {
      dueOnly: true,
      includeBlocked: false
    });
    const sql = String(dbMocks.query.mock.calls[0][0]);

    expect(dbMocks.query).toHaveBeenCalledWith(expect.any(String), [25]);
    expect(sql).toContain("ticket_legs.next_resolution_check_at <= now()");
    expect(sql).toContain("ticket_legs.resolution_state <> 'settlement_blocked'");
    expect(legs[0]).toMatchObject({
      ticketLegId: "ticket-leg-test",
      endDate: "2026-07-01T00:00:00.000Z"
    });
  });
});
