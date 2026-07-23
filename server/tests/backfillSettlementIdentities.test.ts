import { describe, expect, it, vi } from "vitest";
import { runSettlementIdentityBackfillCommand } from "../backfillSettlementIdentities";

describe("settlement identity backfill command", () => {
  it("reports permanent quarantines and returns a nonzero exit code", async () => {
    const log = vi.fn();
    const backfill = vi
      .fn()
      .mockResolvedValueOnce({
        checked: 2,
        results: [
          { ticketId: "ticket-frozen", status: "frozen" },
          { ticketId: "ticket-quarantined", status: "quarantined", error: "identity_invalid" }
        ]
      })
      .mockResolvedValueOnce({ checked: 0, results: [] });

    const result = await runSettlementIdentityBackfillCommand({
      limit: 2,
      batches: 5,
      backfill: backfill as never,
      quarantineSummary: async () => ({ unresolved: 1, permanent: 1, retryable: 0 }),
      log
    });

    expect(backfill).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ checked: 2, frozen: 1, quarantined: 1, retryable: 0, skipped: 0, exitCode: 1 });
    expect(JSON.parse(log.mock.calls.at(-1)?.[0])).toMatchObject({
      event: "settlement.identity_backfill.complete",
      remaining: { unresolved: 1, permanent: 1, retryable: 0 },
      ok: false
    });
  });

  it("keeps retryable quarantines resumable while still reporting failure", async () => {
    const result = await runSettlementIdentityBackfillCommand({
      limit: 10,
      batches: 1,
      backfill: async () => ({
        checked: 1,
        results: [{ ticketId: "ticket-retry", status: "retryable", error: "rpc_unavailable" }]
      }),
      quarantineSummary: async () => ({ unresolved: 1, permanent: 0, retryable: 1 }),
      log: vi.fn()
    });

    expect(result).toMatchObject({ retryable: 1, remaining: { retryable: 1 }, exitCode: 1 });
  });

  it("returns success only when no unresolved quarantines remain", async () => {
    const result = await runSettlementIdentityBackfillCommand({
      limit: 10,
      batches: 1,
      backfill: async () => ({ checked: 1, results: [{ ticketId: "ticket-frozen", status: "frozen" }] }),
      quarantineSummary: async () => ({ unresolved: 0, permanent: 0, retryable: 0 }),
      log: vi.fn()
    });

    expect(result).toMatchObject({ checked: 1, frozen: 1, drained: true, exitCode: 0 });
  });

  it("returns failure when an explicit batch cap leaves an uninspected page", async () => {
    const result = await runSettlementIdentityBackfillCommand({
      limit: 2,
      batches: 1,
      backfill: async () => ({
        checked: 2,
        results: [
          { ticketId: "ticket-a", status: "frozen" },
          { ticketId: "ticket-b", status: "frozen" }
        ]
      }),
      quarantineSummary: async () => ({ unresolved: 0, permanent: 0, retryable: 0 }),
      log: vi.fn()
    });

    expect(result).toMatchObject({ checked: 2, drained: false, exitCode: 1 });
  });

  it("drains all pages by default instead of silently stopping after the first full batch", async () => {
    const backfill = vi
      .fn()
      .mockResolvedValueOnce({ checked: 2, results: [{ ticketId: "ticket-a", status: "frozen" }, { ticketId: "ticket-b", status: "frozen" }] })
      .mockResolvedValueOnce({ checked: 1, results: [{ ticketId: "ticket-c", status: "frozen" }] });

    const result = await runSettlementIdentityBackfillCommand({
      limit: 2,
      backfill: backfill as never,
      quarantineSummary: async () => ({ unresolved: 0, permanent: 0, retryable: 0 }),
      log: vi.fn()
    });

    expect(backfill).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ checked: 3, frozen: 3, drained: true, exitCode: 0 });
  });
});
