import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("financial controls migration invariants", () => {
  async function migrationSql() {
    return readFile(path.join(process.cwd(), "server/db/migrations/0026_financial_controls.sql"), "utf8");
  }

  it("defines durable incidents, global gates, append-only ledgers/audit logs, and immutable withdrawals", async () => {
    const sql = await migrationSql();

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS financial_incidents");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS financial_control_gates");
    expect(sql).toContain("ledger_entries_append_only_trigger");
    expect(sql).toContain("audit_log_append_only_trigger");
    expect(sql).toContain("prevent_withdrawal_request_immutable_mutation");
    expect(sql).toContain("withdrawal_requests_state_contract_check");
    expect(sql).toContain("request_hash ~ '^sha256:[a-f0-9]{64}$'");
    expect(sql).toContain("request_hash_version = 'canonical-json-v1'");
    expect(sql).toContain("request_hash_version = 'legacy-unknown-v0'");
    expect(sql).toContain("'{\"amountMicroUnits\":'");
    expect(sql).toContain("',\"chainId\":'");
    expect(sql).toContain("',\"currency\":\"USDC\"'");
    expect(sql).toContain("',\"destinationAddress\":'");
    expect(sql).toContain("',\"userId\":'");
  });

  it("adds reorg compensation, monotonic scanner cursor history, and trusted reconciliation provenance checks", async () => {
    const sql = await migrationSql();

    expect(sql).toContain("reorg_compensation_transaction_id");
    expect(sql).toContain("onchain_scan_block_observations");
    expect(sql).toContain("enforce_onchain_scan_cursor_monotonic");
    expect(sql).toContain("onchain_deposits_state_contract_check");
    expect(sql).toContain("financial_reconciliation_snapshot_provenance_check");
    expect(sql).toContain("observed_block_hash ~ '^0x[a-f0-9]{64}$'");
    expect(sql).toContain("source = 'worker'");
    expect(sql).toContain("treasury_assets->0->>'source' = 'onchain'");
    expect(sql).toContain("scope_treasury_address");
    expect(sql).toContain("scope_token_address");
  });

  it("validates clean databases and quarantines malformed legacy rows for operator remediation", async () => {
    const sql = await migrationSql();

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS financial_constraint_quarantine");
    expect(sql).toContain("legacy_deposit_state_contract_violation");
    expect(sql).toContain("legacy_withdrawal_state_contract_violation");
    expect(sql).toContain("legacy_reconciliation_snapshot_untrusted");
    expect(sql).toContain("ALTER TABLE withdrawal_requests VALIDATE CONSTRAINT withdrawal_requests_hash_contract_check");
    expect(sql).toContain("ALTER TABLE financial_reconciliation_snapshots VALIDATE CONSTRAINT financial_reconciliation_snapshot_provenance_check");
    expect(sql).toContain("financial_constraint_quarantine");
  });
});
