import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

async function migrationSql() {
  return readFile(path.join(process.cwd(), "server/db/migrations/0022_direct_pay_requote.sql"), "utf8");
}

describe("direct-pay migration fixtures", () => {
  it("backfills paid legacy intents from canonical checkout or uniquely linked deposit evidence", async () => {
    const sql = await migrationSql();

    expect(sql).toContain("CREATE TEMP TABLE direct_pay_migration_evidence");
    expect(sql).toContain("ledger_entries.transaction_id = payment_intents.checkout_ledger_transaction_id");
    expect(sql).toContain("ledger_accounts.account_type = 'user_usdc_checkout'");
    expect(sql).toContain("deposits.tx_hash = payment_intents.tx_hash");
    expect(sql).toContain("deposits.credited_transaction_id IS NOT NULL");
    expect(sql).toContain("WHERE candidate_count = 1");
    expect(sql).toContain("COALESCE(checkout_evidence.amount_micro_units, deposit_evidence.amount_micro_units)");
    expect(sql).toContain("amount_received_micro_units = evidence.resolved_amount_micro_units");
    expect(sql).not.toMatch(/amount_received_micro_units\s+BIGINT\s+NOT NULL\s+DEFAULT\s+0/i);
  });

  it("quarantines unprovable paid states and moves retryable held funds into passive recovery", async () => {
    const sql = await migrationSql();

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS direct_pay_migration_quarantine");
    expect(sql).toContain("legacy_direct_pay_evidence_conflict");
    expect(sql).toContain("legacy_direct_pay_payment_evidence_missing");
    expect(sql).toContain("payment_intents.status IN ('confirmed', 'activating', 'activated')");
    expect(sql).toContain("payment_intents.status IN ('confirmed', 'activating')");
    expect(sql).toContain("status = 'recoverable'");
    expect(sql).toContain("WHERE payment_intents.status = 'submitted'");
  });

  it("qualifies legacy deadline columns and requires split immutable catalog and live-book evidence", async () => {
    const sql = await migrationSql();

    expect(sql).toContain("payment_intents.created_at + interval '3 minutes'");
    expect(sql).toContain("payment_intents.submitted_at + interval '15 minutes'");
    expect(sql).not.toMatch(/COALESCE\(submission_deadline_at,\s*created_at/i);
    expect(sql).toContain("evidence_type = 'catalog_snapshot'");
    expect(sql).toContain("evidence_type = 'live_orderbook'");
    expect(sql).toContain("evidence->'orderbook' ? 'fetchedAt'");
    expect(sql).toContain("evidence->'orderbook' ? 'sourceTimestamp'");
    expect(sql).toContain("quote_reprice_evidence_append_only_trigger");
  });

  const postgresIt = process.env.DIRECT_PAY_MIGRATION_TEST_DATABASE_URL ? it : it.skip;
  postgresIt(
    "backfills and quarantines legacy payment fixtures idempotently on Postgres",
    async () => {
      const client = new pg.Client({ connectionString: process.env.DIRECT_PAY_MIGRATION_TEST_DATABASE_URL });
      const schema = `direct_pay_fixture_${randomUUID().replaceAll("-", "")}`;
      await client.connect();

      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);

        const migrationsDir = path.join(process.cwd(), "server/db/migrations");
        const prerequisiteMigrations = (await readdir(migrationsDir))
          .filter((name) => /^00(?:0[1-9]|1\d|20|21)_.*\.sql$/.test(name))
          .sort();
        for (const migration of prerequisiteMigrations) {
          await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
        }

        await client.query(`
          INSERT INTO users (id, email)
          VALUES ('00000000-0000-0000-0000-000000000001', 'direct-pay-fixture@example.com');

          INSERT INTO policy_versions (id, version, description, policy, active)
          VALUES ('00000000-0000-0000-0000-000000000010', 'fixture-v1', 'fixture', '{}'::jsonb, true);

          INSERT INTO quotes (
            id, user_id, policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
            spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
          )
          VALUES
            ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'quoted', 25000000, 2000000, 100, 2500, 90000000, now() + interval '1 hour'),
            ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'quoted', 25000000, 2000000, 100, 2500, 90000000, now() + interval '1 hour'),
            ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'quoted', 25000000, 2000000, 100, 2500, 90000000, now() + interval '1 hour'),
            ('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'quoted', 25000000, 2000000, 100, 2500, 90000000, now() + interval '1 hour'),
            ('00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'quoted', 25000000, 2000000, 100, 2500, 90000000, now() + interval '1 hour');

          INSERT INTO onchain_deposits (
            id, chain_id, tx_hash, log_index, block_number, from_address, to_address,
            token_address, amount_micro_units, user_id, status, confirmations,
            credited_transaction_id
          )
          VALUES
            ('00000000-0000-0000-0000-000000000301', 11155111, '0xoverpaid', 0, 100, '0xsender', '0xtreasury', '0xusdc', 30000000, '00000000-0000-0000-0000-000000000001', 'credited', 12, '00000000-0000-0000-0000-000000000401'),
            ('00000000-0000-0000-0000-000000000303', 11155111, '0xunderpaid', 0, 101, '0xsender', '0xtreasury', '0xusdc', 20000000, '00000000-0000-0000-0000-000000000001', 'credited', 12, '00000000-0000-0000-0000-000000000403'),
            ('00000000-0000-0000-0000-000000000304', 11155111, '0xactivated', 0, 102, '0xsender', '0xtreasury', '0xusdc', 27000000, '00000000-0000-0000-0000-000000000001', 'credited', 12, '00000000-0000-0000-0000-000000000404'),
            ('00000000-0000-0000-0000-000000000305', 11155111, '0xconflict', 0, 103, '0xsender', '0xtreasury', '0xusdc', 30000000, '00000000-0000-0000-0000-000000000001', 'credited', 12, '00000000-0000-0000-0000-000000000405');

          INSERT INTO quote_payment_intents (
            id, quote_id, user_id, chain_id, treasury_address, usdc_contract_address,
            amount_micro_units, required_confirmations, status, tx_hash, onchain_deposit_id,
            expires_at, submitted_at, confirmed_at, activated_at
          )
          VALUES
            ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 11155111, '0xtreasury', '0xusdc', 27000000, 12, 'confirmed', '0xoverpaid', '00000000-0000-0000-0000-000000000301', now() + interval '15 minutes', now(), now(), NULL),
            ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', 11155111, '0xtreasury', '0xusdc', 27000000, 12, 'confirmed', '0xmissing', NULL, now() + interval '15 minutes', now(), now(), NULL),
            ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001', 11155111, '0xtreasury', '0xusdc', 27000000, 12, 'submitted', '0xunderpaid', '00000000-0000-0000-0000-000000000303', now() + interval '15 minutes', now(), NULL, NULL),
            ('00000000-0000-0000-0000-000000000204', '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000001', 11155111, '0xtreasury', '0xusdc', 27000000, 12, 'activated', '0xactivated', '00000000-0000-0000-0000-000000000304', now() + interval '15 minutes', now(), now(), now()),
            ('00000000-0000-0000-0000-000000000205', '00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-000000000001', 11155111, '0xtreasury', '0xusdc', 27000000, 12, 'submitted', '0xconflict', '00000000-0000-0000-0000-000000000305', now() + interval '15 minutes', now(), NULL, NULL);
        `);

        const directPayMigration = await migrationSql();
        await client.query(directPayMigration);
        await client.query(`
          INSERT INTO ledger_accounts (id, user_id, account_type, currency)
          VALUES
            ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000001', 'user_usdc_checkout', 'USDC'),
            ('00000000-0000-0000-0000-000000000502', NULL, 'external_usdc_deposits', 'USDC');

          INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
          VALUES
            ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000501', 29000000, 'USDC', 'conflicting checkout fixture'),
            ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000502', -29000000, 'USDC', 'conflicting checkout fixture');

          UPDATE quote_payment_intents
          SET status = 'submitted',
              checkout_ledger_transaction_id = '00000000-0000-0000-0000-000000000601'
          WHERE id = '00000000-0000-0000-0000-000000000205';
        `);
        await client.query(directPayMigration);

        const migrated = await client.query<{
          id: string;
          status: string;
          amount_received_micro_units: string | null;
          surplus_micro_units: string | null;
          recovery_reason: string | null;
        }>(`
          SELECT id, status, amount_received_micro_units::text, surplus_micro_units::text, recovery_reason
          FROM quote_payment_intents
          ORDER BY id
        `);
        expect(migrated.rows).toEqual([
          {
            id: "00000000-0000-0000-0000-000000000201",
            status: "confirmed",
            amount_received_micro_units: "30000000",
            surplus_micro_units: "3000000",
            recovery_reason: null
          },
          {
            id: "00000000-0000-0000-0000-000000000202",
            status: "recoverable",
            amount_received_micro_units: null,
            surplus_micro_units: null,
            recovery_reason: "activation_failed"
          },
          {
            id: "00000000-0000-0000-0000-000000000203",
            status: "recoverable",
            amount_received_micro_units: "20000000",
            surplus_micro_units: "0",
            recovery_reason: "underpayment"
          },
          {
            id: "00000000-0000-0000-0000-000000000204",
            status: "activated",
            amount_received_micro_units: "27000000",
            surplus_micro_units: "0",
            recovery_reason: null
          },
          {
            id: "00000000-0000-0000-0000-000000000205",
            status: "recoverable",
            amount_received_micro_units: "30000000",
            surplus_micro_units: "3000000",
            recovery_reason: "activation_failed"
          }
        ]);

        const quarantine = await client.query<{ payment_intent_id: string; original_status: string; reason: string }>(`
          SELECT payment_intent_id, original_status, reason
          FROM direct_pay_migration_quarantine
          ORDER BY payment_intent_id
        `);
        expect(quarantine.rows).toEqual([
          {
            payment_intent_id: "00000000-0000-0000-0000-000000000202",
            original_status: "confirmed",
            reason: "legacy_direct_pay_payment_evidence_missing"
          },
          {
            payment_intent_id: "00000000-0000-0000-0000-000000000205",
            original_status: "submitted",
            reason: "legacy_direct_pay_evidence_conflict"
          }
        ]);
      } finally {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await client.end();
      }
    },
    30_000
  );
});
