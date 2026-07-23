import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { config } from "../config";
import { closePool } from "../db/client";
import { claimTicketToAvailable } from "../db/settlementRepository";
import { listClaimableTickets } from "../db/ticketRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const originalDatabaseUrl = config.DATABASE_URL;

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
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      context.skip();
      return;
    }
    throw error;
  }

  const schema = `claim_${randomUUID().replaceAll("-", "")}`;
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
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

async function seedClaimableTicket(client: pg.Client, input: { userId: string; createdAt?: string; amountMicroUnits?: string }) {
  const policyId = randomUUID();
  const quoteId = randomUUID();
  const ticketId = randomUUID();
  const createdAt = input.createdAt || "2026-07-14T00:00:00.000000Z";
  const amountMicroUnits = input.amountMicroUnits || "1000000";

  await client.query(
    "INSERT INTO policy_versions (id, version, description, policy) VALUES ($1, $2, 'claim test', '{}'::jsonb)",
    [policyId, `claim-${policyId}`]
  );
  await client.query(
    `
      INSERT INTO quotes (
        id, user_id, policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
        spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at, created_at
      )
      VALUES ($1, $2, $3, 'accepted', $4, 0, 0, 5000, $4, now() + interval '1 hour', $5::timestamptz)
    `,
    [quoteId, input.userId, policyId, amountMicroUnits, createdAt]
  );
  await client.query(
    `
      INSERT INTO tickets (id, user_id, quote_id, status, accounting_mode, funding_currency, created_at, updated_at)
      VALUES ($1, $2, $3, 'claimable', 'house_book_usdc', 'USDC', $4::timestamptz, $4::timestamptz)
    `,
    [ticketId, input.userId, quoteId, createdAt]
  );
  await client.query(
    "INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1, 'ticket.claimable', 'ticket', $2, $3)",
    [input.userId, ticketId, { claimableMicroUnits: amountMicroUnits, currency: "USDC", accountingMode: "house_book_usdc" }]
  );
  return ticketId;
}

async function seedClaimableBalance(client: pg.Client, userId: string, amountMicroUnits: string) {
  const accounts = await client.query<{ id: string }>(
    `
      INSERT INTO ledger_accounts (user_id, account_type, currency)
      VALUES ($1, 'user_usdc_claimable', 'USDC'), (NULL, 'claim_test_offset', 'USDC')
      RETURNING id
    `,
    [userId]
  );
  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES ($1, $2, $4, 'USDC', 'claim test funding'), ($1, $3, $5, 'USDC', 'claim test funding')
    `,
    [randomUUID(), accounts.rows[0].id, accounts.rows[1].id, amountMicroUnits, (-BigInt(amountMicroUnits)).toString()]
  );
}

afterEach(async () => {
  await closePool();
  config.DATABASE_URL = originalDatabaseUrl;
});

postgresDescribe("settlement claim PostgreSQL integration", () => {
  it("paginates same-millisecond tickets with distinct PostgreSQL microseconds", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const userId = randomUUID();
      await client.query("INSERT INTO users (id, email) VALUES ($1, 'cursor@example.test')", [userId]);
      const newestTicketId = await seedClaimableTicket(client, { userId, createdAt: "2026-07-14T00:00:00.123456Z" });
      const olderTicketId = await seedClaimableTicket(client, { userId, createdAt: "2026-07-14T00:00:00.123455Z" });

      const firstPage = await listClaimableTickets(userId, { limit: 1 });
      const secondPage = await listClaimableTickets(userId, { limit: 1, cursor: firstPage.pageInfo.nextCursor });

      expect(firstPage.tickets.map((ticket) => ticket.ticketId)).toEqual([newestTicketId]);
      expect(secondPage.tickets.map((ticket) => ticket.ticketId)).toEqual([olderTicketId]);
      expect(Buffer.from(firstPage.pageInfo.nextCursor!, "base64url").toString("utf8")).toContain(".123456Z");
    });
  });

  it("serializes key reuse and replays a completed claim before a closed gate", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const userId = randomUUID();
      await client.query("INSERT INTO users (id, email) VALUES ($1, 'claim@example.test')", [userId]);
      const firstTicketId = await seedClaimableTicket(client, { userId });
      const secondTicketId = await seedClaimableTicket(client, { userId });
      await seedClaimableBalance(client, userId, "2000000");

      const key = "concurrent-claim-key";
      const results = await Promise.allSettled([
        claimTicketToAvailable({
          ticketId: firstTicketId,
          userId,
          idempotencyKey: key,
          assertFinancialGateOpenInTransaction: async () => undefined as never
        }),
        claimTicketToAvailable({
          ticketId: secondTicketId,
          userId,
          idempotencyKey: key,
          assertFinancialGateOpenInTransaction: async () => undefined as never
        })
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.message)).toEqual([
        "settlement_claim_idempotency_conflict"
      ]);

      const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimTicketToAvailable>>> => result.status === "fulfilled")!;
      const replayGate = async () => {
        throw new Error("financial_gate_closed:test");
      };
      await expect(
        claimTicketToAvailable({
          ticketId: winner.value.ticketId,
          userId,
          idempotencyKey: key,
          assertFinancialGateOpenInTransaction: replayGate
        })
      ).resolves.toMatchObject({ status: "already_claimed", ledgerTransactionId: winner.value.ledgerTransactionId });

      const claims = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM settlement_claims");
      const entries = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM ledger_entries WHERE memo = 'ticket claim to available'");
      expect(claims.rows[0].count).toBe("1");
      expect(entries.rows[0].count).toBe("2");
    });
  });
});
