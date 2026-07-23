import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { config } from "../config";
import { closePool } from "../db/client";
import {
  buildAndPersistSafeWithdrawalProposal,
  cancelWithdrawalRequest,
  createWithdrawalRequest
} from "../db/withdrawalRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const originalDatabaseUrl = config.DATABASE_URL;
const chainId = 11155111;
const treasuryAddress = "0x1234567890abcdef1234567890abcdef12345678";
const usdcAddress = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

function databaseUrlForSchema(schema: string) {
  const url = new URL(testDatabaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function applyMigrations(client: pg.Client) {
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
  }
}

async function withDisposableSchema(context: TestContext, run: (client: pg.Client) => Promise<void>) {
  if (!testDatabaseUrl) {
    context.skip();
    return;
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

  const schema = `withdrawal_cancellation_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await applyMigrations(client);
    await seedOpenFinancialGate(client);
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

async function seedOpenFinancialGate(client: pg.Client) {
  await client.query(
    `
      INSERT INTO treasury_config (chain_id, currency, treasury_address, usdc_contract_address, required_confirmations, active)
      VALUES ($1, 'USDC', $2, $3, 12, true)
    `,
    [chainId, treasuryAddress, usdcAddress]
  );
  await client.query(
    `
      INSERT INTO financial_reconciliation_snapshots (
        chain_id, currency, treasury_assets_micro_units, internal_custody_micro_units,
        user_available_micro_units, user_claimable_micro_units, user_checkout_micro_units,
        open_stake_micro_units, open_reserve_micro_units, pending_withdrawal_micro_units,
        house_equity_micro_units, unexplained_delta_micro_units, launch_gate, operation_gate,
        gate_reasons, treasury_assets, source, observed_block_number, observed_block_hash,
        scope_treasury_address, scope_token_address
      )
      VALUES (
        $1, 'USDC', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'ready', 'open',
        '[]'::jsonb,
        jsonb_build_array(jsonb_build_object(
          'source', 'onchain', 'chainId', $1::integer, 'treasuryAddress', $2::text,
          'tokenAddress', $3::text, 'blockNumber', '1', 'blockHash', $4::text
        )),
        'worker', 1, $4, $2, $3
      )
    `,
    [chainId, treasuryAddress, usdcAddress, `0x${"a".repeat(64)}`]
  );
}

async function seedWithdrawalUser(client: pg.Client, amountMicroUnits: bigint) {
  const userId = randomUUID();
  const walletAddress = `0x${`${randomUUID()}${randomUUID()}`.replaceAll("-", "").slice(0, 40)}`;
  const availableAccountId = randomUUID();
  const offsetAccountId = randomUUID();
  const openingBalance = amountMicroUnits + 77n;

  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  await client.query(
    "INSERT INTO user_wallets (user_id, address, chain_id, active) VALUES ($1, $2, $3, true)",
    [userId, walletAddress, chainId]
  );
  await client.query(
    `
      INSERT INTO ledger_accounts (id, user_id, account_type, currency)
      VALUES ($1, $2, 'user_usdc_available', 'USDC'), ($3, NULL, 'withdrawal_test_offset', 'USDC')
    `,
    [availableAccountId, userId, offsetAccountId]
  );
  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES ($1, $2, $3, 'USDC', 'withdrawal cancellation test funding'),
             ($1, $4, $5, 'USDC', 'withdrawal cancellation test funding')
    `,
    [randomUUID(), availableAccountId, openingBalance.toString(), offsetAccountId, (-openingBalance).toString()]
  );

  return { availableAccountId, openingBalance, userId, walletAddress };
}

async function accountBalance(client: pg.Client, accountId: string) {
  const result = await client.query<{ balance: string }>(
    "SELECT COALESCE(sum(amount_micro_units), 0)::text AS balance FROM ledger_entries WHERE account_id = $1",
    [accountId]
  );
  return BigInt(result.rows[0]?.balance || "0");
}

async function pendingBalance(client: pg.Client) {
  const result = await client.query<{ balance: string }>(
    `
      SELECT COALESCE(sum(entries.amount_micro_units), 0)::text AS balance
      FROM ledger_entries entries
      JOIN ledger_accounts accounts ON accounts.id = entries.account_id
      WHERE accounts.user_id IS NULL
        AND accounts.account_type = 'pending_usdc_withdrawals'
        AND accounts.currency = 'USDC'
    `
  );
  return BigInt(result.rows[0]?.balance || "0");
}

afterEach(async () => {
  await closePool();
  config.DATABASE_URL = originalDatabaseUrl;
});

postgresDescribe("withdrawal cancellation PostgreSQL integration", () => {
  it("returns an owned requested withdrawal exactly once and rejects another user", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const amountMicroUnits = 9007199254740993n;
      const owner = await seedWithdrawalUser(client, amountMicroUnits);
      const withdrawal = await createWithdrawalRequest({
        userId: owner.userId,
        destinationAddress: owner.walletAddress,
        amountMicroUnits,
        chainId,
        idempotencyKey: "cancel-requested-001"
      });
      const otherUserId = randomUUID();
      await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [otherUserId, `${otherUserId}@example.test`]);

      expect(await accountBalance(client, owner.availableAccountId)).toBe(77n);
      expect(await pendingBalance(client)).toBe(amountMicroUnits);
      await expect(
        cancelWithdrawalRequest({
          withdrawalRequestId: withdrawal.id,
          actor: "user",
          userId: otherUserId
        })
      ).rejects.toThrow("withdrawal_not_owned");
      expect(await accountBalance(client, owner.availableAccountId)).toBe(77n);
      expect(await pendingBalance(client)).toBe(amountMicroUnits);

      const canceled = await cancelWithdrawalRequest({
        withdrawalRequestId: withdrawal.id,
        actor: "user",
        userId: owner.userId
      });
      const replay = await cancelWithdrawalRequest({
        withdrawalRequestId: withdrawal.id,
        actor: "user",
        userId: owner.userId
      });

      expect(canceled).toMatchObject({ id: withdrawal.id, status: "canceled", result: "canceled" });
      expect(replay).toEqual({
        id: withdrawal.id,
        status: "canceled",
        completionTransactionId: canceled.completionTransactionId,
        result: "already_canceled"
      });
      expect(await accountBalance(client, owner.availableAccountId)).toBe(owner.openingBalance);
      expect(await pendingBalance(client)).toBe(0n);

      const cancellationEntries = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger_entries WHERE memo = 'withdrawal canceled'"
      );
      expect(cancellationEntries.rows[0]?.count).toBe("2");
    });
  });

  it("does not reverse a proposed withdrawal without verifiable Safe execution state", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const owner = await seedWithdrawalUser(client, 1_000_000n);
      const withdrawal = await createWithdrawalRequest({
        userId: owner.userId,
        destinationAddress: owner.walletAddress,
        amountMicroUnits: 1_000_000n,
        chainId,
        idempotencyKey: "cancel-proposed-001"
      });
      const proposal = await buildAndPersistSafeWithdrawalProposal({
        withdrawalRequestId: withdrawal.id,
        operatorId: "operator-proposer"
      });
      const beforeCancellation = await client.query<{
        safe_proposal_payload: unknown;
        safe_proposal_hash: string;
        safe_proposed_at: Date;
        safe_proposed_by: string;
      }>(
        `
          SELECT safe_proposal_payload, safe_proposal_hash, safe_proposed_at, safe_proposed_by
          FROM withdrawal_requests
          WHERE id = $1
        `,
        [withdrawal.id]
      );

      await expect(
        cancelWithdrawalRequest({
          withdrawalRequestId: withdrawal.id,
          actor: "user",
          userId: owner.userId
        })
      ).rejects.toThrow("withdrawal_not_cancelable");

      const afterCancellation = await client.query<{
        status: string;
        safe_proposal_payload: unknown;
        safe_proposal_hash: string;
        safe_proposed_at: Date;
        safe_proposed_by: string;
      }>(
        `
          SELECT status, safe_proposal_payload, safe_proposal_hash, safe_proposed_at, safe_proposed_by
          FROM withdrawal_requests
          WHERE id = $1
        `,
        [withdrawal.id]
      );

      expect(beforeCancellation.rows[0]?.safe_proposal_hash).toBe(proposal.safeProposalHash);
      expect(afterCancellation.rows[0]).toMatchObject({
        status: "proposed",
        safe_proposal_hash: proposal.safeProposalHash,
        safe_proposed_by: "operator-proposer"
      });
      expect(afterCancellation.rows[0]?.safe_proposal_payload).toEqual(beforeCancellation.rows[0]?.safe_proposal_payload);
      expect(afterCancellation.rows[0]?.safe_proposal_hash).toBe(beforeCancellation.rows[0]?.safe_proposal_hash);
      expect(afterCancellation.rows[0]?.safe_proposed_at).toEqual(beforeCancellation.rows[0]?.safe_proposed_at);
      expect(await pendingBalance(client)).toBe(1_000_000n);
    });
  });
});
