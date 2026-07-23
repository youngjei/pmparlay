import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    SETTLEMENT_CHAIN_ID: 11155111
  }
}));

import {
  assertFinancialGateOpenInTransaction,
  financialControlLockName,
  setFinancialControlGate
} from "../financialGate";

function readySnapshotRow() {
  return {
    id: "snapshot-ready",
    chainId: 11155111,
    currency: "USDC" as const,
    treasuryAssetsMicroUnits: "5000000",
    internalCustodyMicroUnits: "5000000",
    userAvailableMicroUnits: "5000000",
    userClaimableMicroUnits: "0",
    userCheckoutMicroUnits: "0",
    openStakeMicroUnits: "0",
    openReserveMicroUnits: "0",
    pendingWithdrawalMicroUnits: "0",
    houseEquityMicroUnits: "0",
    unexplainedDeltaMicroUnits: "0",
    launchGate: "ready" as const,
    operationGate: "open" as const,
    gateReasons: [],
    treasuryAssets: [],
    metrics: {},
    observedBlockNumber: "100",
    observedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source: "worker" as const,
    scopeTreasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    scopeTokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    createdAt: new Date("2026-01-01T00:00:00.000Z")
  };
}

describe("transaction-aware financial gate", () => {
  const query = vi.fn();
  const client = { query } as never;

  beforeEach(() => {
    query.mockReset();
  });

  it("takes the shared transaction lock before locking and reading gate/snapshot state", async () => {
    query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM financial_control_gates")) return { rows: [] };
      if (text.includes("FROM financial_reconciliation_snapshots")) return { rows: [readySnapshotRow()] };
      return { rows: [] };
    });

    await expect(
      assertFinancialGateOpenInTransaction(client, {
        now: new Date("2026-01-01T00:00:30.000Z"),
        operation: "test.money"
      })
    ).resolves.toMatchObject({ allowed: true, snapshotId: "snapshot-ready" });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe("SAVEPOINT financial_gate_transaction_guard");
    expect(statements[1]).toBe("RELEASE SAVEPOINT financial_gate_transaction_guard");
    expect(statements[2]).toContain("pg_advisory_xact_lock_shared");
    expect(query.mock.calls[2][1]).toEqual([financialControlLockName]);
    expect(statements.find((sql) => sql.includes("FROM financial_control_gates"))).toContain("FOR SHARE");
    expect(statements.find((sql) => sql.includes("FROM financial_reconciliation_snapshots"))).toContain(
      "FOR SHARE OF snapshots, active_treasury"
    );
  });

  it("requires an existing transaction before any gate read", async () => {
    query.mockRejectedValueOnce(new Error("SAVEPOINT can only be used in transaction blocks"));

    await expect(assertFinancialGateOpenInTransaction(client)).rejects.toThrow("transaction blocks");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("makes gate setters take the matching exclusive transaction lock before mutation", async () => {
    query.mockResolvedValue({ rows: [] });

    await setFinancialControlGate(client, {
      operationGate: "blocked",
      reason: "test_incident"
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[2]).toContain("pg_advisory_xact_lock(hashtextextended");
    expect(statements[2]).not.toContain("_shared");
    expect(query.mock.calls[2][1]).toEqual([financialControlLockName]);
    expect(statements[3]).toContain("INSERT INTO financial_control_gates");
  });
});
