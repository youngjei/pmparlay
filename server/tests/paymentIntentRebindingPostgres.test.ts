import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { config } from "../config";
import { closePool } from "../db/client";
import { creditConfirmedDeposit } from "../db/depositRepository";
import { submitQuotePaymentTransaction } from "../db/paymentIntentRepository";
import { createWithdrawalRequest } from "../db/withdrawalRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const originalDatabaseUrl = config.DATABASE_URL;
const chainId = 11155111;
const txHash = `0x${"a".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;
const walletAddress = "0x1234567890abcdef1234567890abcdef12345678";
const treasuryAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
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

  const schema = `payment_rebinding_${randomUUID().replaceAll("-", "")}`;
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
    [chainId, treasuryAddress, usdcAddress, `0x${"d".repeat(64)}`]
  );
}

async function accountBalance(client: pg.Client, accountType: string, userId?: string) {
  const result = await client.query<{ balance: string }>(
    `
      SELECT COALESCE(sum(entries.amount_micro_units), 0)::text AS balance
      FROM ledger_accounts accounts
      LEFT JOIN ledger_entries entries ON entries.account_id = accounts.id
      WHERE accounts.account_type = $1
        AND accounts.currency = 'USDC'
        AND accounts.user_id IS NOT DISTINCT FROM $2::uuid
    `,
    [accountType, userId || null]
  );
  return BigInt(result.rows[0]?.balance || "0");
}

async function seedPaymentRebindingScenario(client: pg.Client, input: { depositAmount: bigint; lateSubmission: boolean }) {
  const userId = randomUUID();
  const policyId = randomUUID();
  const quoteId = randomUUID();
  const paymentIntentId = randomUUID();
  const submissionDeadlineAt = new Date(Date.now() + (input.lateSubmission ? -60_000 : 15 * 60_000));
  const expiresAt = new Date(Date.now() + 15 * 60_000);

  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  await client.query(
    "INSERT INTO user_wallets (user_id, address, chain_id, active) VALUES ($1, $2, $3, true)",
    [userId, walletAddress, chainId]
  );
  await client.query(
    "INSERT INTO policy_versions (id, version, description, policy, active) VALUES ($1, $2, 'test', '{}'::jsonb, true)",
    [policyId, `payment-rebinding-${policyId}`]
  );
  await client.query(
    `
      INSERT INTO quotes (
        id, user_id, policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
        spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
      )
      VALUES ($1, $2, $3, 'quoted', 4000000, 1000000, 100, 5000, 8000000, $4)
    `,
    [quoteId, userId, policyId, expiresAt]
  );
  await client.query(
    `
      INSERT INTO quote_payment_intents (
        id, quote_id, user_id, chain_id, treasury_address, usdc_contract_address,
        amount_micro_units, required_confirmations, status, expires_at,
        submission_deadline_at, estimated_payout_micro_usd, min_final_payout_micro_usd
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 12, 'pending', $8, $9, 8000000, 7960000)
    `,
    [
      paymentIntentId,
      quoteId,
      userId,
      chainId,
      treasuryAddress,
      usdcAddress,
      input.depositAmount.toString(),
      expiresAt,
      submissionDeadlineAt
    ]
  );
  await client.query(
    `
      INSERT INTO quote_payment_exposure_reservations (
        payment_intent_id, quote_id, user_id, liability_micro_usd, status, expires_at
      )
      VALUES ($1, $2, $3, 3000000, 'reserved', $4)
    `,
    [paymentIntentId, quoteId, userId, expiresAt]
  );

  return { paymentIntentId, quoteId, userId };
}

afterEach(async () => {
  await closePool();
  config.DATABASE_URL = originalDatabaseUrl;
});

postgresDescribe("quote payment deposit rebinding PostgreSQL integration", () => {
  it("rebinds a generic confirmed deposit to checkout once and replays the submission idempotently", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const depositAmount = 5_000_000n;
      await seedOpenFinancialGate(client);
      const scenario = await seedPaymentRebindingScenario(client, { depositAmount, lateSubmission: false });

      const deposit = await creditConfirmedDeposit({
        chainId,
        txHash,
        logIndex: 0,
        blockNumber: 100n,
        blockHash,
        fromAddress: walletAddress,
        toAddress: treasuryAddress,
        tokenAddress: usdcAddress,
        amountMicroUnits: depositAmount,
        confirmations: 12,
        raw: { status: "0x1" }
      });
      expect(deposit.status).toBe("credited");
      expect(await accountBalance(client, "user_usdc_available", scenario.userId)).toBe(depositAmount);

      const submitted = await submitQuotePaymentTransaction({ quoteId: scenario.quoteId, userId: scenario.userId, txHash });
      const replay = await submitQuotePaymentTransaction({ quoteId: scenario.quoteId, userId: scenario.userId, txHash });

      expect(submitted).toMatchObject({ status: "confirmed", txHash });
      expect(replay).toMatchObject({ id: submitted.id, status: "confirmed", txHash });
      expect(await accountBalance(client, "user_usdc_available", scenario.userId)).toBe(0n);
      expect(await accountBalance(client, "user_usdc_checkout", scenario.userId)).toBe(depositAmount);

      const persisted = await client.query<{
        payment_intent_id: string | null;
        checkout_ledger_transaction_id: string | null;
        checkout_entries: string;
      }>(
        `
          SELECT
            deposits.payment_intent_id,
            intents.checkout_ledger_transaction_id,
            count(entries.id)::text AS checkout_entries
          FROM onchain_deposits deposits
          JOIN quote_payment_intents intents ON intents.id = $2
          LEFT JOIN ledger_entries entries
            ON entries.transaction_id = intents.checkout_ledger_transaction_id
          WHERE deposits.id = $1
          GROUP BY deposits.payment_intent_id, intents.checkout_ledger_transaction_id
        `,
        [deposit.id, scenario.paymentIntentId]
      );
      expect(persisted.rows[0]).toEqual({
        payment_intent_id: scenario.paymentIntentId,
        checkout_ledger_transaction_id: submitted.checkoutLedgerTransactionId,
        checkout_entries: "2"
      });
    });
  });

  it("does not rebind a generic credit spent by a withdrawal before late hash submission", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const depositAmount = 5_000_000n;
      const withdrawalAmount = 4_000_000n;

      await seedOpenFinancialGate(client);
      const scenario = await seedPaymentRebindingScenario(client, { depositAmount, lateSubmission: true });

      const deposit = await creditConfirmedDeposit({
        chainId,
        txHash,
        logIndex: 0,
        blockNumber: 100n,
        blockHash,
        fromAddress: walletAddress,
        toAddress: treasuryAddress,
        tokenAddress: usdcAddress,
        amountMicroUnits: depositAmount,
        confirmations: 12,
        raw: { status: "0x1" }
      });
      expect(deposit.status).toBe("credited");

      await createWithdrawalRequest({
        userId: scenario.userId,
        destinationAddress: walletAddress,
        amountMicroUnits: withdrawalAmount,
        chainId,
        idempotencyKey: "payment-rebinding-withdrawal"
      });
      expect(await accountBalance(client, "user_usdc_available", scenario.userId)).toBe(1_000_000n);

      const submitted = await submitQuotePaymentTransaction({ quoteId: scenario.quoteId, userId: scenario.userId, txHash });
      const replay = await submitQuotePaymentTransaction({ quoteId: scenario.quoteId, userId: scenario.userId, txHash });

      expect(submitted).toMatchObject({ status: "recoverable", recoveryReason: "late_submission", txHash });
      expect(replay).toMatchObject({
        id: submitted.id,
        status: "recoverable",
        recoveryReason: "late_submission",
        txHash
      });
      expect(await accountBalance(client, "user_usdc_available", scenario.userId)).toBe(1_000_000n);
      expect(await accountBalance(client, "user_usdc_checkout", scenario.userId)).toBe(0n);
      expect(await accountBalance(client, "pending_usdc_withdrawals")).toBe(withdrawalAmount);

      const persisted = await client.query<{
        payment_intent_id: string | null;
        checkout_ledger_transaction_id: string | null;
        reservation_status: string;
      }>(
        `
          SELECT
            deposits.payment_intent_id,
            intents.checkout_ledger_transaction_id,
            reservations.status AS reservation_status
          FROM onchain_deposits deposits
          JOIN quote_payment_intents intents ON intents.id = $2
          JOIN quote_payment_exposure_reservations reservations ON reservations.payment_intent_id = intents.id
          WHERE deposits.id = $1
        `,
        [deposit.id, scenario.paymentIntentId]
      );
      expect(persisted.rows[0]).toEqual({
        payment_intent_id: null,
        checkout_ledger_transaction_id: null,
        reservation_status: "released"
      });
    });
  });

  it("serializes late deposit rebinding with a withdrawal without a negative or duplicate fund disposition", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const depositAmount = 5_000_000n;
      const withdrawalAmount = 4_000_000n;
      await seedOpenFinancialGate(client);
      const scenario = await seedPaymentRebindingScenario(client, { depositAmount, lateSubmission: true });

      const deposit = await creditConfirmedDeposit({
        chainId,
        txHash,
        logIndex: 0,
        blockNumber: 100n,
        blockHash,
        fromAddress: walletAddress,
        toAddress: treasuryAddress,
        tokenAddress: usdcAddress,
        amountMicroUnits: depositAmount,
        confirmations: 12,
        raw: { status: "0x1" }
      });
      expect(deposit.status).toBe("credited");

      const lockClient = new pg.Client({ connectionString: config.DATABASE_URL });
      await lockClient.connect();
      try {
        await lockClient.query("BEGIN");
        await lockClient.query(
          `
            SELECT id
            FROM ledger_accounts
            WHERE user_id = $1
              AND account_type = 'user_usdc_available'
              AND currency = 'USDC'
            FOR UPDATE
          `,
          [scenario.userId]
        );

        const rebinding = submitQuotePaymentTransaction({ quoteId: scenario.quoteId, userId: scenario.userId, txHash });
        const withdrawal = createWithdrawalRequest({
          userId: scenario.userId,
          destinationAddress: walletAddress,
          amountMicroUnits: withdrawalAmount,
          chainId,
          idempotencyKey: "payment-rebinding-concurrent-withdrawal"
        });

        // Both mutations must pass through the same available-balance row after this release.
        await lockClient.query("COMMIT");
        const [rebindingResult, withdrawalResult] = await Promise.all([rebinding, withdrawal]);

        expect(rebindingResult).toMatchObject({ status: "recoverable", recoveryReason: "late_submission", txHash });
        expect(withdrawalResult).toMatchObject({ status: "requested" });
      } finally {
        await lockClient.query("ROLLBACK");
        await lockClient.end();
      }

      expect(await accountBalance(client, "user_usdc_available", scenario.userId)).toBe(depositAmount - withdrawalAmount);
      expect(await accountBalance(client, "user_usdc_checkout", scenario.userId)).toBe(0n);
      expect(await accountBalance(client, "pending_usdc_withdrawals")).toBe(withdrawalAmount);

      const disposition = await client.query<{
        payment_intent_id: string | null;
        withdrawal_count: string;
        negative_user_balances: string;
        checkout_hold_entries: string;
        recovery_release_entries: string;
      }>(
        `
          SELECT
            (SELECT payment_intent_id FROM onchain_deposits WHERE id = $1) AS payment_intent_id,
            (SELECT count(*)::text FROM withdrawal_requests WHERE user_id = $2) AS withdrawal_count,
            (
              SELECT count(*)::text
              FROM (
                SELECT COALESCE(sum(entries.amount_micro_units), 0) AS balance
                FROM ledger_accounts accounts
                LEFT JOIN ledger_entries entries ON entries.account_id = accounts.id
                WHERE accounts.user_id = $2
                  AND accounts.account_type IN ('user_usdc_available', 'user_usdc_checkout')
                  AND accounts.currency = 'USDC'
                GROUP BY accounts.id
              ) balances
              WHERE balance < 0
            ) AS negative_user_balances,
            (SELECT count(*)::text FROM ledger_entries WHERE memo = 'quote payment held for checkout') AS checkout_hold_entries,
            (
              SELECT count(*)::text
              FROM ledger_entries
              WHERE memo = 'quote payment released from checkout for recovery'
            ) AS recovery_release_entries
        `,
        [deposit.id, scenario.userId]
      );
      const persisted = disposition.rows[0];
      expect(persisted).toMatchObject({ withdrawal_count: "1", negative_user_balances: "0" });
      expect([null, scenario.paymentIntentId]).toContain(persisted.payment_intent_id);
      expect(persisted.checkout_hold_entries).toBe(persisted.payment_intent_id ? "2" : "0");
      expect(persisted.recovery_release_entries).toBe(persisted.payment_intent_id ? "2" : "0");
    });
  });
});
