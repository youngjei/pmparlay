import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { buildSettlementRpcEndpoints, config } from "../config";
import { closePool } from "../db/client";
import {
  claimTicketToAvailable,
  recordLegSettlement,
  recordSettlementObservation,
  recordSettlementProof
} from "../db/settlementRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const conditionId = `0x${"1".repeat(64)}`;
const collectionId = `0x${"2".repeat(64)}`;
const blockHash = `0x${"3".repeat(64)}`;
const tokenId = "12345";
const validationBlockNumber = 1_000;

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

function temporaryRpcEndpoints() {
  return buildSettlementRpcEndpoints([
    { url: "https://primary-settlement.test/rpc", operator: "primary-operator" },
    { url: "https://secondary-settlement.test/rpc", operator: "secondary-operator" }
  ]);
}

function positionProviderEvidence() {
  return config.POLYGON_RPC_ENDPOINTS.map((endpoint, index) => ({
    provider: index === 0 ? "primary" : "secondary",
    rpcHost: new URL(endpoint.url).host,
    rpcEndpointId: endpoint.endpointId,
    rpcOperator: endpoint.operator,
    status: "ok",
    chainId: 137,
    finalizedBlockNumber: validationBlockNumber,
    proofBlockNumber: validationBlockNumber,
    proofBlockHash: blockHash,
    blockNumber: validationBlockNumber,
    blockHash,
    computedPositionId: tokenId,
    collectionId,
    readMode: "blockHash",
    blockHashReadSupported: true
  }));
}

function payoutProviderEvidence() {
  return config.POLYGON_RPC_ENDPOINTS.map((endpoint, index) => ({
    provider: index === 0 ? "primary" : "secondary",
    rpcHost: new URL(endpoint.url).host,
    rpcEndpointId: endpoint.endpointId,
    rpcOperator: endpoint.operator,
    status: "ok",
    chainId: 137,
    finalizedBlockNumber: validationBlockNumber,
    proofBlockNumber: validationBlockNumber,
    proofBlockHash: blockHash,
    blockNumber: validationBlockNumber,
    blockHash,
    payoutDenominator: "1",
    payoutNumerators: ["1", "0"],
    readMode: "blockHash",
    blockHashReadSupported: true
  }));
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
  const originalQuorum = config.SETTLEMENT_RPC_QUORUM;
  const originalEndpoints = config.POLYGON_RPC_ENDPOINTS.slice();
  const schema = `settlement_replay_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await applyMigrations(client);

    await closePool();
    config.DATABASE_URL = databaseUrlForSchema(schema);
    config.SETTLEMENT_RPC_QUORUM = 2;
    config.POLYGON_RPC_ENDPOINTS.splice(0, config.POLYGON_RPC_ENDPOINTS.length, ...temporaryRpcEndpoints());
    await run(client);
  } finally {
    await closePool();
    config.DATABASE_URL = originalDatabaseUrl;
    config.SETTLEMENT_RPC_QUORUM = originalQuorum;
    config.POLYGON_RPC_ENDPOINTS.splice(0, config.POLYGON_RPC_ENDPOINTS.length, ...originalEndpoints);
    try {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
}

async function seedFrozenHouseBookLeg(client: pg.Client) {
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
  const sourceMarketId = `settlement-replay-${ids.market}`;
  const settlementDueAt = "2026-07-13T00:00:00.000Z";

  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [ids.user, `${ids.user}@example.test`]);
  await client.query(
    "INSERT INTO policy_versions (id, version, description, policy) VALUES ($1, $2, 'settlement replay', '{}'::jsonb)",
    [ids.policy, `settlement-replay-${ids.policy}`]
  );
  await client.query(
    `
      INSERT INTO markets (id, source, source_market_id, condition_id, question, market_url, category, end_date)
      VALUES ($1, 'polymarket', $2, $3, 'Will the final CTF result be Yes?', 'https://example.test/settlement-replay', 'Other', $4)
    `,
    [ids.market, sourceMarketId, conditionId, settlementDueAt]
  );
  await client.query("INSERT INTO market_outcomes (id, market_id, outcome, token_id) VALUES ($1, $2, 'Yes', $3)", [
    ids.outcome,
    ids.market,
    tokenId
  ]);
  await client.query(
    `
      INSERT INTO market_snapshots (id, market_id, source_response_hash, raw)
      VALUES ($1, $2, 'settlement-replay-snapshot', $3)
    `,
    [
      ids.snapshot,
      ids.market,
      {
        marketId: sourceMarketId,
        outcomes: [
          {
            marketId: sourceMarketId,
            question: "Will the final CTF result be Yes?",
            outcome: "Yes",
            conditionId,
            tokenId,
            endDate: settlementDueAt
          }
        ]
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

  const accounts = await client.query<{ id: string; account_type: string }>(
    `
      INSERT INTO ledger_accounts (user_id, account_type, currency)
      VALUES
        ($1, 'user_usdc_available', 'USDC'),
        (NULL, 'house_usdc_operating', 'USDC'),
        (NULL, 'house_usdc_reserve', 'USDC')
      RETURNING id, account_type
    `,
    [ids.user]
  );
  const accountId = (type: string) => {
    const account = accounts.rows.find((row) => row.account_type === type);
    if (!account) throw new Error(`settlement_replay_account_missing:${type}`);
    return account.id;
  };
  const userAvailable = accountId("user_usdc_available");
  const houseOperating = accountId("house_usdc_operating");
  const houseReserve = accountId("house_usdc_reserve");
  const fundingTransactionId = randomUUID();
  const purchaseTransactionId = randomUUID();
  const reserveTransactionId = randomUUID();
  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES
        ($1, $2, 1000000, 'USDC', 'settlement replay funding'),
        ($1, $3, -1000000, 'USDC', 'settlement replay funding'),
        ($4, $2, -1000000, 'USDC', 'quote accepted'),
        ($4, $3, 1000000, 'USDC', 'quote accepted'),
        ($5, $3, -1000000, 'USDC', 'ticket liability reserved'),
        ($5, $6, 1000000, 'USDC', 'ticket liability reserved')
    `,
    [fundingTransactionId, userAvailable, houseOperating, purchaseTransactionId, reserveTransactionId, houseReserve]
  );
  await client.query(
    `
      INSERT INTO ticket_reserves (
        ticket_id, user_id, accounting_mode, currency, stake_micro_units,
        operation_fee_micro_units, offered_payout_micro_units,
        net_liability_micro_units, status, purchase_transaction_id,
        reserve_transaction_id
      )
      VALUES ($1, $2, 'house_book_usdc', 'USDC', 1000000, 0, 2000000, 1000000, 'reserved', $3, $4)
    `,
    [ids.ticket, ids.user, purchaseTransactionId, reserveTransactionId]
  );

  const validationProofId = await recordSettlementProof(client as unknown as pg.PoolClient, {
    ticketLegId: ids.ticketLeg,
    source: "legwork_settlement_identity",
    proofKind: "ctf_position_id_validation",
    result: "pending",
    confidence: "onchain_confirmed",
    chainId: 137,
    contractAddress: config.POLYMARKET_CTF_ADDRESS,
    collateralAddress: config.POLYMARKET_COLLATERAL_ADDRESS,
    conditionId,
    tokenId,
    outcomeIndex: 0,
    blockNumber: validationBlockNumber,
    blockHash,
    providerEvidence: positionProviderEvidence(),
    raw: { computedPositionId: tokenId, collectionId }
  });
  await client.query(
    `
      UPDATE ticket_legs
      SET
        settlement_source = 'polymarket_ctf',
        settlement_authority = 'polygon_ctf',
        settlement_chain_id = 137,
        settlement_contract_address = $2,
        settlement_collateral_address = $3,
        settlement_condition_id = $4,
        settlement_token_id = $5,
        settlement_position_id = $5,
        settlement_collection_id = $6,
        settlement_outcome_index = 0,
        settlement_payout_slot_count = 2,
        settlement_question = 'Will the final CTF result be Yes?',
        settlement_outcome = 'Yes',
        settlement_source_market_id = $7,
        settlement_source_snapshot_id = $8,
        settlement_rules_snapshot_hash = 'settlement-replay-snapshot',
        settlement_identity_raw = $9,
        settlement_identity_validation_proof_id = $10,
        settlement_identity_validation_block_number = $11,
        settlement_identity_validation_block_hash = $12,
        settlement_frozen_at = now()
      WHERE id = $1
    `,
    [
      ids.ticketLeg,
      config.POLYMARKET_CTF_ADDRESS,
      config.POLYMARKET_COLLATERAL_ADDRESS,
      conditionId,
      tokenId,
      collectionId,
      sourceMarketId,
      ids.snapshot,
      { conditionId, tokenId, positionId: tokenId, collectionId, sourceMarketId },
      validationProofId,
      validationBlockNumber,
      blockHash
    ]
  );

  return ids;
}

async function settlementState(client: pg.Client, ids: Awaited<ReturnType<typeof seedFrozenHouseBookLeg>>) {
  const settlements = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM settlements WHERE ticket_leg_id = $1",
    [ids.ticketLeg]
  );
  const claimableAudits = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_log WHERE action = 'ticket.claimable' AND entity_type = 'ticket' AND entity_id = $1",
    [ids.ticket]
  );
  const settledAudits = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_log WHERE action = 'ticket_leg.settled' AND entity_id = $1",
    [ids.ticketLeg]
  );
  const observationAudits = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_log WHERE action = 'ticket_leg.resolution_observed' AND entity_id = $1",
    [ids.ticketLeg]
  );
  const finalProofs = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM settlement_proofs WHERE ticket_leg_id = $1",
    [ids.ticketLeg]
  );
  const claimableLedgerEntries = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM ledger_entries WHERE memo = 'ticket settlement claimable'"
  );
  const outbox = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox WHERE topic = 'ticket.settlement.updated'");
  const reserve = await client.query<{ status: string; releaseTransactionId: string | null }>(
    `
      SELECT status, release_transaction_id::text AS "releaseTransactionId"
      FROM ticket_reserves
      WHERE ticket_id = $1
    `,
    [ids.ticket]
  );
  const reserveReleaseEntries = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM ledger_entries WHERE memo = 'ticket liability reserve released'"
  );
  const claimableBalance = await client.query<{ balance: string }>(
    `
      SELECT COALESCE(sum(ledger_entries.amount_micro_units), 0)::text AS balance
      FROM ledger_entries
      JOIN ledger_accounts ON ledger_accounts.id = ledger_entries.account_id
      WHERE ledger_accounts.user_id = $1
        AND ledger_accounts.account_type = 'user_usdc_claimable'
        AND ledger_accounts.currency = 'USDC'
    `,
    [ids.user]
  );
  const ticket = await client.query<{ status: string }>("SELECT status FROM tickets WHERE id = $1", [ids.ticket]);

  return {
    settlements: settlements.rows[0].count,
    claimableAudits: claimableAudits.rows[0].count,
    settledAudits: settledAudits.rows[0].count,
    observationAudits: observationAudits.rows[0].count,
    proofs: finalProofs.rows[0].count,
    claimableLedgerEntries: claimableLedgerEntries.rows[0].count,
    outbox: outbox.rows[0].count,
    reserveStatus: reserve.rows[0]?.status,
    reserveReleaseTransactionId: reserve.rows[0]?.releaseTransactionId,
    reserveReleaseEntries: reserveReleaseEntries.rows[0].count,
    claimableBalance: claimableBalance.rows[0].balance,
    ticketStatus: ticket.rows[0]?.status
  };
}

postgresDescribe("house-book settlement replay PostgreSQL integration", () => {
  it("keeps settlement and claim effects exactly once across outage, CTF finality, and replay", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const ids = await seedFrozenHouseBookLeg(client);

      await expect(
        recordSettlementObservation({
          ticketLegId: ids.ticketLeg,
          resolutionState: "awaiting_oracle",
          source: "polymarket_ctf",
          proofKind: "ctf_rpc_quorum_unavailable",
          result: "blocked",
          confidence: "api_signal",
          chainId: 137,
          contractAddress: config.POLYMARKET_CTF_ADDRESS,
          collateralAddress: config.POLYMARKET_COLLATERAL_ADDRESS,
          conditionId,
          tokenId,
          outcomeIndex: 0,
          providerEvidence: config.POLYGON_RPC_ENDPOINTS.map((endpoint, index) => ({
            provider: index === 0 ? "primary" : "secondary",
            rpcHost: new URL(endpoint.url).host,
            rpcEndpointId: endpoint.endpointId,
            rpcOperator: endpoint.operator,
            status: "error",
            chainId: 137,
            error: "simulated_rpc_outage"
          })),
          error: "simulated_rpc_outage"
        })
      ).resolves.toBe(true);

      expect(await settlementState(client, ids)).toEqual({
        settlements: "0",
        claimableAudits: "0",
        settledAudits: "0",
        observationAudits: "1",
        proofs: "2",
        claimableLedgerEntries: "0",
        outbox: "0",
        reserveStatus: "reserved",
        reserveReleaseTransactionId: null,
        reserveReleaseEntries: "0",
        claimableBalance: "0",
        ticketStatus: "live"
      });

      const finalInput = {
        ticketLegId: ids.ticketLeg,
        result: "won" as const,
        source: "polymarket_ctf",
        proofReference: "ctf_payout_vector",
        proof: {
          source: "polymarket_ctf",
          proofKind: "ctf_payout_vector",
          result: "won" as const,
          confidence: "onchain_confirmed" as const,
          chainId: 137,
          contractAddress: config.POLYMARKET_CTF_ADDRESS,
          collateralAddress: config.POLYMARKET_COLLATERAL_ADDRESS,
          conditionId,
          tokenId,
          outcomeIndex: 0,
          payoutNumerator: "1",
          payoutDenominator: "1",
          payoutVector: ["1", "0"],
          blockNumber: validationBlockNumber,
          blockHash,
          providerEvidence: payoutProviderEvidence(),
          resolvedAt: "2026-07-14T00:00:00.000Z"
        },
        assertFinancialGateOpenInTransaction: async () => undefined as never
      };

      await expect(recordLegSettlement(finalInput)).resolves.toEqual({
        ticketLegId: ids.ticketLeg,
        ticketId: ids.ticket,
        legStatus: "won",
        ticketStatus: "claimable"
      });

      const afterFinal = await settlementState(client, ids);
      expect(afterFinal).toEqual({
        settlements: "1",
        claimableAudits: "1",
        settledAudits: "1",
        observationAudits: "1",
        proofs: "3",
        claimableLedgerEntries: "2",
        outbox: "1",
        reserveStatus: "paid",
        reserveReleaseTransactionId: expect.any(String),
        reserveReleaseEntries: "2",
        claimableBalance: "2000000",
        ticketStatus: "claimable"
      });

      await expect(recordLegSettlement(finalInput)).rejects.toThrow("ticket_settlement_terminal_status");
      expect(await settlementState(client, ids)).toEqual(afterFinal);

      const claim = await claimTicketToAvailable({
        ticketId: ids.ticket,
        userId: ids.user,
        idempotencyKey: "settlement-replay-claim",
        assertFinancialGateOpenInTransaction: async () => undefined as never
      });
      expect(claim).toMatchObject({
        status: "claimed",
        ticketStatus: "paid",
        amountMicroUnits: "2000000",
        currency: "USDC"
      });

      await expect(
        claimTicketToAvailable({
          ticketId: ids.ticket,
          userId: ids.user,
          idempotencyKey: "settlement-replay-claim",
          assertFinancialGateOpenInTransaction: async () => {
            throw new Error("financial_gate_closed:test_replay");
          }
        })
      ).resolves.toMatchObject({
        status: "already_claimed",
        ledgerTransactionId: claim.ledgerTransactionId
      });

      const claimState = await client.query<{
        claims: string;
        claimEntries: string;
        claimAudits: string;
        claimOutbox: string;
        claimableBalance: string;
        availableBalance: string;
        ticketStatus: string;
      }>(
        `
          SELECT
            (SELECT count(*)::text FROM settlement_claims WHERE ticket_id = $1) AS claims,
            (SELECT count(*)::text FROM ledger_entries WHERE memo = 'ticket claim to available') AS "claimEntries",
            (SELECT count(*)::text FROM audit_log WHERE action = 'ticket.claimed' AND entity_id = $1) AS "claimAudits",
            (SELECT count(*)::text FROM outbox WHERE topic = 'ticket.claimed' AND payload->>'ticketId' = $1::text) AS "claimOutbox",
            COALESCE(sum(ledger_entries.amount_micro_units) FILTER (
              WHERE ledger_accounts.account_type = 'user_usdc_claimable'
            ), 0)::text AS "claimableBalance",
            COALESCE(sum(ledger_entries.amount_micro_units) FILTER (
              WHERE ledger_accounts.account_type = 'user_usdc_available'
            ), 0)::text AS "availableBalance",
            (SELECT status FROM tickets WHERE id = $1) AS "ticketStatus"
          FROM ledger_accounts
          LEFT JOIN ledger_entries ON ledger_entries.account_id = ledger_accounts.id
          WHERE ledger_accounts.user_id = $2
        `,
        [ids.ticket, ids.user]
      );
      expect(claimState.rows[0]).toEqual({
        claims: "1",
        claimEntries: "2",
        claimAudits: "1",
        claimOutbox: "1",
        claimableBalance: "0",
        availableBalance: "2000000",
        ticketStatus: "paid"
      });

      const afterClaim = await settlementState(client, ids);
      expect(afterClaim).toMatchObject({
        settlements: "1",
        claimableAudits: "1",
        settledAudits: "1",
        proofs: "3",
        claimableLedgerEntries: "2",
        outbox: "1",
        reserveStatus: "paid",
        reserveReleaseTransactionId: afterFinal.reserveReleaseTransactionId,
        reserveReleaseEntries: "2",
        claimableBalance: "0",
        ticketStatus: "paid"
      });
    });
  });
});
