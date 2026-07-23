import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { lockFinancialControlGateForMoney, lockFinancialControlGateForMutation } from "../financialGate";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");

async function migrationFilesThrough(lastMigration: string) {
  return (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql") && name <= lastMigration)
    .sort();
}

async function applyMigrations(client: pg.Client, lastMigration: string) {
  for (const migration of await migrationFilesThrough(lastMigration)) {
    await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
  }
}

async function withDisposableSchema(context: TestContext, run: (client: pg.Client, schema: string) => Promise<void>) {
  if (!testDatabaseUrl) {
    context.skip();
    return;
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
  }

  const client = new pg.Client({ connectionString: testDatabaseUrl });
  try {
    await client.connect();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      context.skip();
      return;
    }
    throw error;
  }

  const schema = `financial_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await run(client, schema);
  } finally {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

postgresDescribe("0026 financial controls PostgreSQL integration", () => {
  it("applies the real fresh migration chain and validates every financial constraint", async (context) => {
    await withDisposableSchema(context, async (client, schema) => {
      await applyMigrations(client, "0026_financial_controls.sql");

      const constraints = await client.query<{ conname: string; convalidated: boolean }>(
        `
          SELECT constraints.conname, constraints.convalidated
          FROM pg_constraint constraints
          JOIN pg_class tables ON tables.oid = constraints.conrelid
          JOIN pg_namespace namespaces ON namespaces.oid = tables.relnamespace
          WHERE namespaces.nspname = $1
            AND constraints.conname = ANY($2::text[])
          ORDER BY constraints.conname
        `,
        [
          schema,
          [
            "financial_reconciliation_snapshot_provenance_check",
            "onchain_deposits_state_contract_check",
            "withdrawal_requests_hash_contract_check",
            "withdrawal_requests_state_contract_check"
          ]
        ]
      );

      expect(constraints.rows).toHaveLength(4);
      expect(constraints.rows.every((constraint) => constraint.convalidated)).toBe(true);

      const accounts = await client.query<{ id: string }>(
        "INSERT INTO ledger_accounts (account_type, currency) VALUES ('migration_test_positive', 'USDC'), ('migration_test_offset', 'USDC') RETURNING id"
      );
      const ledgerEntry = await client.query<{ id: string }>(
        "INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo) VALUES ($1, $2, 1, 'USDC', 'migration test'), ($1, $3, -1, 'USDC', 'migration test') RETURNING id",
        [randomUUID(), accounts.rows[0].id, accounts.rows[1].id]
      );
      const auditEntry = await client.query<{ id: string }>(
        "INSERT INTO audit_log (action, entity_type, metadata) VALUES ('migration.test', 'migration_test', '{}'::jsonb) RETURNING id"
      );
      await expect(
        client.query("UPDATE ledger_entries SET memo = 'mutated' WHERE id = $1", [ledgerEntry.rows[0].id])
      ).rejects.toThrow("ledger_entries_is_append_only");
      await expect(client.query("DELETE FROM audit_log WHERE id = $1", [auditEntry.rows[0].id])).rejects.toThrow(
        "audit_log_is_append_only"
      );

      await client.query(
        "INSERT INTO onchain_scan_cursors (chain_id, cursor_name, last_scanned_block) VALUES (11155111, 'migration-test', 100)"
      );
      await expect(
        client.query(
          "UPDATE onchain_scan_cursors SET last_scanned_block = 99 WHERE chain_id = 11155111 AND cursor_name = 'migration-test'"
        )
      ).rejects.toThrow("onchain_scan_cursor_regression");
    });
  });

  it("serializes money commits against concurrent global gate closure", async (context) => {
    await withDisposableSchema(context, async (client, schema) => {
      await applyMigrations(client, "0026_financial_controls.sql");
      const gateSetter = new pg.Client({ connectionString: testDatabaseUrl });
      await gateSetter.connect();

      try {
        await gateSetter.query(`SET search_path TO ${schema}, public`);
        await client.query("BEGIN");
        await lockFinancialControlGateForMoney(client as unknown as pg.PoolClient);

        await gateSetter.query("BEGIN");
        await gateSetter.query("SET LOCAL lock_timeout = '100ms'");
        await expect(
          lockFinancialControlGateForMutation(gateSetter as unknown as pg.PoolClient)
        ).rejects.toMatchObject({ code: "55P03" });
        await gateSetter.query("ROLLBACK");

        await client.query("COMMIT");
        await gateSetter.query("BEGIN");
        await expect(lockFinancialControlGateForMutation(gateSetter as unknown as pg.PoolClient)).resolves.toBeUndefined();
        await gateSetter.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK");
        await gateSetter.query("ROLLBACK");
        await gateSetter.end();
      }
    });
  });

  it("quarantines malformed legacy provenance and blocks operations instead of hiding validation debt", async (context) => {
    await withDisposableSchema(context, async (client, schema) => {
      await applyMigrations(client, "0025_market_catalog_sweep_state.sql");
      await client.query(
        `
          INSERT INTO financial_reconciliation_snapshots (
            chain_id,
            currency,
            treasury_assets_micro_units,
            internal_custody_micro_units,
            user_available_micro_units,
            user_claimable_micro_units,
            user_checkout_micro_units,
            open_stake_micro_units,
            open_reserve_micro_units,
            pending_withdrawal_micro_units,
            house_equity_micro_units,
            unexplained_delta_micro_units,
            launch_gate,
            operation_gate,
            treasury_assets
          )
          VALUES (11155111, 'USDC', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'ready', 'open', '[]'::jsonb)
        `
      );
      await client.query(await readFile(path.join(migrationsDirectory, "0026_financial_controls.sql"), "utf8"));

      const quarantine = await client.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM financial_constraint_quarantine
          WHERE reason = 'legacy_reconciliation_snapshot_untrusted'
            AND remediated_at IS NULL
        `
      );
      const gate = await client.query<{ operation_gate: string; reason: string }>(
        "SELECT operation_gate, reason FROM financial_control_gates WHERE scope = 'global'"
      );
      const provenance = await client.query<{ convalidated: boolean }>(
        `
          SELECT constraints.convalidated
          FROM pg_constraint constraints
          JOIN pg_class tables ON tables.oid = constraints.conrelid
          JOIN pg_namespace namespaces ON namespaces.oid = tables.relnamespace
          WHERE namespaces.nspname = $1
            AND constraints.conname = 'financial_reconciliation_snapshot_provenance_check'
        `,
        [schema]
      );

      expect(quarantine.rows[0]?.count).toBe("1");
      expect(gate.rows[0]).toEqual({
        operation_gate: "blocked",
        reason: "financial_constraint_quarantine"
      });
      expect(provenance.rows[0]?.convalidated).toBe(false);
    });
  });
});
