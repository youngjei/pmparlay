import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { config } from "../config";
import { closePool } from "../db/client";
import {
  getLatestPolymarketApiSettlementCandidate,
  recordLegSettlement,
  recordSettlementObservation,
  recordSettlementProof
} from "../db/settlementRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const conditionId = `0x${"ab".repeat(32)}`;
const tokenId = "api-yes-token";
const otherTokenId = "api-no-token";
const identityFingerprint = "f".repeat(64);
const settlementDueAt = "2026-07-21T08:00:00.000Z";

async function applyMigrations(client: pg.Client) {
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
  }
}

function databaseUrlForSchema(schema: string) {
  const url = new URL(testDatabaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function withDisposableSchema(context: TestContext, run: (client: pg.Client) => Promise<void>) {
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
    await client.end().catch(() => undefined);
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      context.skip();
      return;
    }
    throw error;
  }

  const originalDatabaseUrl = config.DATABASE_URL;
  const schema = `polymarket_api_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await applyMigrations(client);

    await closePool();
    config.DATABASE_URL = databaseUrlForSchema(schema);
    await run(client);
  } finally {
    await closePool();
    config.DATABASE_URL = originalDatabaseUrl;
    try {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
}

async function seedHouseBookLeg(client: pg.Client) {
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
  const sourceMarketId = `api-settlement-${ids.market}`;

  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [ids.user, `${ids.user}@example.test`]);
  await client.query(
    "INSERT INTO policy_versions (id, version, description, policy) VALUES ($1, $2, 'api settlement', '{}'::jsonb)",
    [ids.policy, `api-settlement-${ids.policy}`]
  );
  await client.query(
    `
      INSERT INTO markets (id, source, source_market_id, condition_id, question, market_url, category, end_date, neg_risk)
      VALUES ($1, 'polymarket', $2, $3, 'Will the API result be Yes?', 'https://example.test/api-settlement', 'Other', $4, false)
    `,
    [ids.market, sourceMarketId, conditionId, settlementDueAt]
  );
  await client.query(
    "INSERT INTO market_outcomes (id, market_id, outcome, token_id) VALUES ($1, $2, 'Yes', $3)",
    [ids.outcome, ids.market, tokenId]
  );
  await client.query(
    `
      INSERT INTO market_snapshots (id, market_id, source_response_hash, raw)
      VALUES ($1, $2, $3, $4)
    `,
    [
      ids.snapshot,
      ids.market,
      `api-snapshot-${ids.snapshot}`,
      {
        marketId: sourceMarketId,
        outcomes: [{ outcome: "Yes", conditionId, tokenId, endDate: settlementDueAt }]
      }
    ]
  );
  await client.query(
    `
      INSERT INTO quotes (
        id, user_id, policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
        spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
      )
      VALUES ($1, $2, $3, 'accepted', 1000000, 0, 0, 5000, 2000000, now() + interval '1 hour')
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
    `
      INSERT INTO tickets (id, user_id, quote_id, status, accounting_mode, funding_currency)
      VALUES ($1, $2, $3, 'live', 'house_book_usdc', 'USDC')
    `,
    [ids.ticket, ids.user, ids.quote]
  );
  await client.query(
    `
      INSERT INTO ticket_legs (id, ticket_id, quote_leg_id, status, settlement_due_at)
      VALUES ($1, $2, $3, 'pending', $4)
    `,
    [ids.ticketLeg, ids.ticket, ids.quoteLeg, settlementDueAt]
  );

  return { ...ids, sourceMarketId };
}

async function insertApiIdentityProof(client: pg.Client, ticketLegId: string, providerEvidence: unknown) {
  return recordSettlementProof(client as unknown as pg.PoolClient, {
    ticketLegId,
    source: "legwork_settlement_identity",
    proofKind: "polymarket_api_identity_validation",
    result: "pending",
    confidence: "api_signal",
    chainId: 137,
    contractAddress: config.POLYMARKET_CTF_ADDRESS,
    collateralAddress: config.POLYMARKET_COLLATERAL_ADDRESS,
    conditionId,
    tokenId,
    outcomeIndex: 0,
    providerEvidence,
    raw: { authority: "polymarket_api", identityFingerprint }
  });
}

async function freezeApiIdentity(
  client: pg.Client,
  ids: Awaited<ReturnType<typeof seedHouseBookLeg>>,
  validationProofId: string
) {
  return client.query(
    `
      UPDATE ticket_legs
      SET
        settlement_source = 'polymarket_ctf',
        settlement_authority = 'polymarket_api',
        settlement_chain_id = 137,
        settlement_contract_address = $2,
        settlement_collateral_address = $3,
        settlement_condition_id = $4,
        settlement_token_id = $5,
        settlement_position_id = $5,
        settlement_collection_id = NULL,
        settlement_outcome_index = 0,
        settlement_payout_slot_count = 2,
        settlement_question = 'Will the API result be Yes?',
        settlement_outcome = 'Yes',
        settlement_source_market_id = $6,
        settlement_source_snapshot_id = $7,
        settlement_rules_snapshot_hash = $8,
        settlement_neg_risk = false,
        settlement_identity_raw = $9,
        settlement_identity_validation_proof_id = $10,
        settlement_identity_validation_block_number = NULL,
        settlement_identity_validation_block_hash = NULL,
        settlement_frozen_at = now()
      WHERE id = $1
    `,
    [
      ids.ticketLeg,
      config.POLYMARKET_CTF_ADDRESS,
      config.POLYMARKET_COLLATERAL_ADDRESS,
      conditionId,
      tokenId,
      ids.sourceMarketId,
      ids.snapshot,
      `api-snapshot-${ids.snapshot}`,
      { authority: "polymarket_api", identityFingerprint, positionId: tokenId },
      validationProofId
    ]
  );
}

function terminalProviderEvidence(sourceMarketId: string) {
  return [
    {
      provider: "gamma",
      status: "ok",
      sourceMarketId,
      conditionId,
      closed: true,
      umaResolutionStatus: "resolved",
      outcomes: ["Yes", "No"],
      outcomePrices: ["1", "0"],
      tokenIds: [tokenId, otherTokenId]
    },
    {
      provider: "clob",
      status: "ok",
      conditionId,
      closed: true,
      acceptingOrders: false,
      is50_50Outcome: false,
      tokens: [
        { tokenId, outcome: "Yes", price: 1, winner: true },
        { tokenId: otherTokenId, outcome: "No", price: 0, winner: false }
      ]
    }
  ];
}

postgresDescribe("0043 Polymarket API settlement authority PostgreSQL integration", () => {
  it("requires Gamma and CLOB provenance, accepts nullable chain-derived fields, and freezes the API identity", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const ids = await seedHouseBookLeg(client);

      const missingGammaProof = await insertApiIdentityProof(client, ids.ticketLeg, [
        { provider: "clob", status: "ok" },
        { provider: "clob", status: "ok" }
      ]);
      await expect(freezeApiIdentity(client, ids, missingGammaProof)).rejects.toThrow(
        "frozen_ticket_leg_validation_provenance_invalid"
      );

      const invalidClobProof = await insertApiIdentityProof(client, ids.ticketLeg, [
        { provider: "gamma", status: "ok" },
        { provider: "clob", status: "error" }
      ]);
      await expect(freezeApiIdentity(client, ids, invalidClobProof)).rejects.toThrow(
        "frozen_ticket_leg_validation_provenance_invalid"
      );

      const validProof = await insertApiIdentityProof(client, ids.ticketLeg, [
        { provider: "gamma", status: "ok" },
        { provider: "clob", status: "ok" }
      ]);
      await expect(freezeApiIdentity(client, ids, validProof)).resolves.toMatchObject({ rowCount: 1 });

      const frozen = await client.query<{
        settlementAuthority: string;
        settlementCollectionId: string | null;
        validationBlockNumber: string | null;
        validationBlockHash: string | null;
        validationProofId: string;
      }>(
        `
          SELECT
            settlement_authority AS "settlementAuthority",
            settlement_collection_id AS "settlementCollectionId",
            settlement_identity_validation_block_number::text AS "validationBlockNumber",
            settlement_identity_validation_block_hash AS "validationBlockHash",
            settlement_identity_validation_proof_id::text AS "validationProofId"
          FROM ticket_legs
          WHERE id = $1
        `,
        [ids.ticketLeg]
      );
      expect(frozen.rows[0]).toEqual({
        settlementAuthority: "polymarket_api",
        settlementCollectionId: null,
        validationBlockNumber: null,
        validationBlockHash: null,
        validationProofId: validProof
      });

      await expect(
        client.query("UPDATE ticket_legs SET settlement_authority = 'polygon_ctf' WHERE id = $1", [ids.ticketLeg])
      ).rejects.toThrow("frozen_ticket_leg_settlement_identity_immutable");
    });
  });

  it("persists API candidates but measures finality stability from database time", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const ids = await seedHouseBookLeg(client);
      const validationProof = await insertApiIdentityProof(client, ids.ticketLeg, [
        { provider: "gamma", status: "ok" },
        { provider: "clob", status: "ok" }
      ]);
      await freezeApiIdentity(client, ids, validationProof);

      const firstObservedAt = "2000-01-01T00:00:00.000Z";
      const fingerprint = "c".repeat(64);
      await expect(
        recordSettlementObservation({
          ticketLegId: ids.ticketLeg,
          resolutionState: "resolution_candidate",
          source: "polymarket_api",
          proofKind: "polymarket_api_resolution_candidate",
          result: "won",
          confidence: "api_signal",
          chainId: 137,
          contractAddress: config.POLYMARKET_CTF_ADDRESS,
          collateralAddress: config.POLYMARKET_COLLATERAL_ADDRESS,
          conditionId,
          tokenId,
          outcomeIndex: 0,
          winningTokenId: tokenId,
          payoutNumerator: "1",
          payoutDenominator: "1",
          payoutVector: ["1", "0"],
          providerEvidence: terminalProviderEvidence(ids.sourceMarketId),
          raw: { fingerprint, firstObservedAt }
        })
      ).resolves.toBe(true);

      const candidate = await getLatestPolymarketApiSettlementCandidate(ids.ticketLeg);
      expect(candidate).toMatchObject({ fingerprint, firstObservedAt, result: "won" });
      const persistedCandidate = await client.query<{ createdAt: Date }>(
        'SELECT created_at AS "createdAt" FROM settlement_proofs WHERE id = $1',
        [candidate!.proofId]
      );
      expect(candidate!.observedAt).toBe(persistedCandidate.rows[0].createdAt.toISOString());

      await expect(
        recordLegSettlement({
          ticketLegId: ids.ticketLeg,
          result: "won",
          source: "polymarket_api",
          proofReference: "polymarket_api_outcome",
          proof: {
            source: "polymarket_api",
            proofKind: "polymarket_api_outcome",
            result: "won",
            confidence: "api_signal",
            chainId: 137,
            contractAddress: config.POLYMARKET_CTF_ADDRESS,
            collateralAddress: config.POLYMARKET_COLLATERAL_ADDRESS,
            conditionId,
            tokenId,
            outcomeIndex: 0,
            winningTokenId: tokenId,
            payoutNumerator: "1",
            payoutDenominator: "1",
            payoutVector: ["1", "0"],
            resolvedAt: settlementDueAt,
            providerEvidence: terminalProviderEvidence(ids.sourceMarketId),
            raw: {
              candidateProofId: candidate!.proofId,
              fingerprint,
              firstObservedAt,
              confirmedAt: "2100-01-01T00:00:00.000Z"
            }
          },
          assertFinancialGateOpenInTransaction: async () => undefined as never
        })
      ).rejects.toThrow("house_book_settlement_api_stability_unproven");
    });
  });
});
