import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({
    connect: async () => dbMocks
  })
}));

import {
  blockDepositScannerForMissingAncestor,
  creditConfirmedDeposit,
  markReorgedDeposits
} from "../db/depositRepository";

beforeEach(() => {
  dbMocks.query.mockReset();
  dbMocks.release.mockReset();
});

describe("deposit repository reorg compensation", () => {
  it("does not silently restore a credited reorged deposit on duplicate observation", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT") || text.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO onchain_deposits")) return { rows: [] };
      if (text.includes("FROM onchain_deposits") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000010",
              status: "reorged",
              credited_transaction_id: "00000000-0000-0000-0000-000000000020",
              block_number: "100",
              block_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              from_address: "0x1234567890abcdef1234567890abcdef12345678",
              to_address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              token_address: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
              amount_micro_units: "5000000"
            }
          ]
        };
      }
      if (text.includes("FROM house_funding_evidence")) return { rows: [] };
      if (text.includes("SET confirmations = GREATEST")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await creditConfirmedDeposit({
      chainId: 11155111,
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      logIndex: 4,
      blockNumber: 100n,
      blockHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fromAddress: "0x1234567890abcdef1234567890abcdef12345678",
      toAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      amountMicroUnits: 5_000_000n,
      confirmations: 20,
      raw: {}
    });

    expect(result).toEqual({
      id: "00000000-0000-0000-0000-000000000010",
      status: "duplicate",
      ledgerTransactionId: "00000000-0000-0000-0000-000000000020",
      reorgRestored: false
    });
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("status = 'credited'"))).toBe(false);
    const sharedLockIndex = dbMocks.query.mock.calls.findIndex(([sql]) => String(sql).includes("pg_advisory_xact_lock_shared"));
    const observationInsertIndex = dbMocks.query.mock.calls.findIndex(([sql]) => String(sql).includes("INSERT INTO onchain_deposits"));
    expect(sharedLockIndex).toBeGreaterThan(-1);
    expect(sharedLockIndex).toBeLessThan(observationInsertIndex);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("FROM financial_control_gates"))).toBe(false);
  });

  it("compensates credited orphan deposits and blocks the financial gate transactionally", async () => {
    let candidateReads = 0;
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT") || text.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (text.includes("FROM onchain_deposits") && text.includes("FOR UPDATE")) {
        candidateReads += 1;
        return {
          rows:
            candidateReads === 1
              ? [
                  {
                    id: "00000000-0000-0000-0000-000000000010",
                    tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    log_index: 4,
                    block_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    status: "credited",
                    credited_transaction_id: "00000000-0000-0000-0000-000000000020",
                    payment_intent_id: "00000000-0000-0000-0000-000000000030",
                    user_id: "00000000-0000-0000-0000-000000000001",
                    wallet_id: "00000000-0000-0000-0000-000000000002",
                    amount_micro_units: "5000000"
                  }
                ]
              : []
        };
      }
      if (text.includes("FROM house_funding_evidence")) return { rows: [] };
      if (text.includes("INSERT INTO ledger_entries") && text.includes("-ledger_entries.amount_micro_units")) {
        return {
          rowCount: 2,
          rows: [{ id: "entry-1" }, { id: "entry-2" }]
        };
      }
      if (
        text.includes("INSERT INTO financial_incidents") ||
        text.includes("INSERT INTO financial_control_gates") ||
        text.includes("UPDATE onchain_deposits") ||
        text.includes("INSERT INTO audit_log")
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await markReorgedDeposits({
      chainId: 11155111,
      fromBlock: 90n,
      toBlock: 100n,
      toAddresses: ["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"],
      tokenAddresses: ["0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"],
      canonicalFacts: [],
      reason: "cursor_block_hash_mismatch"
    });

    expect(result).toEqual({
      reorged: 1,
      creditedReorged: 1,
      houseFundingReorged: 0
    });
    const compensationCall = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("-ledger_entries.amount_micro_units"));
    expect(compensationCall?.[1]?.[1]).toBe("00000000-0000-0000-0000-000000000020");
    const gateCall = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO financial_control_gates"));
    expect(gateCall?.[1]?.[0]).toBe("blocked");
    expect(gateCall?.[1]?.[1]).toBe("credited_deposit_reorg");
    const exclusiveLockIndex = dbMocks.query.mock.calls.findIndex(([sql]) => String(sql).includes("pg_advisory_xact_lock(hashtextextended"));
    const candidateLockIndex = dbMocks.query.mock.calls.findIndex(([sql]) => String(sql).includes("FROM onchain_deposits"));
    expect(exclusiveLockIndex).toBeGreaterThan(-1);
    expect(exclusiveLockIndex).toBeLessThan(candidateLockIndex);
    const replay = await markReorgedDeposits({
      chainId: 11155111,
      fromBlock: 90n,
      toBlock: 100n,
      toAddresses: ["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"],
      tokenAddresses: ["0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"],
      canonicalFacts: [],
      reason: "overlap_block_hash_mismatch"
    });
    expect(replay).toEqual({ reorged: 0, creditedReorged: 0, houseFundingReorged: 0 });
    expect(dbMocks.query.mock.calls.filter(([sql]) => String(sql).includes("-ledger_entries.amount_micro_units"))).toHaveLength(1);
    expect(dbMocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO financial_control_gates"))).toHaveLength(1);
    expect(dbMocks.release).toHaveBeenCalledTimes(2);
  });

  it("compensates orphaned house funding once and records a critical incident", async () => {
    let fundingReads = 0;
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT") || text.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (text.includes("FROM onchain_deposits") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("FROM house_funding_evidence")) {
        fundingReads += 1;
        return {
          rows:
            fundingReads === 1
              ? [{
                  id: "00000000-0000-0000-0000-000000000040",
                  tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  log_index: 7,
                  block_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                  amount_micro_units: "5000000",
                  ledger_transaction_id: "00000000-0000-0000-0000-000000000050"
                }]
              : []
        };
      }
      if (text.includes("INSERT INTO ledger_entries") && text.includes("house funding reorg compensation")) {
        return { rowCount: 2, rows: [{ id: "entry-1" }, { id: "entry-2" }] };
      }
      if (
        text.includes("INSERT INTO financial_incidents") ||
        text.includes("INSERT INTO house_funding_reorgs") ||
        text.includes("INSERT INTO audit_log") ||
        text.includes("INSERT INTO financial_control_gates")
      ) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const input = {
      chainId: 11155111,
      fromBlock: 90n,
      toBlock: 100n,
      toAddresses: ["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"],
      tokenAddresses: ["0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"],
      canonicalFacts: [],
      reason: "overlap_rescan"
    };
    await expect(markReorgedDeposits(input)).resolves.toEqual({
      reorged: 0,
      creditedReorged: 0,
      houseFundingReorged: 1
    });
    await expect(markReorgedDeposits(input)).resolves.toEqual({
      reorged: 0,
      creditedReorged: 0,
      houseFundingReorged: 0
    });
    const compensation = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("house funding reorg compensation"));
    expect(compensation?.[1]?.[1]).toBe("00000000-0000-0000-0000-000000000050");
    const gate = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO financial_control_gates"));
    expect(gate?.[1]?.slice(0, 2)).toEqual(["blocked", "house_funding_reorg"]);
  });

  it("creates one critical scanner-integrity incident under the exclusive gate lock", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT") || text.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (text.includes("FROM financial_incidents")) return { rows: [] };
      if (
        text.includes("INSERT INTO financial_incidents") ||
        text.includes("INSERT INTO financial_control_gates") ||
        text.includes("INSERT INTO audit_log")
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await blockDepositScannerForMissingAncestor({
      chainId: 11155111,
      cursorName: "usdc-deposits",
      previousCursorBlock: 100n,
      lookbackFromBlock: 96n,
      mismatchedBlocks: [96n, 97n, 98n, 99n, 100n]
    });

    expect(result.incidentId).toMatch(/^[a-f0-9-]{36}$/);
    const exclusiveLockIndex = dbMocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("pg_advisory_xact_lock(hashtextextended")
    );
    const incidentReadIndex = dbMocks.query.mock.calls.findIndex(([sql]) => String(sql).includes("FROM financial_incidents"));
    expect(exclusiveLockIndex).toBeLessThan(incidentReadIndex);
    const gateCall = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO financial_control_gates"));
    expect(gateCall?.[1]?.slice(0, 2)).toEqual(["blocked", "deposit_scanner_common_ancestor_missing"]);
  });
});
