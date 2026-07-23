import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({ query: db.query, connect: db.connect })
}));

vi.mock("../config", () => ({
  config: {
    SETTLEMENT_CHAIN_ID: 11155111
  }
}));

import { evaluateFreshCanonicalReconciliationGate, financialGateIntegrationHooks } from "../financialGate";
import {
  createReconciliationSnapshot,
  evaluateReconciliationGate,
  reconciliationApiIntegrationHooks
} from "../db/reconciliationRepository";

const treasuryAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const tokenAddress = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

function blockedSnapshotRow() {
  return {
    id: "snapshot-blocked",
    chainId: 11155111,
    currency: "USDC" as const,
    treasuryAssetsMicroUnits: "4000000",
    internalCustodyMicroUnits: "5000000",
    userAvailableMicroUnits: "0",
    userClaimableMicroUnits: "0",
    userCheckoutMicroUnits: "0",
    openStakeMicroUnits: "0",
    openReserveMicroUnits: "0",
    pendingWithdrawalMicroUnits: "0",
    houseEquityMicroUnits: "4000000",
    unexplainedDeltaMicroUnits: "-1000000",
    launchGate: "blocked" as const,
    operationGate: "restricted" as const,
    gateReasons: ["treasury_internal_delta"],
    treasuryAssets: [],
    metrics: {},
    observedBlockNumber: "100",
    observedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source: "worker" as const,
    scopeTreasuryAddress: treasuryAddress,
    scopeTokenAddress: tokenAddress,
    createdAt: new Date("2026-01-01T00:00:00.000Z")
  };
}

describe("financial reconciliation", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.clientQuery.mockReset();
    db.connect.mockReset();
    db.release.mockReset();
    db.connect.mockResolvedValue({ query: db.clientQuery, release: db.release });
  });

  it("blocks launch and restricts operations on unexplained drift", () => {
    const gate = evaluateReconciliationGate({
      unexplainedDeltaMicroUnits: 1_000_000n,
      houseEquityMicroUnits: 25_000_000n,
      pendingWithdrawalMicroUnits: 5_000_000n,
      pendingWithdrawalLedgerMicroUnits: 5_000_000n,
      driftToleranceMicroUnits: 0n,
      operationWarnToleranceMicroUnits: 10_000_000n
    });

    expect(gate).toEqual({
      launchGate: "blocked",
      operationGate: "restricted",
      reasons: ["treasury_internal_delta"]
    });
  });

  it("blocks operations on material drift or negative house equity", () => {
    expect(
      evaluateReconciliationGate({
        unexplainedDeltaMicroUnits: 20_000_000n,
        houseEquityMicroUnits: 25_000_000n,
        pendingWithdrawalMicroUnits: 0n,
        pendingWithdrawalLedgerMicroUnits: 0n,
        driftToleranceMicroUnits: 0n,
        operationWarnToleranceMicroUnits: 10_000_000n
      }).operationGate
    ).toBe("blocked");

    const negativeEquity = evaluateReconciliationGate({
      unexplainedDeltaMicroUnits: 0n,
      houseEquityMicroUnits: -1n,
      pendingWithdrawalMicroUnits: 0n,
      pendingWithdrawalLedgerMicroUnits: 0n
    });

    expect(negativeEquity).toMatchObject({
      launchGate: "blocked",
      operationGate: "blocked",
      reasons: ["negative_house_equity"]
    });
  });

  it("exports exact API and worker integration hooks for Sol to wire later", () => {
    expect(reconciliationApiIntegrationHooks).toEqual({
      latestSnapshot: {
        method: "GET",
        path: "/api/ops/reconciliation/latest",
        repositoryFunction: "getLatestReconciliationSnapshot"
      },
      gateStatus: {
        method: "GET",
        path: "/api/ops/financial-gate",
        moduleFunction: "getFinancialGateDecision"
      },
      snapshotCreation: "worker-only",
      workerEntrypoint: "server/workers/reconciliationWorker.ts",
      workerFunction: "processFinancialReconciliation"
    });
    expect(financialGateIntegrationHooks).toEqual({
      module: "server/financialGate.ts",
      statusFunction: "getFinancialGateDecision",
      assertFunction: "assertFinancialGateOpen",
      transactionAssertFunction: "assertFinancialGateOpenInTransaction",
      setGateFunction: "setFinancialControlGate",
      lockProtocol: {
        order: "first-after-BEGIN",
        moneyTransactions: "shared transaction advisory lock",
        gateMutations: "exclusive transaction advisory lock",
        lockName: "financial-control-gate:global"
      }
    });
  });

  it("fails closed when the latest reconciliation snapshot is absent, stale, or globally blocked", () => {
    expect(evaluateFreshCanonicalReconciliationGate({ now: new Date("2026-01-01T00:00:00.000Z") })).toMatchObject({
      allowed: false,
      launchGate: "blocked",
      operationGate: "blocked",
      reasons: ["reconciliation_snapshot_absent"]
    });

    const stale = evaluateFreshCanonicalReconciliationGate({
      now: new Date("2026-01-01T00:10:01.000Z"),
      maxSnapshotAgeMs: 60_000,
      snapshot: {
        id: "snapshot-stale",
        source: "worker",
        launchGate: "ready",
        operationGate: "open",
        gateReasons: [],
        observedBlockNumber: "100",
        observedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        scopeTreasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        scopeTokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    });
    expect(stale).toMatchObject({
      allowed: false,
      operationGate: "blocked",
      reasons: ["reconciliation_snapshot_stale"]
    });

    const globallyBlocked = evaluateFreshCanonicalReconciliationGate({
      now: new Date("2026-01-01T00:00:30.000Z"),
      snapshot: {
        id: "snapshot-ready",
        source: "worker",
        launchGate: "ready",
        operationGate: "open",
        gateReasons: [],
        observedBlockNumber: "100",
        observedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        scopeTreasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        scopeTokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      controlGate: {
        scope: "global",
        operationGate: "blocked",
        reason: "credited_deposit_reorg",
        metadata: {},
        setAt: "2026-01-01T00:00:10.000Z"
      }
    });
    expect(globallyBlocked).toMatchObject({
      allowed: false,
      operationGate: "blocked",
      reasons: ["financial_gate_blocked:credited_deposit_reorg"]
    });
  });

  it("never opens from a legacy or unscoped snapshot", () => {
    const decision = evaluateFreshCanonicalReconciliationGate({
      now: new Date("2026-01-01T00:00:30.000Z"),
      snapshot: {
        id: "snapshot-manual",
        source: "legacy",
        launchGate: "ready",
        operationGate: "open",
        gateReasons: [],
        observedBlockNumber: "100",
        observedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    });

    expect(decision).toMatchObject({
      allowed: false,
      operationGate: "blocked",
      reasons: ["reconciliation_snapshot_untrusted_provenance"]
    });
  });

  it("publishes a blocked snapshot under the exclusive financial-control lock", async () => {
    db.clientQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM treasury_config")) {
        return { rows: [{ treasuryAddress, tokenAddress }] };
      }
      if (text.includes("GROUP BY ledger_accounts.account_type")) return { rows: [] };
      if (text.includes("FROM ticket_reserves")) return { rows: [{ stake: "0", operationFee: "0", reserve: "0" }] };
      if (text.includes("account_type NOT LIKE")) return { rows: [{ balance: "5000000" }] };
      if (text.includes("FROM withdrawal_requests")) return { rows: [{ pending: "0" }] };
      if (text.includes("INSERT INTO financial_reconciliation_snapshots")) return { rows: [blockedSnapshotRow()] };
      return { rows: [] };
    });

    await expect(
      createReconciliationSnapshot({
        source: "worker",
        chainId: 11155111,
        treasuryAssets: [
          {
            chainId: 11155111,
            treasuryAddress,
            tokenAddress,
            balanceMicroUnits: 4_000_000n,
            blockNumber: 100n,
            blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            source: "onchain"
          }
        ],
        verifyCanonicalBlock: async () => undefined
      })
    ).resolves.toMatchObject({ launchGate: "blocked", operationGate: "restricted" });

    const statements = db.clientQuery.mock.calls.map(([sql]) => String(sql));
    const controlLockIndex = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock(hashtextextended"));
    const reconciliationLockIndex = db.clientQuery.mock.calls.findIndex(
      ([, params]) => Array.isArray(params) && params.includes("financial-reconciliation:11155111:USDC")
    );
    const insertIndex = statements.findIndex((sql) => sql.includes("INSERT INTO financial_reconciliation_snapshots"));

    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(statements[controlLockIndex]).not.toContain("_shared");
    expect(db.clientQuery.mock.calls[controlLockIndex][1]).toEqual(["financial-control-gate:global"]);
    expect(controlLockIndex).toBeLessThan(reconciliationLockIndex);
    expect(reconciliationLockIndex).toBeLessThan(insertIndex);
  });
});
