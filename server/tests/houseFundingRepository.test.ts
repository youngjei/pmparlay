import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
const gate = vi.hoisted(() => ({ lock: vi.fn() }));

vi.mock("../db/client", () => ({ getPool: () => ({ connect: db.connect }) }));
vi.mock("../financialGate", () => ({ lockFinancialControlGateForMoney: gate.lock }));

import { recordVerifiedHouseFunding } from "../db/houseFundingRepository";

const funding = {
  chainId: 11155111,
  txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  logIndex: 7,
  blockNumber: 100n,
  blockHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  fromAddress: "0x1234567890abcdef1234567890abcdef12345678",
  toAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  tokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  amountMicroUnits: 9_007_199_254_740_993n,
  confirmations: 12,
  receipt: { transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  operatorId: "operator-a",
  approverId: "operator-b",
  reason: "Recorded after independent Safe review"
};

describe("house funding repository", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.release.mockReset();
    db.connect.mockReset();
    db.connect.mockResolvedValue({ query: db.query, release: db.release });
    gate.lock.mockReset();
    gate.lock.mockResolvedValue(undefined);
  });

  it("repairs a closed-gate treasury delta with exact bigint ledger values and two-person audit evidence", async () => {
    db.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (
        text.includes("FROM house_funding_evidence") ||
        text.includes("FROM onchain_transfer_claims") ||
        text.includes("FROM onchain_deposits") ||
        text.includes("FROM user_wallets")
      ) {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: `${params?.[0]}-account` }] };
      if (
        text.includes("FROM ledger_accounts WHERE id = ANY") ||
        text.includes("INSERT INTO house_funding_evidence") ||
        text.includes("INSERT INTO onchain_transfer_claims")
      ) return { rows: [] };
      if (text.includes("INSERT INTO ledger_entries") || text.includes("INSERT INTO audit_log")) return { rows: [] };
      if (text.includes("sum(amount_micro_units)")) return { rows: [{ balance: "9007199254740993" }] };
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await recordVerifiedHouseFunding(funding);

    expect(gate.lock).toHaveBeenCalledWith(expect.objectContaining({ query: db.query }));
    const ledger = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO ledger_entries"));
    expect(ledger?.[1]?.slice(2)).toEqual([
      "-9007199254740993",
      "house_usdc_operating-account",
      "9007199254740993"
    ]);
    const audit = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO audit_log"));
    expect(audit?.[1]?.[1]).toMatchObject({ operatorId: "operator-a", approverId: "operator-b", reason: funding.reason });
    expect(result).toMatchObject({ amountMicroUnits: "9007199254740993", idempotentReplay: false });
  });

  it("returns the original ledger transaction for a repeat without inserting a second credit", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM house_funding_evidence")) {
        return {
          rows: [{
            id: "evidence-existing",
            ledger_transaction_id: "ledger-existing",
            amount_micro_units: "9007199254740993",
            block_number: "100",
            block_hash: funding.blockHash,
            from_address: funding.fromAddress,
            to_address: funding.toAddress,
            token_address: funding.tokenAddress
          }]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(recordVerifiedHouseFunding(funding)).resolves.toEqual({
      evidenceId: "evidence-existing",
      ledgerTransactionId: "ledger-existing",
      amountMicroUnits: "9007199254740993",
      idempotentReplay: true
    });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ledger_entries"))).toBe(false);
  });

  it("rejects a replay whose supplied evidence conflicts with the immutable record", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM house_funding_evidence")) {
        return {
          rows: [{
            id: "evidence-existing",
            ledger_transaction_id: "ledger-existing",
            amount_micro_units: "1",
            block_number: "100",
            block_hash: funding.blockHash,
            from_address: funding.fromAddress,
            to_address: funding.toAddress,
            token_address: funding.tokenAddress
          }]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(recordVerifiedHouseFunding(funding)).rejects.toThrow("house_funding_evidence_conflict");
  });

  it("treats operator identity casing as the same approver", async () => {
    await expect(recordVerifiedHouseFunding({ ...funding, approverId: "Operator-A" })).rejects.toThrow(
      "house_funding_distinct_approver_required"
    );
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects an active user wallet as the external funding source", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (
        text.includes("FROM house_funding_evidence") ||
        text.includes("FROM onchain_transfer_claims") ||
        text.includes("FROM onchain_deposits")
      ) return { rows: [] };
      if (text.includes("FROM user_wallets")) return { rows: [{ id: "wallet-linked" }] };
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(recordVerifiedHouseFunding(funding)).rejects.toThrow("house_funding_source_linked_to_user_wallet");
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ledger_entries"))).toBe(false);
  });

  it("rejects a fact already represented by the deposit scanner", async () => {
    db.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM house_funding_evidence") || text.includes("FROM onchain_transfer_claims")) return { rows: [] };
      if (text.includes("FROM onchain_deposits")) {
        return { rows: [{ id: "deposit-existing", status: "credited", credited_transaction_id: "ledger-existing" }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(recordVerifiedHouseFunding(funding)).rejects.toThrow("house_funding_onchain_deposit_conflict");
  });

  it("allows an uncredited ignored scanner observation to be claimed as house funding", async () => {
    db.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM house_funding_evidence") || text.includes("FROM onchain_transfer_claims") || text.includes("FROM user_wallets")) {
        return { rows: [] };
      }
      if (text.includes("FROM onchain_deposits")) {
        return { rows: [{ id: "deposit-observed", status: "ignored", credited_transaction_id: null }] };
      }
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: `${params?.[0]}-account` }] };
      if (
        text.includes("FROM ledger_accounts WHERE id = ANY") ||
        text.includes("INSERT INTO house_funding_evidence") ||
        text.includes("INSERT INTO onchain_transfer_claims") ||
        text.includes("INSERT INTO ledger_entries") ||
        text.includes("INSERT INTO audit_log")
      ) return { rows: [] };
      if (text.includes("sum(amount_micro_units)")) return { rows: [{ balance: funding.amountMicroUnits.toString() }] };
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(recordVerifiedHouseFunding(funding)).resolves.toMatchObject({ idempotentReplay: false });
  });

  it("rejects a Safe self-transfer before opening a database transaction", async () => {
    await expect(recordVerifiedHouseFunding({ ...funding, fromAddress: funding.toAddress })).rejects.toThrow(
      "house_funding_self_transfer"
    );
    expect(db.connect).not.toHaveBeenCalled();
  });
});
