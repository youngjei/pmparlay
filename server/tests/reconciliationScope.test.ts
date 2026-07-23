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
    NODE_ENV: "test",
    SETTLEMENT_CHAIN_ID: 11155111,
    TREASURY_SAFE_ADDRESS: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    USDC_CONTRACT_ADDRESS: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    USDC_REQUIRED_CONFIRMATIONS: 12
  }
}));

import { config } from "../config";
import { createReconciliationSnapshot, getLatestReconciliationSnapshot } from "../db/reconciliationRepository";

describe("trusted reconciliation snapshot scope", () => {
  beforeEach(() => {
    config.NODE_ENV = "test";
    db.query.mockReset();
    db.clientQuery.mockReset();
    db.connect.mockReset();
    db.release.mockReset();
    db.connect.mockResolvedValue({ query: db.clientQuery, release: db.release });
  });

  it("reads production snapshots directly from the immutable deployment treasury scope", async () => {
    config.NODE_ENV = "production";
    db.query.mockResolvedValue({ rows: [] });

    await expect(getLatestReconciliationSnapshot()).resolves.toBeUndefined();

    const [sql, params] = db.query.mock.calls[0];
    expect(String(sql)).not.toContain("JOIN treasury_config");
    expect(String(sql)).toContain("lower(snapshots.scope_treasury_address) = lower($2)");
    expect(String(sql)).toContain("lower(snapshots.scope_token_address) = lower($3)");
    expect(params).toEqual([
      11155111,
      "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD",
      "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
    ]);
  });

  it("filters latest snapshots to worker/onchain provenance and the active payment treasury", async () => {
    db.query.mockResolvedValue({ rows: [] });

    await expect(getLatestReconciliationSnapshot()).resolves.toBeUndefined();

    expect(db.query).toHaveBeenCalledOnce();
    const [sql, params] = db.query.mock.calls[0];
    expect(String(sql)).toContain("snapshots.source = 'worker'");
    expect(String(sql)).toContain("active_treasury.active = true");
    expect(String(sql)).toContain("treasury_assets->0->>'source' = 'onchain'");
    expect(String(sql)).toContain("scope_treasury_address");
    expect(String(sql)).toContain("scope_token_address");
    expect(params).toEqual([11155111]);
  });

  it("reads decoded JSONB fields from the active worker snapshot", async () => {
    db.query.mockResolvedValue({
      rows: [
        {
          id: "snapshot-ready",
          chainId: 11155111,
          currency: "USDC",
          treasuryAssetsMicroUnits: "5000000",
          internalCustodyMicroUnits: "5000000",
          userAvailableMicroUnits: "0",
          userClaimableMicroUnits: "0",
          userCheckoutMicroUnits: "0",
          openStakeMicroUnits: "0",
          openReserveMicroUnits: "0",
          pendingWithdrawalMicroUnits: "0",
          houseEquityMicroUnits: "5000000",
          unexplainedDeltaMicroUnits: "0",
          launchGate: "ready",
          operationGate: "open",
          gateReasons: [],
          treasuryAssets: [{ balanceMicroUnits: "5000000" }],
          metrics: { treasuryAssetCount: "1" },
          observedBlockNumber: "100",
          observedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source: "worker",
          scopeTreasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          scopeTokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
          createdAt: new Date("2026-01-01T00:00:00.000Z")
        }
      ]
    });

    await expect(getLatestReconciliationSnapshot()).resolves.toMatchObject({
      treasuryAssets: [{ balanceMicroUnits: "5000000" }],
      metrics: { treasuryAssetCount: "1" }
    });

    expect(String(db.query.mock.calls[0][0])).toContain("snapshots.id");
    expect(String(db.query.mock.calls[0][0])).toContain("snapshots.currency");
  });

  it("rejects non-worker snapshot creation before touching the database", async () => {
    await expect(
      createReconciliationSnapshot({
        source: "manual" as never,
        chainId: 11155111,
        treasuryAssets: [],
        verifyCanonicalBlock: async () => undefined
      })
    ).rejects.toThrow("reconciliation_snapshot_source_untrusted");
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("runs the canonical verifier directly before inserting a worker snapshot", async () => {
    const events: string[] = [];
    db.clientQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM treasury_config")) {
        return {
          rows: [
            {
              treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              tokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"
            }
          ]
        };
      }
      if (text.includes("GROUP BY ledger_accounts.account_type")) return { rows: [] };
      if (text.includes("FROM ticket_reserves")) return { rows: [{ stake: "0", operationFee: "0", reserve: "0" }] };
      if (text.includes("account_type NOT LIKE")) return { rows: [{ balance: "5000000" }] };
      if (text.includes("FROM withdrawal_requests")) return { rows: [{ pending: "0" }] };
      if (text.includes("INSERT INTO financial_reconciliation_snapshots")) {
        events.push("insert");
        return {
          rows: [
            {
              id: "snapshot-ready",
              chainId: 11155111,
              currency: "USDC",
              treasuryAssetsMicroUnits: "5000000",
              internalCustodyMicroUnits: "5000000",
              userAvailableMicroUnits: "0",
              userClaimableMicroUnits: "0",
              userCheckoutMicroUnits: "0",
              openStakeMicroUnits: "0",
              openReserveMicroUnits: "0",
              pendingWithdrawalMicroUnits: "0",
              houseEquityMicroUnits: "5000000",
              unexplainedDeltaMicroUnits: "0",
              launchGate: "ready",
              operationGate: "open",
              gateReasons: [],
              treasuryAssets: [],
              metrics: {},
              observedBlockNumber: "100",
              observedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              source: "worker",
              scopeTreasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              scopeTokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
              createdAt: new Date("2026-01-01T00:00:00.000Z")
            }
          ]
        };
      }
      return { rows: [] };
    });

    await createReconciliationSnapshot({
      source: "worker",
      chainId: 11155111,
      treasuryAssets: [
        {
          chainId: 11155111,
          treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          tokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
          balanceMicroUnits: 5_000_000n,
          blockNumber: 100n,
          blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source: "onchain"
        }
      ],
      verifyCanonicalBlock: async () => {
        events.push("verify");
      }
    });

    expect(events).toEqual(["verify", "insert"]);

    const insertCall = db.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO financial_reconciliation_snapshots"));
    expect(insertCall).toBeDefined();
    const insertParams = insertCall?.[1] as unknown[];
    expect(insertParams[14]).toBe(JSON.stringify([]));
    expect(typeof insertParams[15]).toBe("string");
    expect(JSON.parse(insertParams[15] as string)).toEqual([
      {
        chainId: 11155111,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        tokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
        balanceMicroUnits: "5000000",
        blockNumber: "100",
        blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "onchain"
      }
    ]);
    expect(insertParams[16]).toBe(JSON.stringify({
      knownLiabilitiesMicroUnits: "0",
      pendingWithdrawalLedgerMicroUnits: "0",
      houseOperatingLedgerMicroUnits: "0",
      houseReserveLedgerMicroUnits: "0",
      openOperationFeeMicroUnits: "0",
      treasuryAssetCount: "1"
    }));
  });
});
