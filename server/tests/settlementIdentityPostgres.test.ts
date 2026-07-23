import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { describe, expect, it, type TestContext } from "vitest";

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

  const schema = `settlement_${randomUUID().replaceAll("-", "")}`;
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

postgresDescribe("0028 settlement identity PostgreSQL integration", () => {
  it("quarantines incomplete frozen legacy identities before validating the constraint", async (context) => {
    await withDisposableSchema(context, async (client, schema) => {
      await applyMigrations(client, "0027_settlement_hardening.sql");

      const ids = {
        user: randomUUID(),
        policy: randomUUID(),
        market: randomUUID(),
        outcome: randomUUID(),
        snapshot: randomUUID(),
        quote: randomUUID(),
        quoteLeg: randomUUID(),
        ticket: randomUUID(),
        ticketLeg: randomUUID()
      };
      await client.query("INSERT INTO users (id, email) VALUES ($1, 'settlement-migration@example.com')", [ids.user]);
      await client.query(
        "INSERT INTO policy_versions (id, version, description, policy) VALUES ($1, 'settlement-migration', 'test', '{}'::jsonb)",
        [ids.policy]
      );
      await client.query(
        "INSERT INTO markets (id, source, source_market_id, question, market_url, category) VALUES ($1, 'polymarket', 'legacy-market', 'Legacy?', 'https://example.test/legacy', 'test')",
        [ids.market]
      );
      await client.query(
        "INSERT INTO market_outcomes (id, market_id, outcome, token_id) VALUES ($1, $2, 'Yes', '12345')",
        [ids.outcome, ids.market]
      );
      await client.query(
        "INSERT INTO market_snapshots (id, market_id, source_response_hash, raw) VALUES ($1, $2, 'snapshot-hash', '{}'::jsonb)",
        [ids.snapshot, ids.market]
      );
      await client.query(
        `
          INSERT INTO quotes (
            id, user_id, policy_version_id, status, stake_micro_usd,
            operation_fee_micro_usd, spread_bps, implied_probability_bps,
            offered_payout_micro_usd, expires_at
          )
          VALUES ($1, $2, $3, 'accepted', 1000000, 10000, 0, 5000, 2000000, now() + interval '1 hour')
        `,
        [ids.quote, ids.user, ids.policy]
      );
      await client.query(
        `
          INSERT INTO quote_legs (id, quote_id, market_id, outcome_id, market_snapshot_id, outcome, quoted_price_bps)
          VALUES ($1, $2, $3, $4, $5, 'Yes', 5000)
        `,
        [ids.quoteLeg, ids.quote, ids.market, ids.outcome, ids.snapshot]
      );
      await client.query(
        "INSERT INTO tickets (id, user_id, quote_id, status) VALUES ($1, $2, $3, 'accepted')",
        [ids.ticket, ids.user, ids.quote]
      );
      await client.query(
        `
          INSERT INTO ticket_legs (
            id, ticket_id, quote_leg_id, status, settlement_source,
            settlement_chain_id, settlement_identity_raw, settlement_frozen_at
          )
          VALUES ($1, $2, $3, 'pending', 'legacy_manual', 1, '{"legacy":true}'::jsonb, now())
        `,
        [ids.ticketLeg, ids.ticket, ids.quoteLeg]
      );

      await client.query(await readFile(path.join(migrationsDirectory, "0028_settlement_identity_immutability.sql"), "utf8"));

      const quarantine = await client.query<{
        reason: string;
        retryable: boolean;
        snapshot_source: string;
      }>(
        `
          SELECT
            reason,
            retryable,
            identity_snapshot->>'settlement_source' AS snapshot_source
          FROM settlement_identity_quarantines
          WHERE ticket_leg_id = $1
        `,
        [ids.ticketLeg]
      );
      const leg = await client.query<{
        settlement_source: string | null;
        settlement_frozen_at: Date | null;
        resolution_state: string;
      }>(
        "SELECT settlement_source, settlement_frozen_at, resolution_state FROM ticket_legs WHERE id = $1",
        [ids.ticketLeg]
      );
      const constraint = await client.query<{ convalidated: boolean }>(
        `
          SELECT constraints.convalidated
          FROM pg_constraint constraints
          JOIN pg_class tables ON tables.oid = constraints.conrelid
          JOIN pg_namespace namespaces ON namespaces.oid = tables.relnamespace
          WHERE namespaces.nspname = $1
            AND constraints.conname = 'ticket_legs_frozen_settlement_identity_check'
        `,
        [schema]
      );

      expect(quarantine.rows[0]).toEqual({
        reason: "legacy_frozen_settlement_identity_incomplete",
        retryable: true,
        snapshot_source: "legacy_manual"
      });
      expect(leg.rows[0]).toMatchObject({
        settlement_source: null,
        settlement_frozen_at: null,
        resolution_state: "settlement_blocked"
      });
      expect(constraint.rows[0]?.convalidated).toBe(true);

      const proofFields = [
        ids.ticketLeg,
        "polymarket_ctf",
        137,
        "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
        "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        `0x${"1".repeat(64)}`,
        "12345",
        0,
        1000,
        `0x${"3".repeat(64)}`
      ];
      const proofInsertFields = [proofFields[0], ...proofFields.slice(2)];
      const fabricatedProof = await client.query<{ id: string }>(
        `
          INSERT INTO settlement_proofs (
            ticket_leg_id, source, proof_kind, result, confidence, chain_id,
            contract_address, collateral_address, condition_id, token_id,
            outcome_index, block_number, block_hash, provider_evidence
          )
          VALUES ($1, 'fabricated', 'ctf_position_id_validation', 'pending', 'onchain_confirmed', $2, $3, $4, $5, $6, $7, $8, $9, '[{}]'::jsonb)
          RETURNING id
        `,
        proofInsertFields
      );
      const freezeSql = `
        UPDATE ticket_legs
        SET
          settlement_source = $2,
          settlement_chain_id = $3,
          settlement_contract_address = $4,
          settlement_collateral_address = $5,
          settlement_condition_id = $6,
          settlement_token_id = $7,
          settlement_position_id = $7,
          settlement_collection_id = $11,
          settlement_outcome_index = $8,
          settlement_payout_slot_count = 2,
          settlement_question = 'Legacy?',
          settlement_outcome = 'Yes',
          settlement_source_market_id = 'legacy-market',
          settlement_source_snapshot_id = $12,
          settlement_rules_snapshot_hash = 'snapshot-hash',
          settlement_identity_raw = '{"validated":true}'::jsonb,
          settlement_identity_validation_proof_id = $13,
          settlement_identity_validation_block_number = $9,
          settlement_identity_validation_block_hash = $10,
          settlement_frozen_at = now()
        WHERE id = $1
      `;
      const freezeFields = [
        ...proofFields,
        `0x${"2".repeat(64)}`,
        ids.snapshot,
        fabricatedProof.rows[0].id
      ];

      await expect(client.query(freezeSql, freezeFields)).rejects.toThrow("frozen_ticket_leg_validation_provenance_invalid");

      const validProof = await client.query<{ id: string }>(
        `
          INSERT INTO settlement_proofs (
            ticket_leg_id, source, proof_kind, result, confidence, chain_id,
            contract_address, collateral_address, condition_id, token_id,
            outcome_index, block_number, block_hash, provider_evidence
          )
          VALUES ($1, 'legwork_settlement_identity', 'ctf_position_id_validation', 'pending', 'onchain_confirmed', $2, $3, $4, $5, $6, $7, $8, $9, '[{}]'::jsonb)
          RETURNING id
        `,
        proofInsertFields
      );
      freezeFields[12] = validProof.rows[0].id;
      await expect(client.query(freezeSql, freezeFields)).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        client.query("UPDATE ticket_legs SET settlement_token_id = '67890' WHERE id = $1", [ids.ticketLeg])
      ).rejects.toThrow("frozen_ticket_leg_settlement_identity_immutable");
    });
  });
});
