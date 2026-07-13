import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import { getPool } from "./client";

const paymentHoldMs = 20 * 60 * 1000;

type PaymentIntentStatus = "pending" | "submitted" | "confirmed" | "activated" | "expired" | "failed";

export type TreasuryPaymentConfig = {
  chainId: number;
  treasuryAddress: string;
  usdcContractAddress: string;
  requiredConfirmations: number;
};

export type QuotePaymentIntent = {
  id: string;
  quoteId: string;
  userId: string;
  chainId: number;
  currency: "USDC";
  treasuryAddress: string;
  usdcContractAddress: string;
  amountMicroUnits: string;
  amountUsdc: number;
  requiredConfirmations: number;
  status: PaymentIntentStatus;
  txHash?: string;
  ticketId?: string;
  expiresAt: string;
  submittedAt?: string;
  confirmedAt?: string;
  activatedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ConfirmedQuotePaymentClaim = {
  paymentIntentId: string;
  quoteId: string;
  userId: string;
  ledgerTransactionId: string;
};

export type PendingQuotePaymentSummary = {
  id: string;
  quoteId: string;
  status: Extract<PaymentIntentStatus, "submitted" | "confirmed">;
  txHash?: string;
  chainId: number;
  amountPaidUsd: number;
  potentialPayoutUsd: number;
  legs: number;
  createdAt: string;
  updatedAt: string;
};

type QuotePaymentIntentRow = {
  id: string;
  quote_id: string;
  user_id: string;
  chain_id: number;
  currency: "USDC";
  treasury_address: string;
  usdc_contract_address: string;
  amount_micro_units: string;
  required_confirmations: number;
  status: PaymentIntentStatus;
  tx_hash: string | null;
  ticket_id: string | null;
  expires_at: Date;
  submitted_at: Date | null;
  confirmed_at: Date | null;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ExistingDepositPaymentClaim = {
  paymentIntentId: string;
  quoteId: string;
  userId: string;
  ledgerTransactionId: string;
};

function normalizeAddress(value: string) {
  if (!isAddress(value)) throw new Error("invalid_evm_address");
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error("invalid_evm_address");
  return address.toLowerCase();
}

function normalizeTxHash(value: string) {
  const txHash = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) {
    throw new Error("invalid_tx_hash");
  }
  return txHash;
}

function amountUsdc(value: string | number | bigint) {
  return Number(value) / 1_000_000;
}

function rowToIntent(row: QuotePaymentIntentRow): QuotePaymentIntent {
  return {
    id: row.id,
    quoteId: row.quote_id,
    userId: row.user_id,
    chainId: row.chain_id,
    currency: row.currency,
    treasuryAddress: getAddress(row.treasury_address),
    usdcContractAddress: getAddress(row.usdc_contract_address),
    amountMicroUnits: row.amount_micro_units,
    amountUsdc: amountUsdc(row.amount_micro_units),
    requiredConfirmations: row.required_confirmations,
    status: row.status,
    txHash: row.tx_hash || undefined,
    ticketId: row.ticket_id || undefined,
    expiresAt: row.expires_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString(),
    activatedAt: row.activated_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

async function ensureLedgerAccount(client: pg.PoolClient, userId: string | null, accountType: string, currency: "USDC") {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO ledger_accounts (user_id, account_type, currency)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [userId, accountType, currency]
  );
  if (result.rows[0]) return result.rows[0].id;

  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM ledger_accounts
      WHERE user_id IS NOT DISTINCT FROM $1
        AND account_type = $2
        AND currency = $3
      LIMIT 1
    `,
    [userId, accountType, currency]
  );
  if (!existing.rows[0]) throw new Error(`Unable to create ledger account ${accountType}:USDC`);
  return existing.rows[0].id;
}

export async function createQuotePaymentIntent(input: {
  quoteId: string;
  userId: string;
  treasuryConfig: TreasuryPaymentConfig;
  holdMs?: number;
}): Promise<QuotePaymentIntent> {
  const treasuryAddress = normalizeAddress(input.treasuryConfig.treasuryAddress);
  const usdcContractAddress = normalizeAddress(input.treasuryConfig.usdcContractAddress);
  const expiresAt = new Date(Date.now() + (input.holdMs || paymentHoldMs));
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const quoteResult = await client.query<{
      id: string;
      user_id: string | null;
      status: "quoted" | "accepted" | "expired" | "rejected";
      risk_decision: "accept" | "review" | "reject";
      stake_micro_usd: string;
      operation_fee_micro_usd: string;
      expires_at: Date;
    }>(
      `
        SELECT id, user_id, status, risk_decision, stake_micro_usd::text, operation_fee_micro_usd::text, expires_at
        FROM quotes
        WHERE id = $1
          AND ($2::uuid IS NULL OR user_id = $2)
        FOR UPDATE
      `,
      [input.quoteId, input.userId]
    );
    const quote = quoteResult.rows[0];
    if (!quote) throw new Error("quote_not_found");
    if (quote.user_id && quote.user_id !== input.userId) throw new Error("quote_not_found");
    if (quote.status !== "quoted") throw new Error(`quote_not_payable:${quote.status}`);
    if (quote.risk_decision !== "accept") throw new Error(`quote_requires_review:${quote.risk_decision}`);
    if (quote.expires_at.getTime() <= Date.now()) {
      await client.query("UPDATE quotes SET status = 'expired' WHERE id = $1", [quote.id]);
      await client.query("COMMIT");
      committed = true;
      throw new Error("quote_expired");
    }

    const existingIntent = await client.query<QuotePaymentIntentRow & { isExpired: boolean }>(
      `
        SELECT *, expires_at <= now() AS "isExpired"
        FROM quote_payment_intents
        WHERE quote_id = $1
        FOR UPDATE
      `,
      [quote.id]
    );
    const intent = existingIntent.rows[0];
    if (intent?.isExpired && (intent.status === "pending" || intent.status === "submitted")) {
      await client.query(
        `
          UPDATE quote_payment_intents
          SET status = 'expired', updated_at = now()
          WHERE id = $1
            AND status = 'pending'
        `,
        [intent.id]
      );
      await client.query("COMMIT");
      committed = true;
      throw new Error("payment_intent_expired");
    }

    const amountDue = BigInt(quote.stake_micro_usd) + BigInt(quote.operation_fee_micro_usd);
    await client.query("UPDATE quotes SET user_id = $2 WHERE id = $1", [quote.id, input.userId]);
    const intentResult = await client.query(
      `
        INSERT INTO quote_payment_intents (
          quote_id,
          user_id,
          chain_id,
          currency,
          treasury_address,
          usdc_contract_address,
          amount_micro_units,
          required_confirmations,
          status,
          expires_at
        )
        VALUES ($1, $2, $3, 'USDC', $4, $5, $6, $7, 'pending', $8)
        ON CONFLICT (quote_id)
        DO UPDATE SET
          expires_at = CASE
            WHEN quote_payment_intents.status IN ('pending', 'submitted') AND quote_payment_intents.expires_at > now()
              THEN quote_payment_intents.expires_at
            ELSE quote_payment_intents.expires_at
          END,
          updated_at = now()
        RETURNING *
      `,
      [
        quote.id,
        input.userId,
        input.treasuryConfig.chainId,
        treasuryAddress,
        usdcContractAddress,
        amountDue.toString(),
        input.treasuryConfig.requiredConfirmations,
        expiresAt
      ]
    );
    await client.query("COMMIT");
    committed = true;
    return rowToIntent(intentResult.rows[0]);
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getQuotePaymentIntent(quoteId: string, userId: string): Promise<QuotePaymentIntent | undefined> {
  const result = await getPool().query(
    `
      SELECT *
      FROM quote_payment_intents
      WHERE quote_id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [quoteId, userId]
  );
  return result.rows[0] ? rowToIntent(result.rows[0]) : undefined;
}

export async function listPendingQuotePayments(userId: string): Promise<PendingQuotePaymentSummary[]> {
  const result = await getPool().query<{
    id: string;
    quoteId: string;
    status: Extract<PaymentIntentStatus, "submitted" | "confirmed">;
    txHash: string | null;
    chainId: number;
    amountMicroUnits: string;
    potentialPayoutMicroUsd: string;
    legs: string;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `
      SELECT
        quote_payment_intents.id,
        quote_payment_intents.quote_id AS "quoteId",
        quote_payment_intents.status,
        quote_payment_intents.tx_hash AS "txHash",
        quote_payment_intents.chain_id AS "chainId",
        quote_payment_intents.amount_micro_units::text AS "amountMicroUnits",
        quotes.offered_payout_micro_usd::text AS "potentialPayoutMicroUsd",
        count(quote_legs.id)::text AS legs,
        quote_payment_intents.created_at AS "createdAt",
        quote_payment_intents.updated_at AS "updatedAt"
      FROM quote_payment_intents
      JOIN quotes ON quotes.id = quote_payment_intents.quote_id
      LEFT JOIN quote_legs ON quote_legs.quote_id = quotes.id
      WHERE quote_payment_intents.user_id = $1
        AND (
          quote_payment_intents.status = 'submitted'
          OR quote_payment_intents.status = 'confirmed'
        )
        AND quote_payment_intents.ticket_id IS NULL
      GROUP BY quote_payment_intents.id, quotes.id
      ORDER BY quote_payment_intents.updated_at DESC
      LIMIT 20
    `,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    quoteId: row.quoteId,
    status: row.status,
    txHash: row.txHash || undefined,
    chainId: row.chainId,
    amountPaidUsd: amountUsdc(row.amountMicroUnits),
    potentialPayoutUsd: amountUsdc(row.potentialPayoutMicroUsd),
    legs: Number(row.legs),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }));
}

export async function submitQuotePaymentTransaction(input: { quoteId: string; userId: string; txHash: string }): Promise<QuotePaymentIntent> {
  const txHash = normalizeTxHash(input.txHash);
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const existing = await client.query<QuotePaymentIntentRow & { isExpired: boolean }>(
      `
        SELECT *, expires_at <= now() AS "isExpired"
        FROM quote_payment_intents
        WHERE quote_id = $1
          AND user_id = $2
        FOR UPDATE
      `,
      [input.quoteId, input.userId]
    );
    const intent = existing.rows[0];
    if (!intent) throw new Error("payment_intent_not_found");

    if (intent.status === "pending" && intent.isExpired) {
      await client.query(
        `
          UPDATE quote_payment_intents
          SET status = 'expired', updated_at = now()
          WHERE id = $1
            AND status IN ('pending', 'submitted')
        `,
        [intent.id]
      );
      await client.query("COMMIT");
      committed = true;
      throw new Error("payment_intent_expired");
    }

    if (intent.status !== "pending" && intent.status !== "submitted") {
      throw new Error("payment_intent_not_submittable");
    }

    const txConflict = await client.query<{ id: string }>(
      `
        SELECT id
        FROM quote_payment_intents
        WHERE chain_id = $1
          AND tx_hash = $2
          AND id <> $3
          AND status IN ('pending', 'submitted', 'confirmed', 'activated')
        LIMIT 1
        FOR UPDATE
      `,
      [intent.chain_id, txHash, intent.id]
    );
    if (txConflict.rows[0]) {
      throw new Error("payment_intent_tx_hash_conflict");
    }

    if (intent.status === "submitted") {
      if (intent.tx_hash && intent.tx_hash !== txHash) {
        throw new Error("payment_intent_tx_hash_conflict");
      }
      if (intent.tx_hash === txHash) {
        await client.query("COMMIT");
        committed = true;
        return rowToIntent(intent);
      }
      if (intent.isExpired) {
        throw new Error("payment_intent_expired");
      }
    }

    const result = await client.query<QuotePaymentIntentRow>(
      `
        UPDATE quote_payment_intents
        SET
          tx_hash = $3,
          status = 'submitted',
          submitted_at = COALESCE(submitted_at, now()),
          updated_at = now()
        WHERE id = $1
          AND user_id = $2
          AND status IN ('pending', 'submitted')
          AND expires_at > now()
        RETURNING *
      `,
      [intent.id, input.userId, txHash]
    );
    if (!result.rows[0]) throw new Error("payment_intent_expired");
    await reconcileExistingConfirmedDeposit(client, result.rows[0]);
    await client.query("COMMIT");
    committed = true;
    const refreshed = await getIntentById(client, result.rows[0].id);
    return rowToIntent(refreshed || result.rows[0]);
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getIntentById(client: pg.PoolClient, intentId: string): Promise<QuotePaymentIntentRow | undefined> {
  const result = await client.query<QuotePaymentIntentRow>(
    `
      SELECT *
      FROM quote_payment_intents
      WHERE id = $1
      LIMIT 1
    `,
    [intentId]
  );
  return result.rows[0];
}

async function reconcileExistingConfirmedDeposit(client: pg.PoolClient, intent: QuotePaymentIntentRow): Promise<ExistingDepositPaymentClaim | undefined> {
  if (!intent.tx_hash) return undefined;

  const depositResult = await client.query<{
    id: string;
    credited_transaction_id: string | null;
  }>(
    `
      SELECT onchain_deposits.id, onchain_deposits.credited_transaction_id
      FROM onchain_deposits
      WHERE onchain_deposits.chain_id = $1
        AND onchain_deposits.tx_hash = $2
        AND onchain_deposits.to_address = $3
        AND onchain_deposits.token_address = $4
        AND onchain_deposits.amount_micro_units = $5
        AND onchain_deposits.user_id = $6
        AND onchain_deposits.status = 'credited'
        AND onchain_deposits.payment_intent_id IS NULL
      ORDER BY onchain_deposits.log_index ASC
      LIMIT 1
      FOR UPDATE
    `,
    [intent.chain_id, intent.tx_hash, intent.treasury_address, intent.usdc_contract_address, intent.amount_micro_units, intent.user_id]
  );
  const deposit = depositResult.rows[0];
  if (!deposit?.credited_transaction_id) return undefined;

  await client.query(
    `
      UPDATE onchain_deposits
      SET payment_intent_id = $2, updated_at = now()
      WHERE id = $1
    `,
    [deposit.id, intent.id]
  );
  await client.query(
    `
      UPDATE quote_payment_intents
      SET
        status = 'confirmed',
        onchain_deposit_id = $2,
        confirmed_at = COALESCE(confirmed_at, now()),
        updated_at = now()
      WHERE id = $1
        AND status = 'submitted'
    `,
    [intent.id, deposit.id]
  );
  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'payment.reconciled', 'quote_payment_intent', $2, $3)
    `,
    [
      intent.user_id,
      intent.id,
      {
        quoteId: intent.quote_id,
        chainId: intent.chain_id,
        txHash: intent.tx_hash,
        depositId: deposit.id,
        ledgerTransactionId: deposit.credited_transaction_id
      }
    ]
  );

  return {
    paymentIntentId: intent.id,
    quoteId: intent.quote_id,
    userId: intent.user_id,
    ledgerTransactionId: deposit.credited_transaction_id
  };
}

export async function markQuotePaymentActivated(input: { quoteId: string; userId: string; ticketId: string }) {
  const result = await getPool().query(
    `
      UPDATE quote_payment_intents
      SET
        status = 'activated',
        ticket_id = $3,
        activated_at = COALESCE(activated_at, now()),
        updated_at = now()
      WHERE quote_id = $1
        AND user_id = $2
        AND status IN ('confirmed', 'activated')
      RETURNING *
    `,
    [input.quoteId, input.userId, input.ticketId]
  );
  if (!result.rows[0]) throw new Error("payment_intent_not_confirmed");
  return rowToIntent(result.rows[0]);
}

export async function markQuotePaymentFailed(input: { quoteId: string; userId: string; reason: string }) {
  const result = await getPool().query(
    `
      UPDATE quote_payment_intents
      SET
        status = 'failed',
        updated_at = now()
      WHERE quote_id = $1
        AND user_id = $2
        AND status IN ('submitted', 'confirmed')
      RETURNING *
    `,
    [input.quoteId, input.userId]
  );

  if (result.rows[0]) {
    await getPool().query(
      `
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'payment.activation_failed', 'quote_payment_intent', $2, $3)
      `,
      [
        input.userId,
        result.rows[0].id,
        {
          quoteId: input.quoteId,
          reason: input.reason
        }
      ]
    );
    return rowToIntent(result.rows[0]);
  }

  return undefined;
}

export async function claimConfirmedQuotePaymentDeposit(
  client: pg.PoolClient,
  input: {
    chainId: number;
    txHash: string;
    depositId: string;
    userId: string;
    walletId: string;
    fromAddress: string;
    toAddress: string;
    tokenAddress: string;
    amountMicroUnits: bigint;
    confirmations: number;
  }
): Promise<ConfirmedQuotePaymentClaim | undefined> {
  const txHash = normalizeTxHash(input.txHash);
  const toAddress = normalizeAddress(input.toAddress);
  const tokenAddress = normalizeAddress(input.tokenAddress);
  const result = await client.query<{
    id: string;
    quote_id: string;
    user_id: string;
  }>(
    `
      SELECT id, quote_id, user_id
      FROM quote_payment_intents
      WHERE user_id = $1
        AND chain_id = $2
        AND treasury_address = $3
        AND usdc_contract_address = $4
        AND amount_micro_units = $5
        AND status = 'submitted'
        AND tx_hash = $6
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `,
    [input.userId, input.chainId, toAddress, tokenAddress, input.amountMicroUnits.toString(), txHash]
  );
  const intent = result.rows[0];
  if (!intent) return undefined;

  const transactionId = randomUUID();
  const userAccountId = await ensureLedgerAccount(client, intent.user_id, "user_usdc_available", "USDC");
  const clearingAccountId = await ensureLedgerAccount(client, null, "external_usdc_deposits", "USDC");
  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES
        ($1, $2, $3, 'USDC', 'quote payment credited'),
        ($1, $4, $5, 'USDC', 'quote payment credited')
    `,
    [transactionId, userAccountId, input.amountMicroUnits.toString(), clearingAccountId, (-input.amountMicroUnits).toString()]
  );
  await client.query(
    `
      UPDATE quote_payment_intents
      SET
        status = 'confirmed',
        tx_hash = $2,
        onchain_deposit_id = $3,
        confirmed_at = now(),
        updated_at = now()
      WHERE id = $1
    `,
    [intent.id, txHash, input.depositId]
  );
  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'payment.confirmed', 'quote_payment_intent', $2, $3)
    `,
    [
      intent.user_id,
      intent.id,
      {
        quoteId: intent.quote_id,
        chainId: input.chainId,
        txHash,
        depositId: input.depositId,
        walletId: input.walletId,
        amountMicroUnits: input.amountMicroUnits.toString(),
        confirmations: input.confirmations,
        ledgerTransactionId: transactionId
      }
    ]
  );

  return {
    paymentIntentId: intent.id,
    quoteId: intent.quote_id,
    userId: intent.user_id,
    ledgerTransactionId: transactionId
  };
}
