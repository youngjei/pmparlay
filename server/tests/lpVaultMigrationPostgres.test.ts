import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { FOUNDER_SEPOLIA_SHADOW_VAULT_ID } from "../db/lpVaultRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");

async function applyMigrations(client: pg.Client, through = "0047_ticket_economic_terms_hardening.sql") {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql") && name <= through)
    .sort();
  for (const migration of migrations) {
    await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
  }
}

async function applyMigration(client: pg.Client, migration: string) {
  await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
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

  const schema = `lp_vault_${randomUUID().replaceAll("-", "")}`;
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

postgresDescribe("LP vault shadow PostgreSQL integration", () => {
  it("enforces singleton metadata and at most one open epoch with append-only history", async (context) => {
    await withDisposableSchema(context, async (client) => {
      await applyMigrations(client);
      const treasuryAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      const tokenAddress = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
      await client.query(
        `
          INSERT INTO lp_vaults (
            id, vault_key, display_name, mode, chain_id, currency, treasury_address, token_address,
            capital_source, custody_model
          )
          VALUES ($1, 'founder-sepolia-shadow', 'LEGWORK Founder Shadow Vault', 'shadow', 11155111,
            'USDC', $2, $3, 'founder', 'logical_operating_treasury')
        `,
        [FOUNDER_SEPOLIA_SHADOW_VAULT_ID, treasuryAddress, tokenAddress]
      );

      await expect(
        client.query(
          `
            INSERT INTO lp_vaults (
              id, vault_key, display_name, mode, chain_id, currency, treasury_address, token_address,
              capital_source, custody_model
            )
            VALUES ($1, 'founder-sepolia-shadow', 'Duplicate', 'shadow', 11155111, 'USDC', $2, $3,
              'founder', 'logical_operating_treasury')
          `,
          [randomUUID(), treasuryAddress, tokenAddress]
        )
      ).rejects.toMatchObject({ code: "23505" });

      const first = await client.query<{ id: string }>(
        "INSERT INTO lp_vault_epochs (vault_id, epoch_number, status, starts_at) VALUES ($1, 1, 'planned', $2) RETURNING id",
        [FOUNDER_SEPOLIA_SHADOW_VAULT_ID, "2026-09-03T00:00:00.000Z"]
      );
      await expect(
        client.query(
          "INSERT INTO lp_vault_epochs (vault_id, epoch_number, status, starts_at) VALUES ($1, 2, 'active', $2)",
          [FOUNDER_SEPOLIA_SHADOW_VAULT_ID, "2026-10-01T00:00:00.000Z"]
        )
      ).rejects.toMatchObject({ code: "23505" });

      await client.query("UPDATE lp_vault_epochs SET status = 'active' WHERE id = $1", [first.rows[0].id]);
      await client.query("UPDATE lp_vault_epochs SET status = 'runoff' WHERE id = $1", [first.rows[0].id]);
      await client.query(
        "UPDATE lp_vault_epochs SET status = 'finalized', finalized_at = $2 WHERE id = $1",
        [first.rows[0].id, "2026-09-30T00:00:00.000Z"]
      );
      await expect(
        client.query(
          "INSERT INTO lp_vault_epochs (vault_id, epoch_number, status, starts_at) VALUES ($1, 2, 'planned', $2)",
          [FOUNDER_SEPOLIA_SHADOW_VAULT_ID, "2026-10-01T00:00:00.000Z"]
        )
      ).resolves.toMatchObject({ rowCount: 1 });

      const history = await client.query<{ id: string; from_status: string | null; to_status: string }>(
        "SELECT id, from_status, to_status FROM lp_vault_epoch_history WHERE epoch_id = $1 ORDER BY recorded_at, from_status NULLS FIRST",
        [first.rows[0].id]
      );
      expect(history.rows.map(({ from_status, to_status }) => [from_status, to_status])).toEqual([
        [null, "planned"],
        ["planned", "active"],
        ["active", "runoff"],
        ["runoff", "finalized"]
      ]);
      await expect(client.query("DELETE FROM lp_vault_epoch_history WHERE id = $1", [history.rows[0].id])).rejects.toThrow(
        "lp_vault_epoch_history_is_append_only"
      );
    });
  });

  it("rejects a quote whose payout is lower than its stake", async (context) => {
    await withDisposableSchema(context, async (client) => {
      await applyMigrations(client);
      const policy = await client.query<{ id: string }>(
        "INSERT INTO policy_versions (version, description, policy) VALUES ('lp-constraint-test', 'test', '{}') RETURNING id"
      );

      await expect(client.query(
        `
          INSERT INTO quotes (
            policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
            spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
          )
          VALUES ($1, 'quoted', 2, 0, 0, 5000, 1, now() + interval '1 minute')
        `,
        [policy.rows[0].id]
      )).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("retains rejected quote evidence whose calculated payout was below stake", async (context) => {
    await withDisposableSchema(context, async (client) => {
      await applyMigrations(client);
      const policy = await client.query<{ id: string }>(
        "INSERT INTO policy_versions (version, description, policy) VALUES ('lp-rejected-constraint-test', 'test', '{}') RETURNING id"
      );

      await expect(client.query(
        `
          INSERT INTO quotes (
            policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
            spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
          )
          VALUES ($1, 'rejected', 2, 0, 0, 5000, 1, now() + interval '1 minute')
        `,
        [policy.rows[0].id]
      )).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("installs the payout floor without validating historical quote rows during deployment", async (context) => {
    await withDisposableSchema(context, async (client) => {
      await applyMigrations(client, "0044_lp_vault_shadow.sql");
      const policy = await client.query<{ id: string }>(
        "INSERT INTO policy_versions (version, description, policy) VALUES ('lp-legacy-constraint-test', 'test', '{}') RETURNING id"
      );
      await client.query(
        `
          INSERT INTO quotes (
            policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
            spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
          )
          VALUES ($1, 'quoted', 2, 0, 0, 5000, 1, now() + interval '1 minute')
        `,
        [policy.rows[0].id]
      );

      await applyMigration(client, "0046_ticket_settlement_summaries.sql");
      await applyMigration(client, "0047_ticket_economic_terms_hardening.sql");

      const constraint = await client.query<{ convalidated: boolean }>(
        "SELECT convalidated FROM pg_constraint WHERE conname = 'quotes_offered_payout_covers_stake_check'"
      );
      expect(constraint.rows[0].convalidated).toBe(false);
      await expect(client.query(
        `
          INSERT INTO quotes (
            policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
            spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
          )
          VALUES ($1, 'quoted', 4, 0, 0, 5000, 3, now() + interval '1 minute')
        `,
        [policy.rows[0].id]
      )).rejects.toMatchObject({ code: "23514" });
    });
  });
});
