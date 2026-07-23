import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({ query: db.query, connect: db.connect })
}));

import {
  listOpenSettlementOperationalAlerts,
  syncSettlementOperationalAlerts
} from "../db/settlementAlertRepository";

const now = new Date("2026-07-14T00:00:00.000Z");

describe("settlement operational alerts", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.release.mockReset();
    db.connect.mockReset();
    db.connect.mockResolvedValue({ query: db.query, release: db.release });
  });

  it("opens one durable warning and outbox event for an overdue leg", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("UPDATE financial_incidents AS incident")) return { rows: [] };
      if (text.includes("FROM ticket_legs") && text.includes("ticket_legs.settlement_due_at <=")) {
        return {
          rows: [
            {
              ticketLegId: "00000000-0000-0000-0000-000000000001",
              ticketId: "00000000-0000-0000-0000-000000000002",
              resolutionState: "awaiting_oracle",
              marketEndDate: new Date("2026-07-12T12:00:00.000Z"),
              resolutionAttempts: 8,
              lastResolutionError: null
            }
          ]
        };
      }
      if (text.includes("INSERT INTO financial_incidents")) {
        return { rows: [{ id: "00000000-0000-0000-0000-000000000003" }] };
      }
      if (text.includes("INSERT INTO audit_log")) return { rows: [] };
      if (text.includes("INSERT INTO outbox")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await syncSettlementOperationalAlerts({
      now,
      warningAfterMs: 24 * 60 * 60_000,
      criticalAfterMs: 72 * 60 * 60_000
    });

    expect(result).toEqual({ candidates: 1, opened: 1, escalated: 0, reasonChanged: 0, remediated: 0 });
    const incidentCall = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO financial_incidents"));
    expect(incidentCall?.[1]).toEqual([
      "warning",
      "settlement_leg_attention",
      "00000000-0000-0000-0000-000000000001",
      "resolution_overdue",
      expect.objectContaining({
        overdueMs: 36 * 60 * 60_000,
        requiredAction: expect.stringContaining("Do not settle manually")
      })
    ]);
    const outboxCall = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO outbox"));
    expect(outboxCall?.[1]?.[0]).toBe("settlement.alert.opened");
  });

  it("treats a technically blocked leg as immediately critical and redacts its error", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("UPDATE financial_incidents AS incident")) return { rows: [] };
      if (text.includes("FROM ticket_legs") && text.includes("ticket_legs.settlement_due_at <=")) {
        return {
          rows: [
            {
              ticketLegId: "00000000-0000-0000-0000-000000000001",
              ticketId: "00000000-0000-0000-0000-000000000002",
              resolutionState: "settlement_blocked",
              marketEndDate: null,
              resolutionAttempts: 1,
              lastResolutionError: "rpc https://user:pass@example.test/path?api_key=secret"
            }
          ]
        };
      }
      if (text.includes("INSERT INTO financial_incidents")) {
        return { rows: [{ id: "00000000-0000-0000-0000-000000000003" }] };
      }
      if (text.includes("INSERT INTO audit_log")) return { rows: [] };
      if (text.includes("INSERT INTO outbox")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    await syncSettlementOperationalAlerts({ now, warningAfterMs: 1_000, criticalAfterMs: 2_000 });

    const incidentCall = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO financial_incidents"));
    expect(incidentCall?.[1]).toEqual([
      "critical",
      "settlement_leg_attention",
      "00000000-0000-0000-0000-000000000001",
      "settlement_blocked",
      expect.objectContaining({
        lastResolutionError: "rpc [url]"
      })
    ]);
  });

  it("escalates an existing warning once without opening a duplicate", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("UPDATE financial_incidents AS incident")) return { rows: [] };
      if (text.includes("FROM ticket_legs") && text.includes("ticket_legs.settlement_due_at <=")) {
        return {
          rows: [
            {
              ticketLegId: "00000000-0000-0000-0000-000000000001",
              ticketId: "00000000-0000-0000-0000-000000000002",
              resolutionState: "awaiting_oracle",
              marketEndDate: new Date("2026-07-10T00:00:00.000Z"),
              resolutionAttempts: 20,
              lastResolutionError: null
            }
          ]
        };
      }
      if (text.includes("INSERT INTO financial_incidents")) return { rows: [] };
      if (text.includes("SELECT id, severity") && text.includes("financial_incidents")) {
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000003",
              severity: "warning",
              reason: "resolution_overdue"
            }
          ]
        };
      }
      if (text.includes("UPDATE financial_incidents") && !text.includes("AS incident")) return { rows: [] };
      if (text.includes("INSERT INTO audit_log")) return { rows: [] };
      if (text.includes("INSERT INTO outbox")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await syncSettlementOperationalAlerts({
      now,
      warningAfterMs: 24 * 60 * 60_000,
      criticalAfterMs: 72 * 60 * 60_000
    });

    expect(result).toEqual({ candidates: 1, opened: 0, escalated: 1, reasonChanged: 0, remediated: 0 });
    const topics = db.query.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO outbox"))
      .map(([, params]) => params[0]);
    expect(topics).toEqual(["settlement.alert.escalated"]);
  });

  it("auto-remediates alerts whose legs no longer require attention", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("UPDATE financial_incidents AS incident")) {
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000003",
              entityId: "00000000-0000-0000-0000-000000000001"
            }
          ]
        };
      }
      if (text.includes("FROM ticket_legs") && text.includes("ticket_legs.settlement_due_at <=")) return { rows: [] };
      if (text.includes("INSERT INTO audit_log")) return { rows: [] };
      if (text.includes("INSERT INTO outbox")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await syncSettlementOperationalAlerts({ now, warningAfterMs: 1_000, criticalAfterMs: 2_000 });
    expect(result.remediated).toBe(1);
    const outboxCall = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO outbox"));
    expect(outboxCall?.[1]).toEqual([
      "settlement.alert.remediated",
      {
        incidentId: "00000000-0000-0000-0000-000000000003",
        ticketLegId: "00000000-0000-0000-0000-000000000001"
      }
    ]);
  });

  it("opens an immediate critical data-quality alert when a frozen legacy leg has no due time", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("UPDATE financial_incidents AS incident")) return { rows: [] };
      if (text.includes("FROM ticket_legs") && text.includes("ticket_legs.settlement_due_at <=")) {
        return {
          rows: [
            {
              ticketLegId: "00000000-0000-0000-0000-000000000001",
              ticketId: "00000000-0000-0000-0000-000000000002",
              resolutionState: "pending",
              marketEndDate: null,
              resolutionAttempts: 0,
              lastResolutionError: null
            }
          ]
        };
      }
      if (text.includes("INSERT INTO financial_incidents")) {
        return { rows: [{ id: "00000000-0000-0000-0000-000000000003" }] };
      }
      if (text.includes("INSERT INTO audit_log") || text.includes("INSERT INTO outbox")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    await syncSettlementOperationalAlerts({ now, warningAfterMs: 1_000, criticalAfterMs: 2_000 });
    const incidentCall = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO financial_incidents"));
    expect(incidentCall?.[1]).toEqual([
      "critical",
      "settlement_leg_attention",
      "00000000-0000-0000-0000-000000000001",
      "settlement_due_at_missing",
      expect.objectContaining({ requiredAction: expect.stringContaining("Quarantine the legacy leg") })
    ]);
  });

  it("emits a reason change without downgrading an existing critical incident", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("UPDATE financial_incidents AS incident")) return { rows: [] };
      if (text.includes("FROM ticket_legs") && text.includes("ticket_legs.settlement_due_at <=")) {
        return {
          rows: [
            {
              ticketLegId: "00000000-0000-0000-0000-000000000001",
              ticketId: "00000000-0000-0000-0000-000000000002",
              resolutionState: "awaiting_oracle",
              marketEndDate: new Date("2026-07-12T12:00:00.000Z"),
              resolutionAttempts: 9,
              lastResolutionError: null
            }
          ]
        };
      }
      if (text.includes("INSERT INTO financial_incidents")) return { rows: [] };
      if (text.includes("SELECT id, severity, reason")) {
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000003",
              severity: "critical",
              reason: "settlement_blocked"
            }
          ]
        };
      }
      if (text.includes("UPDATE financial_incidents") || text.includes("INSERT INTO audit_log") || text.includes("INSERT INTO outbox")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await syncSettlementOperationalAlerts({
      now,
      warningAfterMs: 24 * 60 * 60_000,
      criticalAfterMs: 72 * 60 * 60_000
    });

    expect(result).toMatchObject({ escalated: 0, reasonChanged: 1 });
    const update = db.query.mock.calls.find(
      ([sql]) => String(sql).includes("UPDATE financial_incidents") && !String(sql).includes("AS incident")
    );
    expect(update?.[1]?.slice(1, 4)).toEqual(["critical", "resolution_overdue", expect.any(Object)]);
    const outbox = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO outbox"));
    expect(outbox?.[1]?.[0]).toBe("settlement.alert.reason_changed");
  });

  it("rolls back atomically when alert persistence fails", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM ticket_legs") && text.includes("ticket_legs.settlement_due_at <=")) {
        return {
          rows: [
            {
              ticketLegId: "00000000-0000-0000-0000-000000000001",
              ticketId: "00000000-0000-0000-0000-000000000002",
              resolutionState: "settlement_blocked",
              marketEndDate: null,
              resolutionAttempts: 1,
              lastResolutionError: null
            }
          ]
        };
      }
      if (text.includes("INSERT INTO financial_incidents")) throw new Error("database_write_failed");
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(syncSettlementOperationalAlerts({ now, warningAfterMs: 1_000, criticalAfterMs: 2_000 })).rejects.toThrow(
      "database_write_failed"
    );
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("lists critical alerts before warnings without exposing raw incident metadata", async () => {
    db.query.mockResolvedValue({
      rows: [
        {
          id: "00000000-0000-0000-0000-000000000003",
          severity: "critical",
          ticketLegId: "00000000-0000-0000-0000-000000000001",
          ticketId: "00000000-0000-0000-0000-000000000002",
          resolutionState: "settlement_blocked",
          reason: "settlement_blocked",
          marketEndDate: null,
          overdueMs: null,
          resolutionAttempts: 4,
          lastResolutionError: "quorum unavailable",
          createdAt: now
        }
      ]
    });

    await expect(listOpenSettlementOperationalAlerts(20)).resolves.toEqual([
      {
        id: "00000000-0000-0000-0000-000000000003",
        severity: "critical",
        ticketLegId: "00000000-0000-0000-0000-000000000001",
        ticketId: "00000000-0000-0000-0000-000000000002",
        resolutionState: "settlement_blocked",
        reason: "settlement_blocked",
        resolutionAttempts: 4,
        lastResolutionError: "quorum unavailable",
        createdAt: now.toISOString()
      }
    ]);
    expect(String(db.query.mock.calls[0][0])).toContain("CASE severity WHEN 'critical' THEN 0 ELSE 1 END");
  });
});
