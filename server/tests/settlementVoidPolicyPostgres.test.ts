import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { config } from "../config";
import { closePool } from "../db/client";
import { claimTicketToAvailable, recordLegSettlement } from "../db/settlementRepository";
import { getTicket, listClaimableTickets } from "../db/ticketRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const settlementSummaryMigration = "0046_ticket_settlement_summaries.sql";
const economicTermsHardeningMigration = "0047_ticket_economic_terms_hardening.sql";
const originalDatabaseUrl = config.DATABASE_URL;

async function migrationNames() {
  return (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
}

async function applyMigration(client: pg.Client, migration: string) {
  await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
}

async function applyMigrations(client: pg.Client, options: { through?: string } = {}) {
  for (const migration of await migrationNames()) {
    if (options.through && migration > options.through) break;
    await applyMigration(client, migration);
  }
}

function databaseUrlForSchema(schema: string) {
  const url = new URL(testDatabaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function withDisposableSchema(
  context: TestContext,
  run: (client: pg.Client) => Promise<void>,
  options: { stopBeforeSettlementSummaryMigration?: boolean } = {}
) {
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

  const schema = `settlement_void_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    if (options.stopBeforeSettlementSummaryMigration) {
      const names = await migrationNames();
      const precedingMigration = names[names.indexOf(settlementSummaryMigration) - 1];
      if (!precedingMigration) throw new Error("settlement_summary_preceding_migration_missing");
      await applyMigrations(client, { through: precedingMigration });
    } else {
      await applyMigrations(client);
    }

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

type SeededTicket = {
  userId: string;
  ticketId: string;
  ticketLegIds: [string, string];
  userAvailableAccountId: string;
  userClaimableAccountId: string;
};

async function seedPlayMoneyTicket(client: pg.Client): Promise<SeededTicket> {
  const userId = randomUUID();
  const policyId = randomUUID();
  const quoteId = randomUUID();
  const ticketId = randomUUID();
  const ticketLegIds: [string, string] = [randomUUID(), randomUUID()];
  const quotedPrices = [4_000, 5_000];

  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  await client.query(
    "INSERT INTO policy_versions (id, version, description, policy) VALUES ($1, $2, 'void policy test', '{}'::jsonb)",
    [policyId, `void-policy-${policyId}`]
  );
  await client.query(
    `
      INSERT INTO quotes (
        id, user_id, policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
        spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
      )
      VALUES ($1, $2, $3, 'accepted', 10000000, 1000000, 0, 2000, 100000000, now() + interval '1 hour')
    `,
    [quoteId, userId, policyId]
  );

  const quoteLegIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const marketId = randomUUID();
    const outcomeId = randomUUID();
    const snapshotId = randomUUID();
    const quoteLegId = randomUUID();
    quoteLegIds.push(quoteLegId);
    await client.query(
      `
        INSERT INTO markets (id, source, source_market_id, question, market_url, category, end_date)
        VALUES ($1, 'polymarket', $2, $3, $4, 'Other', now() + interval '1 day')
      `,
      [marketId, `void-policy-market-${marketId}`, `Void policy leg ${index + 1}?`, `https://example.test/${marketId}`]
    );
    await client.query(
      "INSERT INTO market_outcomes (id, market_id, outcome, token_id) VALUES ($1, $2, 'Yes', $3)",
      [outcomeId, marketId, `${index + 1}${Date.now()}`]
    );
    await client.query(
      "INSERT INTO market_snapshots (id, market_id, source_response_hash, raw) VALUES ($1, $2, $3, '{}'::jsonb)",
      [snapshotId, marketId, `void-policy-snapshot-${snapshotId}`]
    );
    await client.query(
      `
        INSERT INTO quote_legs (id, quote_id, market_id, outcome_id, market_snapshot_id, outcome, quoted_price_bps)
        VALUES ($1, $2, $3, $4, $5, 'Yes', $6)
      `,
      [quoteLegId, quoteId, marketId, outcomeId, snapshotId, quotedPrices[index]]
    );
  }

  await client.query(
    `
      INSERT INTO tickets (id, user_id, quote_id, status, accounting_mode, funding_currency)
      VALUES ($1, $2, $3, 'live', 'play_money', 'USD')
    `,
    [ticketId, userId, quoteId]
  );
  await client.query(
    `
      INSERT INTO ticket_legs (id, ticket_id, quote_leg_id, status, settlement_due_at, created_at)
      VALUES
        ($1, $3, $4, 'pending', now() - interval '1 hour', now() - interval '2 seconds'),
        ($2, $3, $5, 'pending', now() - interval '1 hour', now() - interval '1 second')
    `,
    [ticketLegIds[0], ticketLegIds[1], ticketId, quoteLegIds[0], quoteLegIds[1]]
  );

  const accounts = await client.query<{ id: string; account_type: string }>(
    `
      INSERT INTO ledger_accounts (user_id, account_type, currency)
      VALUES
        ($1, 'play_money', 'USD'),
        ($1, 'play_money_claimable', 'USD'),
        (NULL, 'house_play_money', 'USD'),
        (NULL, 'house_play_money_reserve', 'USD')
      RETURNING id, account_type
    `,
    [userId]
  );
  const accountId = (accountType: string) => {
    const account = accounts.rows.find((row) => row.account_type === accountType);
    if (!account) throw new Error(`void_policy_account_missing:${accountType}`);
    return account.id;
  };
  const userAvailableAccountId = accountId("play_money");
  const userClaimableAccountId = accountId("play_money_claimable");
  const houseOperatingAccountId = accountId("house_play_money");
  const houseReserveAccountId = accountId("house_play_money_reserve");
  const fundingTransactionId = randomUUID();
  const purchaseTransactionId = randomUUID();
  const reserveTransactionId = randomUUID();

  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES
        ($1, $2, 11000000, 'USD', 'void policy test funding'),
        ($1, $3, -11000000, 'USD', 'void policy test funding'),
        ($4, $2, -11000000, 'USD', 'quote accepted'),
        ($4, $3, 11000000, 'USD', 'quote accepted'),
        ($5, $3, -90000000, 'USD', 'ticket liability reserved'),
        ($5, $6, 90000000, 'USD', 'ticket liability reserved')
    `,
    [
      fundingTransactionId,
      userAvailableAccountId,
      houseOperatingAccountId,
      purchaseTransactionId,
      reserveTransactionId,
      houseReserveAccountId
    ]
  );
  await client.query(
    `
      INSERT INTO ticket_reserves (
        ticket_id, user_id, accounting_mode, currency, stake_micro_units,
        operation_fee_micro_units, offered_payout_micro_units, net_liability_micro_units,
        status, purchase_transaction_id, reserve_transaction_id
      )
      VALUES ($1, $2, 'play_money', 'USD', 10000000, 1000000, 100000000, 90000000, 'reserved', $3, $4)
    `,
    [ticketId, userId, purchaseTransactionId, reserveTransactionId]
  );

  return { userId, ticketId, ticketLegIds, userAvailableAccountId, userClaimableAccountId };
}

async function accountBalance(client: pg.Client, accountId: string) {
  const result = await client.query<{ balance: string }>(
    "SELECT COALESCE(sum(amount_micro_units), 0)::text AS balance FROM ledger_entries WHERE account_id = $1",
    [accountId]
  );
  return result.rows[0].balance;
}

async function summaryForTicket(client: pg.Client, ticketId: string) {
  const result = await client.query<{
    id: string;
    finalStatus: string;
    calculationVersion: string;
    stakeMicroUnits: string;
    originalOfferedPayoutMicroUnits: string;
    finalPayoutMicroUnits: string;
    operationFeeMicroUnits: string;
    calculation: {
      voidedLegIds: string[];
      lostLegIds: string[];
      frozenPricesBps: Array<{ legId: string; priceBps: string }>;
    };
  }>(
    `
      SELECT
        id,
        final_status AS "finalStatus",
        calculation_version AS "calculationVersion",
        stake_micro_units::text AS "stakeMicroUnits",
        original_offered_payout_micro_units::text AS "originalOfferedPayoutMicroUnits",
        final_payout_micro_units::text AS "finalPayoutMicroUnits",
        operation_fee_micro_units::text AS "operationFeeMicroUnits",
        calculation
      FROM ticket_settlement_summaries
      WHERE ticket_id = $1
    `,
    [ticketId]
  );
  return result.rows[0];
}

afterEach(async () => {
  await closePool();
  config.DATABASE_URL = originalDatabaseUrl;
});

postgresDescribe("per-leg void settlement PostgreSQL integration", () => {
  it("creates a claimable partial-void win from the frozen void-leg price exactly once", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const seeded = await seedPlayMoneyTicket(client);
      const voidInput = { ticketLegId: seeded.ticketLegIds[0], result: "voided" as const, source: "manual_ops" };

      await expect(recordLegSettlement(voidInput)).resolves.toMatchObject({ ticketStatus: "live" });
      await expect(recordLegSettlement(voidInput)).resolves.toMatchObject({ ticketStatus: "live" });
      await expect(recordLegSettlement({
        ticketLegId: seeded.ticketLegIds[1],
        result: "won",
        source: "manual_ops"
      })).resolves.toMatchObject({ ticketStatus: "claimable" });

      const summary = await summaryForTicket(client, seeded.ticketId);
      expect(summary).toMatchObject({
        finalStatus: "won",
        calculationVersion: "partial-void-v1",
        stakeMicroUnits: "10000000",
        originalOfferedPayoutMicroUnits: "100000000",
        finalPayoutMicroUnits: "40000000",
        operationFeeMicroUnits: "1000000"
      });
      expect(summary.calculation.voidedLegIds).toEqual([seeded.ticketLegIds[0]]);
      expect(summary.calculation.frozenPricesBps).toEqual([
        { legId: seeded.ticketLegIds[0], priceBps: "4000" },
        { legId: seeded.ticketLegIds[1], priceBps: "5000" }
      ]);
      expect(await accountBalance(client, seeded.userClaimableAccountId)).toBe("40000000");

      await expect(claimTicketToAvailable({
        ticketId: seeded.ticketId,
        userId: seeded.userId,
        idempotencyKey: "partial-void-win-claim"
      })).resolves.toMatchObject({ amountMicroUnits: "40000000", ticketStatus: "paid" });
      expect(await accountBalance(client, seeded.userAvailableAccountId)).toBe("40000000");
      expect(await accountBalance(client, seeded.userClaimableAccountId)).toBe("0");

      await expect(client.query(
        "UPDATE ticket_settlement_summaries SET final_payout_micro_units = 1 WHERE id = $1",
        [summary.id]
      )).rejects.toThrow("append_only_table_mutation:ticket_settlement_summaries");
      await expect(client.query("DELETE FROM ticket_settlement_summaries WHERE id = $1", [summary.id])).rejects.toThrow(
        "append_only_table_mutation:ticket_settlement_summaries"
      );

      const economicRows = await client.query<{ quote_id: string; quote_leg_id: string; reserve_id: string }>(
        `
          SELECT tickets.quote_id, ticket_legs.quote_leg_id, ticket_reserves.id AS reserve_id
          FROM tickets
          JOIN ticket_legs ON ticket_legs.ticket_id = tickets.id
          JOIN ticket_reserves ON ticket_reserves.ticket_id = tickets.id
          WHERE tickets.id = $1
          ORDER BY ticket_legs.created_at
          LIMIT 1
        `,
        [seeded.ticketId]
      );
      const economicRow = economicRows.rows[0];
      await expect(client.query(
        "UPDATE quotes SET offered_payout_micro_usd = offered_payout_micro_usd + 1 WHERE id = $1",
        [economicRow.quote_id]
      )).rejects.toThrow("accepted_quote_economic_terms_immutable");
      await expect(client.query(
        "UPDATE quote_legs SET quoted_price_bps = quoted_price_bps + 1 WHERE id = $1",
        [economicRow.quote_leg_id]
      )).rejects.toThrow("accepted_quote_leg_immutable");
      await expect(client.query(
        "UPDATE ticket_legs SET accepted_price_bps = accepted_price_bps + 1 WHERE ticket_id = $1 AND quote_leg_id = $2",
        [seeded.ticketId, economicRow.quote_leg_id]
      )).rejects.toThrow("ticket_leg_economic_identity_immutable");
      await expect(client.query(
        "UPDATE ticket_legs SET quote_leg_id = $2 WHERE ticket_id = $1 AND quote_leg_id = $3",
        [seeded.ticketId, randomUUID(), economicRow.quote_leg_id]
      )).rejects.toThrow("ticket_leg_economic_identity_immutable");
      await expect(client.query(
        "INSERT INTO ticket_legs (ticket_id, quote_leg_id, status, accepted_price_bps) VALUES ($1, $2, 'pending', 1)",
        [seeded.ticketId, economicRow.quote_leg_id]
      )).rejects.toThrow("ticket_leg_accepted_terms_invalid");
      await expect(client.query(
        "DELETE FROM ticket_legs WHERE ticket_id = $1 AND quote_leg_id = $2",
        [seeded.ticketId, economicRow.quote_leg_id]
      )).rejects.toThrow("ticket_leg_economic_identity_immutable");
      await expect(client.query(
        "UPDATE ticket_reserves SET offered_payout_micro_units = offered_payout_micro_units + 1 WHERE id = $1",
        [economicRow.reserve_id]
      )).rejects.toThrow("ticket_reserve_economic_terms_immutable");
      await expect(client.query("DELETE FROM ticket_reserves WHERE id = $1", [economicRow.reserve_id])).rejects.toThrow(
        "ticket_reserve_economic_terms_immutable"
      );
      await expect(client.query("UPDATE tickets SET quote_id = $2 WHERE id = $1", [seeded.ticketId, randomUUID()])).rejects.toThrow(
        "ticket_economic_identity_immutable"
      );
      await expect(client.query("DELETE FROM tickets WHERE id = $1", [seeded.ticketId])).rejects.toThrow(
        "ticket_economic_identity_immutable"
      );

      await expect(recordLegSettlement({
        ticketLegId: seeded.ticketLegIds[1],
        result: "won",
        source: "manual_ops"
      })).rejects.toThrow("ticket_settlement_terminal_status");
      const effects = await client.query<{ summaries: string; settlements: string; payoutEntries: string }>(
        `
          SELECT
            (SELECT count(*)::text FROM ticket_settlement_summaries WHERE ticket_id = $1) AS summaries,
            (SELECT count(*)::text FROM settlements WHERE ticket_leg_id = ANY($2::uuid[])) AS settlements,
            (SELECT count(*)::text FROM ledger_entries WHERE memo = 'ticket settlement claimable') AS "payoutEntries"
        `,
        [seeded.ticketId, seeded.ticketLegIds]
      );
      expect(effects.rows[0]).toEqual({ summaries: "1", settlements: "2", payoutEntries: "2" });
    });
  });

  it("settles a void plus loss as lost with zero payout", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const seeded = await seedPlayMoneyTicket(client);
      await recordLegSettlement({ ticketLegId: seeded.ticketLegIds[0], result: "voided", source: "manual_ops" });
      await expect(recordLegSettlement({
        ticketLegId: seeded.ticketLegIds[1],
        result: "lost",
        source: "manual_ops"
      })).resolves.toMatchObject({ ticketStatus: "lost" });

      expect(await summaryForTicket(client, seeded.ticketId)).toMatchObject({
        finalStatus: "lost",
        finalPayoutMicroUnits: "0"
      });
      expect(await accountBalance(client, seeded.userAvailableAccountId)).toBe("0");
      expect(await accountBalance(client, seeded.userClaimableAccountId)).toBe("0");
      await expect(claimTicketToAvailable({
        ticketId: seeded.ticketId,
        userId: seeded.userId,
        idempotencyKey: "lost-ticket-claim"
      })).rejects.toThrow("ticket_not_claimable");
    });
  });

  it("automatically returns stake for an all-void ticket without making it claimable", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const seeded = await seedPlayMoneyTicket(client);
      await recordLegSettlement({ ticketLegId: seeded.ticketLegIds[0], result: "voided", source: "manual_ops" });
      await expect(recordLegSettlement({
        ticketLegId: seeded.ticketLegIds[1],
        result: "voided",
        source: "manual_ops"
      })).resolves.toMatchObject({ ticketStatus: "voided" });

      expect(await summaryForTicket(client, seeded.ticketId)).toMatchObject({
        finalStatus: "voided",
        finalPayoutMicroUnits: "10000000",
        operationFeeMicroUnits: "1000000"
      });
      const ticket = await client.query<{ status: string }>("SELECT status FROM tickets WHERE id = $1", [seeded.ticketId]);
      expect(ticket.rows[0].status).toBe("voided");
      expect(await accountBalance(client, seeded.userAvailableAccountId)).toBe("10000000");
      expect(await accountBalance(client, seeded.userClaimableAccountId)).toBe("0");
      await expect(claimTicketToAvailable({
        ticketId: seeded.ticketId,
        userId: seeded.userId,
        idempotencyKey: "all-void-ticket-claim"
      })).rejects.toThrow("ticket_not_claimable");
    });
  });

  it("quarantines legacy whole-ticket void precedence and blocks final settlement and claim", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const seeded = await seedPlayMoneyTicket(client);
      await client.query(
        `
          INSERT INTO settlements (ticket_leg_id, source, result, proof_reference, raw)
          VALUES ($1, 'legwork_void_policy', 'voided', 'whole_ticket_void_precedence', '{}'::jsonb)
        `,
        [seeded.ticketLegIds[0]]
      );
      await applyMigration(client, settlementSummaryMigration);
      await applyMigration(client, economicTermsHardeningMigration);

      const quarantine = await client.query<{ reason: string; evidence: Record<string, unknown> }>(
        "SELECT reason, evidence FROM ticket_settlement_policy_quarantines WHERE ticket_id = $1",
        [seeded.ticketId]
      );
      expect(quarantine.rows[0]).toMatchObject({
        reason: "legacy_void_policy_requires_reconciliation",
        evidence: {
          ticketStatus: "live",
          voidedLegStatusCount: 0,
          voidSettlementCount: 1,
          syntheticSettlementCount: 1,
          requiresSupervisedReconciliation: true
        }
      });

      await recordLegSettlement({ ticketLegId: seeded.ticketLegIds[0], result: "voided", source: "manual_ops" });
      await expect(recordLegSettlement({
        ticketLegId: seeded.ticketLegIds[1],
        result: "won",
        source: "manual_ops"
      })).rejects.toThrow("ticket_settlement_policy_quarantined");
      await expect(claimTicketToAvailable({
        ticketId: seeded.ticketId,
        userId: seeded.userId,
        idempotencyKey: "quarantined-ticket-claim"
      })).rejects.toThrow("ticket_settlement_policy_quarantined");

      const state = await client.query<{ status: string; summaries: string; claims: string; pendingLegs: string }>(
        `
          SELECT
            tickets.status,
            (SELECT count(*)::text FROM ticket_settlement_summaries WHERE ticket_id = tickets.id) AS summaries,
            (SELECT count(*)::text FROM settlement_claims WHERE ticket_id = tickets.id) AS claims,
            (SELECT count(*)::text FROM ticket_legs WHERE ticket_id = tickets.id AND status = 'pending') AS "pendingLegs"
          FROM tickets
          WHERE tickets.id = $1
        `,
        [seeded.ticketId]
      );
      expect(state.rows[0]).toEqual({ status: "live", summaries: "0", claims: "0", pendingLegs: "1" });
    }, { stopBeforeSettlementSummaryMigration: true });
  });

  it("quarantines a legacy void ticket without a synthetic policy marker and hides it from claims", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const seeded = await seedPlayMoneyTicket(client);
      await client.query(
        "UPDATE ticket_legs SET status = CASE WHEN id = $2 THEN 'won' ELSE 'voided' END, settled_at = now() WHERE ticket_id = $1",
        [seeded.ticketId, seeded.ticketLegIds[0]]
      );
      await client.query("UPDATE tickets SET status = 'claimable' WHERE id = $1", [seeded.ticketId]);
      await client.query(
        `
          INSERT INTO settlements (ticket_leg_id, source, result, proof_reference, raw)
          VALUES
            ($1, 'manual_ops', 'won', 'legacy-manual', '{}'::jsonb),
            ($2, 'manual_ops', 'voided', 'legacy-manual', '{}'::jsonb)
        `,
        seeded.ticketLegIds
      );

      await applyMigration(client, settlementSummaryMigration);
      await applyMigration(client, economicTermsHardeningMigration);

      const quarantine = await client.query<{ reason: string; evidence: Record<string, unknown> }>(
        "SELECT reason, evidence FROM ticket_settlement_policy_quarantines WHERE ticket_id = $1",
        [seeded.ticketId]
      );
      expect(quarantine.rows[0]).toMatchObject({
        reason: "legacy_void_policy_requires_reconciliation",
        evidence: {
          ticketStatus: "claimable",
          voidedLegStatusCount: 1,
          voidSettlementCount: 1,
          syntheticSettlementCount: 0,
          requiresSupervisedReconciliation: true
        }
      });
      await expect(listClaimableTickets(seeded.userId, { limit: 10 })).resolves.toMatchObject({ tickets: [] });
      await expect(getTicket(seeded.ticketId, seeded.userId)).resolves.toMatchObject({
        ticketId: seeded.ticketId,
        status: "claimable",
        settlementPolicyReviewRequired: true,
        claimableAmountUsd: 0
      });
      await expect(claimTicketToAvailable({
        ticketId: seeded.ticketId,
        userId: seeded.userId,
        idempotencyKey: "unmarked-legacy-void-claim"
      })).rejects.toThrow("ticket_settlement_policy_quarantined");
    }, { stopBeforeSettlementSummaryMigration: true });
  });

  it("quarantines a legacy ticket whose accepted reserve terms are missing", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const seeded = await seedPlayMoneyTicket(client);
      await client.query("DELETE FROM ticket_reserves WHERE ticket_id = $1", [seeded.ticketId]);

      await applyMigration(client, settlementSummaryMigration);
      await applyMigration(client, economicTermsHardeningMigration);

      const quarantine = await client.query<{ reason: string; evidence: Record<string, unknown> }>(
        "SELECT reason, evidence FROM ticket_settlement_policy_quarantines WHERE ticket_id = $1",
        [seeded.ticketId]
      );
      expect(quarantine.rows[0]).toMatchObject({
        reason: "legacy_ticket_financial_terms_missing",
        evidence: {
          ticketStatus: "live",
          ticketReserveMissing: true,
          requiresSupervisedReconciliation: true
        }
      });
      await expect(getTicket(seeded.ticketId, seeded.userId)).resolves.toMatchObject({
        ticketId: seeded.ticketId,
        settlementPolicyReviewRequired: true,
        claimableAmountUsd: 0
      });
      await recordLegSettlement({ ticketLegId: seeded.ticketLegIds[0], result: "won", source: "manual_ops" });
      await expect(recordLegSettlement({
        ticketLegId: seeded.ticketLegIds[1],
        result: "won",
        source: "manual_ops"
      })).rejects.toThrow("ticket_settlement_policy_quarantined");
    }, { stopBeforeSettlementSummaryMigration: true });
  });
});
