import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import { DEFAULT_RISK_POLICY } from "../../packages/domain/src/riskEngine";
import { config } from "../config";
import { assertFinancialGateOpenInTransaction } from "../financialGate";
import type { QuoteResponse } from "../quoteService";
import { getPool } from "./client";
import { acceptQuoteInTransaction, type AcceptedTicket, type AcceptQuoteOptions } from "./ticketRepository";
import { assertWorkerHeartbeatsHealthyInTransaction } from "./workerHeartbeatRepository";

export const paymentRequestSubmissionDeadlineMs = 3 * 60 * 1000;
export const submittedTxTrackingMs = 15 * 60 * 1000;
export const paymentActivationLeaseMs = 60 * 1000;
export const confirmedPaymentActivationDeadlineMs = 5 * 60 * 1000;
export const defaultMaxAdverseBps = 50;

export type PaymentIntentStatus = "pending" | "submitted" | "confirmed" | "activating" | "activated" | "expired" | "failed" | "recoverable";

export type PaymentRecoveryReason =
  | "late_submission"
  | "late_confirmation"
  | "underpayment"
  | "requote_adverse"
  | "market_closed"
  | "stale_book"
  | "insufficient_depth"
  | "risk_review"
  | "risk_rejected"
  | "exposure_limit"
  | "quote_not_found"
  | "activation_failed";

type PaymentExposureLimits = {
  maxUserLiabilityUsd?: number;
  maxMarketLiabilityUsd: number;
  maxEventLiabilityUsd: number;
};

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
  submissionDeadlineAt?: string;
  trackingDeadlineAt?: string;
  maxAdverseBps?: number;
  estimatedPayoutMicroUsd?: string;
  minFinalPayoutMicroUsd?: string;
  finalPayoutMicroUsd?: string;
  finalQuoteId?: string;
  amountReceivedMicroUnits?: string;
  surplusMicroUnits?: string;
  checkoutLedgerTransactionId?: string;
  recoveryReleaseTransactionId?: string;
  surplusReleaseTransactionId?: string;
  activationFundingTransactionId?: string;
  activationDeadlineAt?: string;
  activationClaimToken?: string;
  activationClaimedAt?: string;
  activationLeaseExpiresAt?: string;
  recoveryReason?: PaymentRecoveryReason;
  recoveryDetail?: string;
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
  status: Extract<PaymentIntentStatus, "submitted" | "confirmed" | "recoverable">;
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
  submission_deadline_at?: Date;
  tracking_deadline_at?: Date | null;
  max_adverse_bps?: number;
  estimated_payout_micro_usd?: string;
  min_final_payout_micro_usd?: string;
  final_payout_micro_usd?: string | null;
  final_quote_id?: string | null;
  amount_received_micro_units?: string;
  surplus_micro_units?: string;
  checkout_ledger_transaction_id?: string | null;
  recovery_release_transaction_id?: string | null;
  surplus_release_transaction_id?: string | null;
  activation_funding_transaction_id?: string | null;
  activation_deadline_at?: Date | null;
  activation_claim_token?: string | null;
  activation_claimed_at?: Date | null;
  activation_lease_expires_at?: Date | null;
  recovery_reason?: PaymentRecoveryReason | null;
  recovery_detail?: string | null;
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

function minFinalPayoutMicroUsd(estimatedPayoutMicroUsd: string | number | bigint, maxAdverseBps = defaultMaxAdverseBps) {
  const estimated = BigInt(estimatedPayoutMicroUsd);
  const adverseBps = BigInt(maxAdverseBps);
  return ((estimated * (10_000n - adverseBps)) + 9_999n) / 10_000n;
}

function microUsd(value: number) {
  return Math.round(value * 1_000_000);
}

function bps(value: number) {
  return Math.round(value * 10_000);
}

function usdLimitToMicroUsd(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_payment_exposure_limit");
  const [whole, fraction = ""] = value.toFixed(6).split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function paymentExposureExceedsLimit(input: {
  currentMicroUsd: bigint;
  incrementalMicroUsd: bigint;
  limitMicroUsd: bigint;
}) {
  return input.currentMicroUsd + input.incrementalMicroUsd > input.limitMicroUsd;
}

function defaultExposureLimits(): PaymentExposureLimits {
  return {
    maxUserLiabilityUsd: config.MAX_USER_LIABILITY_USD,
    maxMarketLiabilityUsd: config.MAX_MARKET_LIABILITY_USD,
    maxEventLiabilityUsd: config.MAX_EVENT_LIABILITY_USD
  };
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
    submissionDeadlineAt: row.submission_deadline_at?.toISOString(),
    trackingDeadlineAt: row.tracking_deadline_at?.toISOString(),
    maxAdverseBps: row.max_adverse_bps,
    estimatedPayoutMicroUsd: row.estimated_payout_micro_usd,
    minFinalPayoutMicroUsd: row.min_final_payout_micro_usd,
    finalPayoutMicroUsd: row.final_payout_micro_usd || undefined,
    finalQuoteId: row.final_quote_id || undefined,
    amountReceivedMicroUnits: row.amount_received_micro_units,
    surplusMicroUnits: row.surplus_micro_units,
    checkoutLedgerTransactionId: row.checkout_ledger_transaction_id || undefined,
    recoveryReleaseTransactionId: row.recovery_release_transaction_id || undefined,
    surplusReleaseTransactionId: row.surplus_release_transaction_id || undefined,
    activationFundingTransactionId: row.activation_funding_transaction_id || undefined,
    activationDeadlineAt: row.activation_deadline_at?.toISOString(),
    activationClaimToken: row.activation_claim_token || undefined,
    activationClaimedAt: row.activation_claimed_at?.toISOString(),
    activationLeaseExpiresAt: row.activation_lease_expires_at?.toISOString(),
    recoveryReason: row.recovery_reason || undefined,
    recoveryDetail: row.recovery_detail || undefined,
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

async function quoteExposureLegs(client: pg.PoolClient, quoteId: string) {
  const result = await client.query<{
    source_market_id: string;
    outcome: string;
    market_url: string;
  }>(
    `
      SELECT markets.source_market_id, quote_legs.outcome, markets.market_url
      FROM quote_legs
      JOIN markets ON markets.id = quote_legs.market_id
      WHERE quote_legs.quote_id = $1
      ORDER BY markets.source_market_id, quote_legs.outcome
    `,
    [quoteId]
  );
  return result.rows;
}

async function lockQuoteExposureKeys(client: pg.PoolClient, quoteId: string, userId: string) {
  const legs = await quoteExposureLegs(client, quoteId);
  const lockKeys = [
    ...new Set([
      `user:${userId}`,
      ...legs.map((leg) => `market:${leg.source_market_id}:${leg.outcome}`),
      ...legs.map((leg) => `event:${leg.market_url}`)
    ])
  ].sort();

  for (const lockKey of lockKeys) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  }

  return legs;
}

async function enforceSoftExposureCapacity(
  client: pg.PoolClient,
  input: {
    quoteId: string;
    userId: string;
    incrementalLiabilityMicroUsd: bigint;
    limits: PaymentExposureLimits;
  }
) {
  const legs = await lockQuoteExposureKeys(client, input.quoteId, input.userId);
  const marketLimitMicroUsd = usdLimitToMicroUsd(input.limits.maxMarketLiabilityUsd);
  const eventLimitMicroUsd = usdLimitToMicroUsd(input.limits.maxEventLiabilityUsd);

  const marketExposure = await client.query<{
    source_market_id: string;
    outcome: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      SELECT source_market_id, outcome, worst_case_liability_micro_usd::text
      FROM open_market_exposure_with_soft
      WHERE (source_market_id, outcome) IN (
        SELECT markets.source_market_id, quote_legs.outcome
        FROM quote_legs
        JOIN markets ON markets.id = quote_legs.market_id
        WHERE quote_legs.quote_id = $1
      )
    `,
    [input.quoteId]
  );
  const marketExposureByKey = new Map(
    marketExposure.rows.map((row) => [`${row.source_market_id}:${row.outcome}`, BigInt(row.worst_case_liability_micro_usd)])
  );

  for (const leg of legs) {
    const currentExposureMicroUsd = marketExposureByKey.get(`${leg.source_market_id}:${leg.outcome}`) || 0n;
    if (
      paymentExposureExceedsLimit({
        currentMicroUsd: currentExposureMicroUsd,
        incrementalMicroUsd: input.incrementalLiabilityMicroUsd,
        limitMicroUsd: marketLimitMicroUsd
      })
    ) {
      throw new Error("quote_exposure_limit:market");
    }
  }

  const eventExposure = await client.query<{
    market_url: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      SELECT market_url, worst_case_liability_micro_usd::text
      FROM open_event_exposure_with_soft
      WHERE market_url IN (
        SELECT markets.market_url
        FROM quote_legs
        JOIN markets ON markets.id = quote_legs.market_id
        WHERE quote_legs.quote_id = $1
      )
    `,
    [input.quoteId]
  );
  const eventExposureByUrl = new Map(eventExposure.rows.map((row) => [row.market_url, BigInt(row.worst_case_liability_micro_usd)]));

  for (const marketUrl of new Set(legs.map((leg) => leg.market_url))) {
    const currentExposureMicroUsd = eventExposureByUrl.get(marketUrl) || 0n;
    if (
      paymentExposureExceedsLimit({
        currentMicroUsd: currentExposureMicroUsd,
        incrementalMicroUsd: input.incrementalLiabilityMicroUsd,
        limitMicroUsd: eventLimitMicroUsd
      })
    ) {
      throw new Error("quote_exposure_limit:event");
    }
  }

  if (input.limits.maxUserLiabilityUsd !== undefined) {
    const userExposure = await client.query<{ worst_case_liability_micro_usd: string }>(
      `
        WITH hard AS (
          SELECT COALESCE(worst_case_liability_micro_usd, 0)::BIGINT AS exposure
          FROM open_user_exposure
          WHERE user_id = $1
        ),
        soft AS (
          SELECT COALESCE(sum(liability_micro_usd), 0)::BIGINT AS exposure
          FROM quote_payment_exposure_reservations
          WHERE user_id = $1
            AND status = 'reserved'
            AND expires_at > now()
        )
        SELECT (COALESCE((SELECT exposure FROM hard), 0) + COALESCE((SELECT exposure FROM soft), 0))::text
          AS worst_case_liability_micro_usd
      `,
      [input.userId]
    );
    const currentExposureMicroUsd = BigInt(userExposure.rows[0]?.worst_case_liability_micro_usd || 0);
    if (
      paymentExposureExceedsLimit({
        currentMicroUsd: currentExposureMicroUsd,
        incrementalMicroUsd: input.incrementalLiabilityMicroUsd,
        limitMicroUsd: usdLimitToMicroUsd(input.limits.maxUserLiabilityUsd)
      })
    ) {
      throw new Error("quote_exposure_limit:user");
    }
  }
}

async function reserveSoftExposure(
  client: pg.PoolClient,
  input: {
    paymentIntentId: string;
    quoteId: string;
    userId: string;
    liabilityMicroUsd: bigint;
    expiresAt: Date;
  }
) {
  await client.query(
    `
      INSERT INTO quote_payment_exposure_reservations (
        payment_intent_id,
        quote_id,
        user_id,
        liability_micro_usd,
        status,
        expires_at
      )
      VALUES ($1, $2, $3, $4, 'reserved', $5)
      ON CONFLICT (payment_intent_id)
      DO UPDATE SET
        liability_micro_usd = EXCLUDED.liability_micro_usd,
        status = 'reserved',
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
      WHERE quote_payment_exposure_reservations.status IN ('reserved', 'expired')
    `,
    [input.paymentIntentId, input.quoteId, input.userId, input.liabilityMicroUsd.toString(), input.expiresAt]
  );
}

async function updateSoftExposureReservation(
  client: pg.PoolClient,
  paymentIntentId: string,
  status: "reserved" | "released" | "consumed" | "expired",
  expiresAt?: Date
) {
  await client.query(
    `
      UPDATE quote_payment_exposure_reservations
      SET
        status = $2,
        expires_at = COALESCE($3::timestamptz, expires_at),
        updated_at = now()
      WHERE payment_intent_id = $1
        AND status IN ('reserved', 'expired')
    `,
    [paymentIntentId, status, expiresAt || null]
  );
}

async function expireIntent(client: pg.PoolClient, intentId: string) {
  await client.query(
    `
      UPDATE quote_payment_intents
      SET status = 'expired', updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'submitted')
    `,
    [intentId]
  );
  await updateSoftExposureReservation(client, intentId, "expired");
}

async function releaseCheckoutHoldForRecoveryInTransaction(client: pg.PoolClient, intent: QuotePaymentIntentRow) {
  if (!intent.checkout_ledger_transaction_id || intent.recovery_release_transaction_id) return intent;

  const amountReceived = BigInt(intent.amount_received_micro_units || 0);
  if (amountReceived <= 0n) return intent;

  // Activation may already have moved the amount due to available. Release only
  // the remaining checkout balance so the entire received transfer is available.
  const amountDue = BigInt(intent.amount_micro_units);
  const receivedSurplus = amountReceived > amountDue ? amountReceived - amountDue : 0n;
  const alreadyAvailable =
    (intent.activation_funding_transaction_id ? amountDue : 0n) +
    (intent.surplus_release_transaction_id ? receivedSurplus : 0n);
  const amountToRelease = amountReceived - alreadyAvailable;
  if (amountToRelease < 0n) throw new Error("payment_checkout_hold_invalid");

  const transactionId = randomUUID();
  const checkoutAccountId = await ensureLedgerAccount(client, intent.user_id, "user_usdc_checkout", "USDC");
  const availableAccountId = await ensureLedgerAccount(client, intent.user_id, "user_usdc_available", "USDC");
  for (const accountId of [checkoutAccountId, availableAccountId].sort()) {
    await client.query("SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE", [accountId]);
  }

  if (amountToRelease > 0n) {
    const checkoutBalance = await ledgerBalanceMicroUnits(client, checkoutAccountId);
    if (checkoutBalance < amountToRelease) throw new Error("payment_checkout_hold_insufficient");
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, 'USDC', 'quote payment released from checkout for recovery'),
          ($1, $4, $5, 'USDC', 'quote payment released from checkout for recovery')
      `,
      [transactionId, checkoutAccountId, (-amountToRelease).toString(), availableAccountId, amountToRelease.toString()]
    );
  }

  const result = await client.query<QuotePaymentIntentRow>(
    `
      UPDATE quote_payment_intents
      SET recovery_release_transaction_id = $2,
          updated_at = now()
      WHERE id = $1
        AND recovery_release_transaction_id IS NULL
      RETURNING *
    `,
    [intent.id, transactionId]
  );
  if (!result.rows[0]) throw new Error("payment_checkout_release_conflict");

  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'payment.checkout_released_for_recovery', 'quote_payment_intent', $2, $3)
    `,
    [
      intent.user_id,
      intent.id,
      {
        quoteId: intent.quote_id,
        amountReceivedMicroUnits: amountReceived.toString(),
        amountReleasedMicroUnits: amountToRelease.toString(),
        ledgerTransactionId: transactionId
      }
    ]
  );

  return result.rows[0];
}

async function markIntentRecoverableInTransaction(
  client: pg.PoolClient,
  input: {
    intent: QuotePaymentIntentRow;
    reason: PaymentRecoveryReason;
    detail?: string;
    finalQuoteId?: string;
    finalPayoutMicroUsd?: string | number | bigint;
  }
) {
  const result = await client.query<QuotePaymentIntentRow>(
    `
      UPDATE quote_payment_intents
      SET
        status = 'recoverable',
        recovery_reason = $2,
        recovery_detail = $3,
        final_quote_id = COALESCE($4::uuid, final_quote_id),
        final_payout_micro_usd = COALESCE($5::bigint, final_payout_micro_usd),
        activation_claim_token = NULL,
        activation_lease_expires_at = NULL,
        updated_at = now()
      WHERE id = $1
        AND ticket_id IS NULL
        AND activated_at IS NULL
        AND status IN ('submitted', 'confirmed', 'activating', 'expired', 'recoverable')
      RETURNING *
    `,
    [
      input.intent.id,
      input.reason,
      input.detail || null,
      input.finalQuoteId || null,
      input.finalPayoutMicroUsd === undefined ? null : input.finalPayoutMicroUsd.toString()
    ]
  );
  const updated = result.rows[0];
  if (!updated) throw new Error("payment_intent_not_confirmed");
  const recovered = await releaseCheckoutHoldForRecoveryInTransaction(client, updated);

  await updateSoftExposureReservation(client, input.intent.id, "released");
  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'payment.recoverable', 'quote_payment_intent', $2, $3)
    `,
    [
      input.intent.user_id,
      input.intent.id,
      {
        quoteId: input.intent.quote_id,
        reason: input.reason,
        detail: input.detail,
        finalQuoteId: input.finalQuoteId,
        finalPayoutMicroUsd: input.finalPayoutMicroUsd?.toString()
      }
    ]
  );

  return recovered;
}

export async function claimQuotePaymentActivation(input: { quoteId: string; userId: string; now?: Date; leaseMs?: number }) {
  const client = await getPool().connect();
  let committed = false;
  const now = input.now || new Date();
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseMs || paymentActivationLeaseMs));

  try {
    await client.query("BEGIN");
    const intentResult = await client.query<QuotePaymentIntentRow>(
      `
        SELECT *
        FROM quote_payment_intents
        WHERE quote_id = $1
          AND user_id = $2
        FOR UPDATE
      `,
      [input.quoteId, input.userId]
    );
    const intent = intentResult.rows[0];
    if (!intent) throw new Error("payment_intent_not_found");
    if (intent.status === "activated") {
      await client.query("COMMIT");
      committed = true;
      return {
        intent: rowToIntent(intent),
        claimToken: intent.activation_claim_token || claimToken,
        alreadyActivated: true
      };
    }
    if (intent.status === "recoverable") throw new Error(`payment_intent_recoverable:${intent.recovery_reason || "activation_failed"}`);
    const deadline = intent.activation_deadline_at || intent.tracking_deadline_at || intent.expires_at;
    if (deadline && deadline.getTime() <= now.getTime()) {
      await markIntentRecoverableInTransaction(client, {
        intent,
        reason: "late_confirmation",
        detail: "Confirmed payment was not activated before the activation deadline."
      });
      await client.query("COMMIT");
      committed = true;
      throw new Error("late_confirmation");
    }
    if (intent.status === "activating" && intent.activation_lease_expires_at && intent.activation_lease_expires_at.getTime() > now.getTime()) {
      throw new Error("payment_activation_in_progress");
    }
    if (intent.status !== "confirmed" && intent.status !== "activating") {
      throw new Error("payment_intent_not_confirmed");
    }

    const updated = await client.query<QuotePaymentIntentRow>(
      `
        UPDATE quote_payment_intents
        SET
          status = 'activating',
          activation_claim_token = $3,
          activation_claimed_at = now(),
          activation_lease_expires_at = $4,
          updated_at = now()
        WHERE id = $1
          AND user_id = $2
          AND status IN ('confirmed', 'activating')
          AND ticket_id IS NULL
          AND activated_at IS NULL
        RETURNING *
      `,
      [intent.id, input.userId, claimToken, leaseExpiresAt]
    );
    if (!updated.rows[0]) throw new Error("payment_intent_not_confirmed");
    await client.query("COMMIT");
    committed = true;
    return {
      intent: rowToIntent(updated.rows[0]),
      claimToken,
      alreadyActivated: false
    };
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverStaleConfirmedQuotePaymentIntents(limit = 100) {
  const client = await getPool().connect();
  let recovered = 0;

  try {
    await client.query("BEGIN");
    const stale = await client.query<QuotePaymentIntentRow>(
      `
        SELECT *
        FROM quote_payment_intents
        WHERE status IN ('confirmed', 'activating', 'recoverable')
          AND ticket_id IS NULL
          AND activated_at IS NULL
          AND (
            (status IN ('confirmed', 'activating') AND activation_deadline_at <= now())
            OR (
              status = 'recoverable'
              AND checkout_ledger_transaction_id IS NOT NULL
              AND recovery_release_transaction_id IS NULL
            )
          )
        ORDER BY confirmed_at ASC NULLS LAST, updated_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [limit]
    );

    for (const intent of stale.rows) {
      await markIntentRecoverableInTransaction(client, {
        intent,
        reason: intent.recovery_reason || "late_confirmation",
        detail: intent.recovery_detail || "Confirmed payment was not activated before the activation deadline."
      });
      recovered += 1;
    }

    await client.query("COMMIT");
    return { scanned: stale.rows.length, recovered };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createQuotePaymentIntent(input: {
  quoteId: string;
  userId: string;
  treasuryConfig: TreasuryPaymentConfig;
  holdMs?: number;
  maxAdverseBps?: number;
  exposureLimits?: PaymentExposureLimits;
}): Promise<QuotePaymentIntent> {
  const treasuryAddress = normalizeAddress(input.treasuryConfig.treasuryAddress);
  const usdcContractAddress = normalizeAddress(input.treasuryConfig.usdcContractAddress);
  const submissionDeadlineAt = new Date(Date.now() + (input.holdMs || paymentRequestSubmissionDeadlineMs));
  const maxAdverseBps = input.maxAdverseBps ?? defaultMaxAdverseBps;
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    await assertFinancialGateOpenInTransaction(client, { operation: "quote_payment_intent.create" });
    const quoteResult = await client.query<{
      id: string;
      user_id: string | null;
      status: "quoted" | "accepted" | "expired" | "rejected";
      risk_decision: "accept" | "review" | "reject";
      stake_micro_usd: string;
      operation_fee_micro_usd: string;
      offered_payout_micro_usd: string;
      expires_at: Date;
    }>(
      `
        SELECT
          id,
          user_id,
          status,
          risk_decision,
          stake_micro_usd::text,
          operation_fee_micro_usd::text,
          offered_payout_micro_usd::text,
          expires_at
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
    if (intent) {
      if (intent.isExpired && (intent.status === "pending" || intent.status === "submitted")) {
        await expireIntent(client, intent.id);
      }
      await client.query("COMMIT");
      committed = true;
      if (intent.isExpired && (intent.status === "pending" || intent.status === "submitted")) {
        throw new Error("payment_intent_expired");
      }
      return rowToIntent(intent);
    }

    const amountDue = BigInt(quote.stake_micro_usd) + BigInt(quote.operation_fee_micro_usd);
    const estimatedPayout = BigInt(quote.offered_payout_micro_usd);
    const minimumFinalPayout = minFinalPayoutMicroUsd(estimatedPayout, maxAdverseBps);
    const liability = estimatedPayout > BigInt(quote.stake_micro_usd) ? estimatedPayout - BigInt(quote.stake_micro_usd) : 0n;
    await enforceSoftExposureCapacity(client, {
      quoteId: quote.id,
      userId: input.userId,
      incrementalLiabilityMicroUsd: liability,
      limits: input.exposureLimits || defaultExposureLimits()
    });
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
          expires_at,
          submission_deadline_at,
          max_adverse_bps,
          estimated_payout_micro_usd,
          min_final_payout_micro_usd
        )
        VALUES ($1, $2, $3, 'USDC', $4, $5, $6, $7, 'pending', $8, $8, $9, $10, $11)
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
        submissionDeadlineAt,
        maxAdverseBps,
        estimatedPayout.toString(),
        minimumFinalPayout.toString()
      ]
    );
    await reserveSoftExposure(client, {
      paymentIntentId: intentResult.rows[0].id,
      quoteId: quote.id,
      userId: input.userId,
      liabilityMicroUsd: liability,
      expiresAt: submissionDeadlineAt
    });
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
    status: Extract<PaymentIntentStatus, "submitted" | "confirmed" | "recoverable">;
    txHash: string | null;
    chainId: number;
    amountMicroUnits: string;
    amountReceivedMicroUnits: string;
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
        quote_payment_intents.amount_received_micro_units::text AS "amountReceivedMicroUnits",
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
          OR quote_payment_intents.status = 'recoverable'
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
    amountPaidUsd: amountUsdc(row.amountReceivedMicroUnits !== "0" ? row.amountReceivedMicroUnits : row.amountMicroUnits),
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

    if (intent.status === "confirmed" || intent.status === "activated" || intent.status === "recoverable") {
      if (intent.tx_hash === txHash) {
        await client.query("COMMIT");
        committed = true;
        return rowToIntent(intent);
      }
      throw new Error("payment_intent_tx_hash_conflict");
    }

    if (intent.status === "failed") {
      throw new Error("payment_intent_not_submittable");
    }

    const txConflict = await client.query<{ id: string }>(
      `
        SELECT id
        FROM quote_payment_intents
        WHERE chain_id = $1
          AND tx_hash = $2
          AND id <> $3
          AND status <> 'failed'
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
    }

    if (intent.status !== "pending" && intent.status !== "submitted" && intent.status !== "expired") {
      throw new Error("payment_intent_not_submittable");
    }

    const now = new Date();
    const submissionDeadline = intent.submission_deadline_at || intent.expires_at;
    const isLateSubmission = intent.status === "expired" || submissionDeadline.getTime() <= now.getTime();
    const trackingDeadlineAt = new Date(now.getTime() + submittedTxTrackingMs);
    const result = await client.query<QuotePaymentIntentRow>(
      `
        UPDATE quote_payment_intents
        SET
          tx_hash = $3,
          status = 'submitted',
          submitted_at = COALESCE(submitted_at, now()),
          tracking_deadline_at = COALESCE(tracking_deadline_at, $4),
          expires_at = CASE
            WHEN tracking_deadline_at IS NULL OR tracking_deadline_at <= now() THEN $4
            ELSE tracking_deadline_at
          END,
          recovery_reason = CASE
            WHEN $5::boolean THEN 'late_submission'
            ELSE recovery_reason
          END,
          recovery_detail = CASE
            WHEN $5::boolean THEN 'Transaction hash was submitted after the payment request deadline.'
            ELSE recovery_detail
          END,
          updated_at = now()
        WHERE id = $1
          AND user_id = $2
          AND status IN ('pending', 'submitted', 'expired')
        RETURNING *
      `,
      [intent.id, input.userId, txHash, trackingDeadlineAt, isLateSubmission]
    );
    if (!result.rows[0]) throw new Error("payment_intent_not_submittable");
    if (!isLateSubmission) {
      await updateSoftExposureReservation(client, result.rows[0].id, "reserved", trackingDeadlineAt);
    }
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

function confirmedPaymentState(intent: QuotePaymentIntentRow, amountReceivedMicroUnits: bigint) {
  const amountDue = BigInt(intent.amount_micro_units);
  const surplus = amountReceivedMicroUnits > amountDue ? amountReceivedMicroUnits - amountDue : 0n;
  const trackingDeadline = intent.tracking_deadline_at || intent.expires_at;

  if (amountReceivedMicroUnits < amountDue) {
    return {
      status: "recoverable" as const,
      recoveryReason: "underpayment" as PaymentRecoveryReason,
      recoveryDetail: "Confirmed transfer was less than the payment request amount.",
      surplus
    };
  }

  if (intent.recovery_reason === "late_submission") {
    return {
      status: "recoverable" as const,
      recoveryReason: "late_submission" as PaymentRecoveryReason,
      recoveryDetail: "Transfer was confirmed for a transaction submitted after the payment request deadline.",
      surplus
    };
  }

  if (intent.status === "expired" || trackingDeadline.getTime() <= Date.now()) {
    return {
      status: "recoverable" as const,
      recoveryReason: "late_confirmation" as PaymentRecoveryReason,
      recoveryDetail: "Transfer was confirmed after the submitted transaction tracking window.",
      surplus
    };
  }

  return {
    status: "confirmed" as const,
    recoveryReason: undefined,
    recoveryDetail: undefined,
    surplus
  };
}

async function creditQuotePaymentCheckoutHold(
  client: pg.PoolClient,
  input: {
    intent: QuotePaymentIntentRow;
    depositId: string;
    walletId: string;
    amountMicroUnits: bigint;
    confirmations: number;
    rebindingCreditedDeposit?: boolean;
  }
) {
  const transactionId = randomUUID();
  const checkoutAccountId = await ensureLedgerAccount(client, input.intent.user_id, "user_usdc_checkout", "USDC");
  const clearingAccountId = input.rebindingCreditedDeposit
    ? await ensureLedgerAccount(client, input.intent.user_id, "user_usdc_available", "USDC")
    : await ensureLedgerAccount(client, null, "external_usdc_deposits", "USDC");
  const clearingAmount = -input.amountMicroUnits;
  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES
        ($1, $2, $3, 'USDC', 'quote payment held for checkout'),
        ($1, $4, $5, 'USDC', 'quote payment held for checkout')
    `,
    [transactionId, checkoutAccountId, input.amountMicroUnits.toString(), clearingAccountId, clearingAmount.toString()]
  );

  const state = confirmedPaymentState(input.intent, input.amountMicroUnits);
  const result = await client.query<QuotePaymentIntentRow>(
    `
      UPDATE quote_payment_intents
      SET
        status = $2,
        onchain_deposit_id = $3,
        amount_received_micro_units = $4,
        surplus_micro_units = $5,
        checkout_ledger_transaction_id = COALESCE(checkout_ledger_transaction_id, $6::uuid),
        confirmed_at = COALESCE(confirmed_at, now()),
        activation_deadline_at = CASE
          WHEN $2 = 'confirmed' THEN COALESCE(activation_deadline_at, now() + ($9::text || ' milliseconds')::interval)
          ELSE activation_deadline_at
        END,
        recovery_reason = $7,
        recovery_detail = $8,
        updated_at = now()
      WHERE id = $1
        AND status IN ('submitted', 'expired', 'recoverable')
      RETURNING *
    `,
    [
      input.intent.id,
      state.status,
      input.depositId,
      input.amountMicroUnits.toString(),
      state.surplus.toString(),
      transactionId,
      state.recoveryReason || null,
      state.recoveryDetail || null,
      confirmedPaymentActivationDeadlineMs
    ]
  );
  const updated = result.rows[0];
  if (!updated) throw new Error("payment_intent_credit_conflict");
  if (state.status === "confirmed") {
    await updateSoftExposureReservation(client, input.intent.id, "reserved", new Date(Date.now() + submittedTxTrackingMs));
  } else {
    await updateSoftExposureReservation(client, input.intent.id, "released");
    await releaseCheckoutHoldForRecoveryInTransaction(client, updated);
  }
  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'payment.confirmed', 'quote_payment_intent', $2, $3)
    `,
    [
      input.intent.user_id,
      input.intent.id,
      {
        quoteId: input.intent.quote_id,
        depositId: input.depositId,
        walletId: input.walletId,
        amountMicroUnits: input.amountMicroUnits.toString(),
        amountDueMicroUnits: input.intent.amount_micro_units,
        surplusMicroUnits: state.surplus.toString(),
        confirmations: input.confirmations,
        ledgerTransactionId: transactionId,
        status: state.status,
        recoveryReason: state.recoveryReason
      }
    ]
  );

  return {
    updated,
    transactionId
  };
}

async function reconcileExistingConfirmedDeposit(client: pg.PoolClient, intent: QuotePaymentIntentRow): Promise<ExistingDepositPaymentClaim | undefined> {
  if (!intent.tx_hash) return undefined;

  const depositResult = await client.query<{
    id: string;
    amount_micro_units: string;
    credited_transaction_id: string | null;
  }>(
    `
      SELECT onchain_deposits.id, onchain_deposits.amount_micro_units::text, onchain_deposits.credited_transaction_id
      FROM onchain_deposits
      WHERE onchain_deposits.chain_id = $1
        AND onchain_deposits.tx_hash = $2
        AND onchain_deposits.to_address = $3
        AND onchain_deposits.token_address = $4
        AND onchain_deposits.user_id = $5
        AND onchain_deposits.status = 'credited'
        AND onchain_deposits.payment_intent_id IS NULL
      ORDER BY onchain_deposits.log_index ASC
      LIMIT 1
      FOR UPDATE
    `,
    [intent.chain_id, intent.tx_hash, intent.treasury_address, intent.usdc_contract_address, intent.user_id]
  );
  const deposit = depositResult.rows[0];
  if (!deposit?.credited_transaction_id) return undefined;

  const amountMicroUnits = BigInt(deposit.amount_micro_units);
  const availableAccountId = await ensureLedgerAccount(client, intent.user_id, "user_usdc_available", "USDC");
  const checkoutAccountId = await ensureLedgerAccount(client, intent.user_id, "user_usdc_checkout", "USDC");
  await client.query("SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
    [availableAccountId, checkoutAccountId].sort()
  ]);
  const availableBalance = await ledgerBalanceMicroUnits(client, availableAccountId);
  if (availableBalance < amountMicroUnits) {
    await markIntentRecoverableInTransaction(client, {
      intent,
      reason: intent.recovery_reason || "activation_failed",
      detail:
        intent.recovery_detail ||
        "Previously credited deposit funds are no longer available for quote payment checkout."
    });
    return undefined;
  }

  await client.query(
    `
      UPDATE onchain_deposits
      SET payment_intent_id = $2, updated_at = now()
      WHERE id = $1
    `,
    [deposit.id, intent.id]
  );
  const bound = await creditQuotePaymentCheckoutHold(client, {
    intent,
    depositId: deposit.id,
    walletId: "",
    amountMicroUnits,
    confirmations: 0,
    rebindingCreditedDeposit: true
  });

  return {
    paymentIntentId: intent.id,
    quoteId: intent.quote_id,
    userId: intent.user_id,
    ledgerTransactionId: bound.transactionId
  };
}

async function initialCatalogRefsForFinalQuote(
  client: pg.PoolClient,
  estimateQuoteId: string,
  leg: QuoteResponse["legs"][number]
) {
  const result = await client.query<{
    estimate_quote_leg_id: string;
    market_id: string;
    outcome_id: string;
    snapshot_id: string;
    source_market_id: string;
    condition_id: string | null;
    token_id: string | null;
    snapshot_hash: string;
    snapshot_captured_at: Date;
  }>(
    `
      SELECT
        estimate_quote_legs.id AS estimate_quote_leg_id,
        markets.id AS market_id,
        market_outcomes.id AS outcome_id,
        market_snapshots.id AS snapshot_id,
        markets.source_market_id,
        markets.condition_id,
        market_outcomes.token_id,
        market_snapshots.source_response_hash AS snapshot_hash,
        market_snapshots.captured_at AS snapshot_captured_at
      FROM quote_legs estimate_quote_legs
      JOIN markets ON markets.id = estimate_quote_legs.market_id
      JOIN market_outcomes ON market_outcomes.id = estimate_quote_legs.outcome_id
      JOIN market_snapshots ON market_snapshots.id = estimate_quote_legs.market_snapshot_id
      WHERE estimate_quote_legs.quote_id = $1
        AND markets.source = 'polymarket'
        AND markets.source_market_id = $2
        AND markets.condition_id IS NOT DISTINCT FROM $3
        AND market_outcomes.outcome = $4
      LIMIT 1
    `,
    [estimateQuoteId, leg.marketId, leg.conditionId || null, leg.outcome]
  );

  if (!result.rows[0]) {
    throw new Error("stale_book");
  }

  return result.rows[0];
}

async function ensureImmutablePolicyVersion(client: pg.PoolClient) {
  await client.query(
    `
      INSERT INTO policy_versions (version, description, policy, active)
      VALUES ($1, $2, $3, true)
      ON CONFLICT (version) DO NOTHING
    `,
    ["server-risk-v1", "Initial deterministic launch risk policy", DEFAULT_RISK_POLICY]
  );

  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM policy_versions
      WHERE version = $1
      LIMIT 1
    `,
    ["server-risk-v1"]
  );
  if (!result.rows[0]) throw new Error("policy_version_not_found");
  return result.rows[0].id;
}

type FinalQuoteEvidenceByLegId = Map<string, unknown> | Record<string, unknown>;

function evidenceForLeg(evidenceByLegId: FinalQuoteEvidenceByLegId | undefined, legId: string) {
  if (!evidenceByLegId) return undefined;
  if (evidenceByLegId instanceof Map) return evidenceByLegId.get(legId);
  return evidenceByLegId[legId];
}

type FinalQuoteMarketRefs = Awaited<ReturnType<typeof initialCatalogRefsForFinalQuote>>;

function evidenceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("final_quote_evidence_required");
  }
  return value as Record<string, unknown>;
}

function evidenceNumber(evidence: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function evidenceString(evidence: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function requireEvidenceNumber(evidence: Record<string, unknown>, keys: string[], error = "final_quote_evidence_incomplete") {
  const value = evidenceNumber(evidence, keys);
  if (value === undefined) throw new Error(error);
  return value;
}

function requireEvidenceString(evidence: Record<string, unknown>, keys: string[], error = "final_quote_evidence_incomplete") {
  const value = evidenceString(evidence, keys);
  if (value === undefined) throw new Error(error);
  return value;
}

function requireEvidenceTimestamp(evidence: Record<string, unknown>, keys: string[], error = "final_quote_evidence_incomplete") {
  const value = requireEvidenceString(evidence, keys, error);
  if (!Number.isFinite(Date.parse(value))) throw new Error(error);
  return new Date(value).toISOString();
}

function canonicalCatalogSnapshotEvidence(input: {
  estimateQuoteId: string;
  leg: QuoteResponse["legs"][number];
  refs: FinalQuoteMarketRefs;
}) {
  return {
    schemaVersion: 1,
    source: "persisted_catalog",
    estimateQuoteId: input.estimateQuoteId,
    estimateQuoteLegId: input.refs.estimate_quote_leg_id,
    legId: input.leg.id,
    market: {
      sourceMarketId: input.refs.source_market_id,
      conditionId: input.refs.condition_id,
      outcomeId: input.refs.outcome_id,
      outcome: input.leg.outcome,
      tokenId: input.refs.token_id
    },
    snapshot: {
      id: input.refs.snapshot_id,
      sourceResponseHash: input.refs.snapshot_hash,
      capturedAt: input.refs.snapshot_captured_at.toISOString()
    }
  };
}

function canonicalLiveOrderbookEvidence(input: {
  rawEvidence: unknown;
  leg: QuoteResponse["legs"][number];
  refs: FinalQuoteMarketRefs;
}) {
  const raw = evidenceRecord(input.rawEvidence);
  const requestedNotionalUsd = requireEvidenceNumber(raw, ["requestedNotionalUsd", "requestedUsd", "notionalUsd"]);
  const availableNotionalUsd = requireEvidenceNumber(raw, ["availableNotionalUsd", "availableAskNotionalUsd", "executableNotionalUsd", "askDepthUsd"]);
  const bestAsk = requireEvidenceNumber(raw, ["bestAsk"]);
  const executablePrice = requireEvidenceNumber(raw, ["executablePrice", "vwapAsk", "vwapPrice", "askVwap", "price"]);
  const vwapAsk = evidenceNumber(raw, ["vwapAsk", "vwapPrice", "askVwap"]) ?? executablePrice;
  const orderbookHash = requireEvidenceString(raw, ["orderbookHash", "bookHash"]);
  const fetchedAt = requireEvidenceTimestamp(raw, ["liveOrderbookFetchedAt"], "final_quote_live_evidence_required");
  const sourceTimestamp = requireEvidenceTimestamp(raw, ["orderbookTimestamp"], "final_quote_live_evidence_required");

  if (requestedNotionalUsd <= 0 || availableNotionalUsd + 1e-9 < requestedNotionalUsd) {
    throw new Error("insufficient_depth");
  }

  return {
    schemaVersion: 1,
    source: "polymarket_clob_live",
    legId: input.leg.id,
    market: {
      sourceMarketId: input.refs.source_market_id,
      conditionId: input.refs.condition_id,
      outcomeId: input.refs.outcome_id,
      outcome: input.leg.outcome,
      tokenId: input.refs.token_id
    },
    orderbook: {
      hash: orderbookHash,
      fetchedAt,
      sourceTimestamp,
      bestAsk
    },
    depth: {
      requestedNotionalUsd,
      availableNotionalUsd
    },
    execution: {
      executablePrice,
      vwapAsk,
      priceSource: evidenceString(raw, ["priceSource"]) || input.leg.priceSource || "clob_vwap"
    },
    raw
  };
}

async function persistFinalQuoteForQuotePaymentInTransaction(
  client: pg.PoolClient,
  input: {
    quoteId: string;
    userId: string;
    finalQuote: QuoteResponse;
    evidenceByLegId?: FinalQuoteEvidenceByLegId;
    expectedStatus?: Extract<PaymentIntentStatus, "confirmed" | "activating">;
    activationClaimToken?: string;
  }
) {
  if (input.finalQuote.status !== "quoted" || input.finalQuote.riskDecision !== "accept") {
    throw new Error(`quote_requires_review:${input.finalQuote.riskDecision}`);
  }

  const expectedStatus = input.expectedStatus || "confirmed";
  const intentResult = await client.query<QuotePaymentIntentRow>(
    `
      SELECT *
      FROM quote_payment_intents
      WHERE quote_id = $1
        AND user_id = $2
      FOR UPDATE
    `,
    [input.quoteId, input.userId]
  );
  const intent = intentResult.rows[0];
  if (!intent) throw new Error("payment_intent_not_found");
  if (intent.status !== expectedStatus) throw new Error("payment_intent_not_confirmed");
  if (expectedStatus === "activating" && input.activationClaimToken && intent.activation_claim_token !== input.activationClaimToken) {
    throw new Error("payment_activation_claim_conflict");
  }
  if (intent.final_quote_id) {
    return rowToIntent(intent);
  }

  const policyVersionId = await ensureImmutablePolicyVersion(client);
  await client.query(
    `
      INSERT INTO quotes (
        id,
        user_id,
        policy_version_id,
        status,
        stake_micro_usd,
        operation_fee_micro_usd,
        spread_bps,
        implied_probability_bps,
        offered_payout_micro_usd,
        risk_decision,
        expires_at,
        created_at,
        parent_quote_id,
        quote_kind
      )
      VALUES ($1, $2, $3, 'quoted', $4, $5, $6, $7, $8, $9, $10, $11, $12, 'final')
      ON CONFLICT (id) DO NOTHING
    `,
    [
      input.finalQuote.id,
      input.userId,
      policyVersionId,
      microUsd(input.finalQuote.stakeUsd),
      microUsd(input.finalQuote.operationFeeUsd),
      bps(input.finalQuote.quoteSpread),
      bps(input.finalQuote.basketProbability),
      microUsd(input.finalQuote.potentialPayoutUsd),
      input.finalQuote.riskDecision,
      input.finalQuote.expiresAt,
      input.finalQuote.createdAt,
      input.quoteId
    ]
  );

  const finalQuoteResult = await client.query<{ id: string; parent_quote_id: string | null; quote_kind: string }>(
    `
      SELECT id, parent_quote_id, quote_kind
      FROM quotes
      WHERE id = $1
      LIMIT 1
    `,
    [input.finalQuote.id]
  );
  const finalQuoteRow = finalQuoteResult.rows[0];
  if (!finalQuoteRow || finalQuoteRow.parent_quote_id !== input.quoteId || finalQuoteRow.quote_kind !== "final") {
    throw new Error("final_quote_conflict");
  }

  for (const leg of input.finalQuote.legs) {
    const rawEvidence = evidenceForLeg(input.evidenceByLegId, leg.id);
    const refs = await initialCatalogRefsForFinalQuote(client, input.quoteId, leg);
    const legResult = await client.query<{ id: string }>(
      `
        INSERT INTO quote_legs (
          quote_id,
          market_id,
          outcome_id,
          market_snapshot_id,
          outcome,
          quoted_price_bps
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (quote_id, outcome_id) DO NOTHING
        RETURNING id
      `,
      [input.finalQuote.id, refs.market_id, refs.outcome_id, refs.snapshot_id, leg.outcome, bps(leg.price)]
    );
    const quoteLegId =
      legResult.rows[0]?.id ||
      (
        await client.query<{ id: string }>(
          `
            SELECT id
            FROM quote_legs
            WHERE quote_id = $1
              AND outcome_id = $2
            LIMIT 1
          `,
          [input.finalQuote.id, refs.outcome_id]
        )
      ).rows[0]?.id;
    if (!quoteLegId) throw new Error("final_quote_leg_conflict");

    const catalogEvidence = canonicalCatalogSnapshotEvidence({
      estimateQuoteId: input.quoteId,
      leg,
      refs
    });
    const liveEvidence = canonicalLiveOrderbookEvidence({ rawEvidence, leg, refs });
    await client.query(
      `
        INSERT INTO quote_reprice_evidence (quote_id, quote_leg_id, evidence_type, evidence)
        VALUES
          ($1, $2, 'catalog_snapshot', $3),
          ($1, $2, 'live_orderbook', $4)
        ON CONFLICT DO NOTHING
      `,
      [input.finalQuote.id, quoteLegId, catalogEvidence, liveEvidence]
    );
  }
  for (const check of input.finalQuote.riskChecks) {
    await client.query(
      `
        INSERT INTO risk_checks (quote_id, level, label, detail)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
      `,
      [input.finalQuote.id, check.level, check.label, check.detail]
    );
  }

  const evidenceCount = await client.query<{ catalog_evidence_count: string; live_evidence_count: string; leg_count: string }>(
    `
      SELECT
        count(DISTINCT quote_legs.id)::text AS leg_count,
        count(DISTINCT quote_reprice_evidence.quote_leg_id) FILTER (
          WHERE quote_reprice_evidence.evidence_type = 'catalog_snapshot'
        )::text AS catalog_evidence_count,
        count(DISTINCT quote_reprice_evidence.quote_leg_id) FILTER (
          WHERE quote_reprice_evidence.evidence_type = 'live_orderbook'
        )::text AS live_evidence_count
      FROM quote_legs
      LEFT JOIN quote_reprice_evidence
        ON quote_reprice_evidence.quote_leg_id = quote_legs.id
        AND quote_reprice_evidence.quote_id = quote_legs.quote_id
      WHERE quote_legs.quote_id = $1
    `,
    [input.finalQuote.id]
  );
  const counts = evidenceCount.rows[0];
  if (
    !counts ||
    Number(counts.leg_count) !== input.finalQuote.legs.length ||
    Number(counts.catalog_evidence_count) !== input.finalQuote.legs.length ||
    Number(counts.live_evidence_count) !== input.finalQuote.legs.length
  ) {
    throw new Error("final_quote_reprice_evidence_required");
  }

  const updatedIntent = await client.query<QuotePaymentIntentRow>(
    `
      UPDATE quote_payment_intents
      SET
        final_quote_id = $3,
        final_payout_micro_usd = $4,
        updated_at = now()
      WHERE quote_id = $1
        AND user_id = $2
        AND status = $5
        AND final_quote_id IS NULL
      RETURNING *
    `,
    [input.quoteId, input.userId, input.finalQuote.id, microUsd(input.finalQuote.potentialPayoutUsd), expectedStatus]
  );
  if (!updatedIntent.rows[0]) {
    throw new Error("payment_final_quote_link_conflict");
  }
  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'payment.final_quote_applied', 'quote_payment_intent', $2, $3)
    `,
    [
      input.userId,
      intent.id,
      {
        estimateQuoteId: input.quoteId,
        finalQuoteId: input.finalQuote.id,
        finalPayoutMicroUsd: microUsd(input.finalQuote.potentialPayoutUsd).toString()
      }
    ]
  );
  return rowToIntent(updatedIntent.rows[0]);
}

export async function persistFinalQuoteForQuotePayment(input: {
  quoteId: string;
  userId: string;
  finalQuote: QuoteResponse;
  evidenceByLegId?: FinalQuoteEvidenceByLegId;
}) {
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const intent = await persistFinalQuoteForQuotePaymentInTransaction(client, input);
    await client.query("COMMIT");
    committed = true;
    return intent;
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function ledgerBalanceMicroUnits(client: pg.PoolClient, accountId: string) {
  const result = await client.query<{ balance: string }>(
    `
      SELECT COALESCE(sum(amount_micro_units), 0)::text AS balance
      FROM ledger_entries
      WHERE account_id = $1
    `,
    [accountId]
  );

  return BigInt(result.rows[0]?.balance || 0);
}

async function releaseQuotePaymentSurplusInTransaction(client: pg.PoolClient, intent: QuotePaymentIntentRow) {
  if (intent.surplus_release_transaction_id) return intent;

  const amountDue = BigInt(intent.amount_micro_units);
  const amountReceived = BigInt(intent.amount_received_micro_units || 0);
  const surplus = amountReceived > amountDue ? amountReceived - amountDue : 0n;
  if (surplus === 0n) return intent;

  const checkoutAccountId = await ensureLedgerAccount(client, intent.user_id, "user_usdc_checkout", "USDC");
  const availableAccountId = await ensureLedgerAccount(client, intent.user_id, "user_usdc_available", "USDC");
  for (const accountId of [checkoutAccountId, availableAccountId].sort()) {
    await client.query("SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE", [accountId]);
  }
  const checkoutBalance = await ledgerBalanceMicroUnits(client, checkoutAccountId);
  if (checkoutBalance < surplus) throw new Error("payment_checkout_surplus_insufficient");

  const transactionId = randomUUID();
  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES
        ($1, $2, $3, 'USDC', 'quote payment surplus released from checkout'),
        ($1, $4, $5, 'USDC', 'quote payment surplus released from checkout')
    `,
    [transactionId, checkoutAccountId, (-surplus).toString(), availableAccountId, surplus.toString()]
  );
  const updated = await client.query<QuotePaymentIntentRow>(
    `
      UPDATE quote_payment_intents
      SET
        surplus_micro_units = $2,
        surplus_release_transaction_id = $3,
        updated_at = now()
      WHERE id = $1
        AND surplus_release_transaction_id IS NULL
      RETURNING *
    `,
    [intent.id, surplus.toString(), transactionId]
  );
  if (!updated.rows[0]) throw new Error("payment_surplus_release_conflict");

  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'payment.surplus_released', 'quote_payment_intent', $2, $3)
    `,
    [
      intent.user_id,
      intent.id,
      {
        quoteId: intent.quote_id,
        surplusMicroUnits: surplus.toString(),
        ledgerTransactionId: transactionId
      }
    ]
  );

  return updated.rows[0];
}

async function revalueSoftExposureReservationForActivation(
  client: pg.PoolClient,
  input: {
    paymentIntentId: string;
    finalQuoteId: string;
    userId: string;
    liabilityMicroUsd: bigint;
    expiresAt: Date;
  }
) {
  const result = await client.query(
    `
      UPDATE quote_payment_exposure_reservations
      SET
        quote_id = $2,
        user_id = $3,
        liability_micro_usd = $4,
        status = 'reserved',
        expires_at = $5,
        updated_at = now()
      WHERE payment_intent_id = $1
        AND status IN ('reserved', 'expired')
      RETURNING id
    `,
    [input.paymentIntentId, input.finalQuoteId, input.userId, input.liabilityMicroUsd.toString(), input.expiresAt]
  );
  if (!result.rows[0]) throw new Error("payment_exposure_reservation_not_found");
}

async function prepareQuotePaymentCheckoutFundsForActivationInTransaction(
  client: pg.PoolClient,
  input: {
    quoteId: string;
    userId: string;
    expectedStatus?: Extract<PaymentIntentStatus, "confirmed" | "activating">;
    activationClaimToken?: string;
  }
) {
  const expectedStatus = input.expectedStatus || "confirmed";
  const intentResult = await client.query<QuotePaymentIntentRow>(
    `
      SELECT *
      FROM quote_payment_intents
      WHERE quote_id = $1
        AND user_id = $2
      FOR UPDATE
    `,
    [input.quoteId, input.userId]
  );
  const intent = intentResult.rows[0];
  if (!intent) throw new Error("payment_intent_not_found");
  if (intent.status !== expectedStatus) throw new Error("payment_intent_not_confirmed");
  if (expectedStatus === "activating" && input.activationClaimToken && intent.activation_claim_token !== input.activationClaimToken) {
    throw new Error("payment_activation_claim_conflict");
  }
  if (intent.activation_funding_transaction_id) {
    return rowToIntent(await releaseQuotePaymentSurplusInTransaction(client, intent));
  }

  const amountDue = BigInt(intent.amount_micro_units);
  const amountReceived = BigInt(intent.amount_received_micro_units || 0);
  if (amountReceived < amountDue) {
    throw new Error("payment_intent_underpaid");
  }

  const checkoutAccountId = await ensureLedgerAccount(client, input.userId, "user_usdc_checkout", "USDC");
  const availableAccountId = await ensureLedgerAccount(client, input.userId, "user_usdc_available", "USDC");
  for (const accountId of [checkoutAccountId, availableAccountId].sort()) {
    await client.query("SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE", [accountId]);
  }
  const checkoutBalance = await ledgerBalanceMicroUnits(client, checkoutAccountId);
  if (checkoutBalance < amountDue) {
    throw new Error("payment_checkout_hold_insufficient");
  }

  const transactionId = randomUUID();
  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES
        ($1, $2, $3, 'USDC', 'quote payment released for activation'),
        ($1, $4, $5, 'USDC', 'quote payment released for activation')
    `,
    [transactionId, checkoutAccountId, (-amountDue).toString(), availableAccountId, amountDue.toString()]
  );
  const updated = await client.query<QuotePaymentIntentRow>(
    `
      UPDATE quote_payment_intents
      SET
        activation_funding_transaction_id = $3,
        updated_at = now()
      WHERE quote_id = $1
        AND user_id = $2
        AND status = $4
        AND activation_funding_transaction_id IS NULL
      RETURNING *
    `,
    [input.quoteId, input.userId, transactionId, expectedStatus]
  );
  if (!updated.rows[0]) {
    throw new Error("payment_activation_funding_conflict");
  }
  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'payment.checkout_released_for_activation', 'quote_payment_intent', $2, $3)
    `,
    [
      input.userId,
      intent.id,
      {
        quoteId: input.quoteId,
        amountMicroUnits: amountDue.toString(),
        ledgerTransactionId: transactionId
      }
    ]
  );
  return rowToIntent(await releaseQuotePaymentSurplusInTransaction(client, updated.rows[0]));
}

async function markQuotePaymentActivatedInTransaction(client: pg.PoolClient, input: { quoteId: string; userId: string; ticketId: string }) {
  const result = await client.query<QuotePaymentIntentRow>(
    `
      UPDATE quote_payment_intents
      SET
        status = 'activated',
        ticket_id = $3,
        activated_at = COALESCE(activated_at, now()),
        activation_claim_token = NULL,
        activation_lease_expires_at = NULL,
        updated_at = now()
      WHERE quote_id = $1
        AND user_id = $2
        AND status IN ('activating', 'confirmed', 'activated')
      RETURNING *
    `,
    [input.quoteId, input.userId, input.ticketId]
  );
  if (!result.rows[0]) throw new Error("payment_intent_not_confirmed");
  await client.query(
    `
      UPDATE quote_payment_exposure_reservations
      SET status = 'consumed', updated_at = now()
      WHERE payment_intent_id = $1
        AND status IN ('reserved', 'expired')
    `,
    [result.rows[0].id]
  );
  return rowToIntent(result.rows[0]);
}

export async function prepareQuotePaymentCheckoutFundsForActivation(input: { quoteId: string; userId: string }) {
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    await assertFinancialGateOpenInTransaction(client, { operation: "direct_pay_activation.prepare" });
    const prepared = await prepareQuotePaymentCheckoutFundsForActivationInTransaction(client, input);
    await client.query("COMMIT");
    committed = true;
    return prepared;
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function activateQuotePaymentWithFinalQuote(input: {
  quoteId: string;
  userId: string;
  activationClaimToken: string;
  finalQuote: QuoteResponse;
  evidenceByLegId?: FinalQuoteEvidenceByLegId;
  exposureLimits?: PaymentExposureLimits;
  validateSettlementIdentity?: AcceptQuoteOptions["validateSettlementIdentity"];
  assertFinancialGateOpenInTransaction?: typeof assertFinancialGateOpenInTransaction;
  assertWorkerHeartbeatsHealthyInTransaction?: typeof assertWorkerHeartbeatsHealthyInTransaction;
  requiredWorkerNames?: readonly string[];
  workerHeartbeatMaxAgeMs?: number;
  workerSuccessMaxAgeMs?: number;
  now?: Date;
}): Promise<AcceptedTicket> {
  const client = await getPool().connect();
  let committed = false;
  const now = input.now || new Date();

  try {
    await client.query("BEGIN");
    await (input.assertFinancialGateOpenInTransaction || assertFinancialGateOpenInTransaction)(client, {
      operation: "direct_pay_activation",
      now
    });
    if (input.requiredWorkerNames?.length) {
      await (input.assertWorkerHeartbeatsHealthyInTransaction || assertWorkerHeartbeatsHealthyInTransaction)(
        client,
        input.requiredWorkerNames,
        {
          now,
          maxAgeMs: input.workerHeartbeatMaxAgeMs,
          successMaxAgeMs: input.workerSuccessMaxAgeMs
        }
      );
    }
    const intentResult = await client.query<QuotePaymentIntentRow>(
      `
        SELECT *
        FROM quote_payment_intents
        WHERE quote_id = $1
          AND user_id = $2
        FOR UPDATE
      `,
      [input.quoteId, input.userId]
    );
    const intent = intentResult.rows[0];
    if (!intent) throw new Error("payment_intent_not_found");
    if (intent.status === "activated" && intent.ticket_id) {
      await client.query("COMMIT");
      committed = true;
      return {
        ticketId: intent.ticket_id,
        quoteId: intent.final_quote_id || input.finalQuote.id,
        status: "accepted",
        ledgerTransactionId: "",
        accountingMode: "house_book_usdc",
        currency: "USDC"
      };
    }
    if (intent.status !== "activating" || intent.activation_claim_token !== input.activationClaimToken) {
      throw new Error("payment_activation_claim_conflict");
    }
    const deadline = intent.activation_deadline_at || intent.tracking_deadline_at || intent.expires_at;
    if (deadline && deadline.getTime() <= now.getTime()) {
      await markIntentRecoverableInTransaction(client, {
        intent,
        reason: "late_confirmation",
        detail: "Confirmed payment was not activated before the activation deadline.",
        finalPayoutMicroUsd: microUsd(input.finalQuote.potentialPayoutUsd)
      });
      await client.query("COMMIT");
      committed = true;
      throw new Error("late_confirmation");
    }

    const finalIntent = await persistFinalQuoteForQuotePaymentInTransaction(client, {
      quoteId: input.quoteId,
      userId: input.userId,
      finalQuote: input.finalQuote,
      evidenceByLegId: input.evidenceByLegId,
      expectedStatus: "activating",
      activationClaimToken: input.activationClaimToken
    });
    const finalQuoteId = finalIntent.finalQuoteId || input.finalQuote.id;
    const finalPayoutMicroUsd = BigInt(microUsd(input.finalQuote.potentialPayoutUsd));
    const finalStakeMicroUsd = BigInt(microUsd(input.finalQuote.stakeUsd));
    const finalLiabilityMicroUsd = finalPayoutMicroUsd > finalStakeMicroUsd ? finalPayoutMicroUsd - finalStakeMicroUsd : 0n;

    await revalueSoftExposureReservationForActivation(client, {
      paymentIntentId: intent.id,
      finalQuoteId,
      userId: input.userId,
      liabilityMicroUsd: finalLiabilityMicroUsd,
      expiresAt: deadline || new Date(now.getTime() + paymentActivationLeaseMs)
    });

    await prepareQuotePaymentCheckoutFundsForActivationInTransaction(client, {
      quoteId: input.quoteId,
      userId: input.userId,
      expectedStatus: "activating",
      activationClaimToken: input.activationClaimToken
    });

    const ticket = await acceptQuoteInTransaction(client, finalQuoteId, input.userId, {
      accountingMode: "house_book_usdc",
      currency: "USDC",
      maxUserLiabilityUsd: input.exposureLimits?.maxUserLiabilityUsd,
      maxMarketLiabilityUsd: input.exposureLimits?.maxMarketLiabilityUsd ?? config.MAX_MARKET_LIABILITY_USD,
      maxEventLiabilityUsd: input.exposureLimits?.maxEventLiabilityUsd ?? config.MAX_EVENT_LIABILITY_USD,
      includeSoftReservations: true,
      excludePaymentIntentId: intent.id,
      requireSettlementIdentity: true,
      validateSettlementIdentity: input.validateSettlementIdentity
    });

    await markQuotePaymentActivatedInTransaction(client, {
      quoteId: input.quoteId,
      userId: input.userId,
      ticketId: ticket.ticketId
    });

    await client.query("COMMIT");
    committed = true;
    return ticket;
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function restoreQuotePaymentCheckoutFundsAfterActivationFailure(input: { quoteId: string; userId: string }) {
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const intentResult = await client.query<QuotePaymentIntentRow>(
      `
        SELECT *
        FROM quote_payment_intents
        WHERE quote_id = $1
          AND user_id = $2
        FOR UPDATE
      `,
      [input.quoteId, input.userId]
    );
    const intent = intentResult.rows[0];
    if (!intent || intent.status !== "confirmed" || !intent.activation_funding_transaction_id) {
      await client.query("COMMIT");
      committed = true;
      return intent ? rowToIntent(intent) : undefined;
    }

    const amountDue = BigInt(intent.amount_micro_units);
    const checkoutAccountId = await ensureLedgerAccount(client, input.userId, "user_usdc_checkout", "USDC");
    const availableAccountId = await ensureLedgerAccount(client, input.userId, "user_usdc_available", "USDC");
    for (const accountId of [checkoutAccountId, availableAccountId].sort()) {
      await client.query("SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE", [accountId]);
    }
    const availableBalance = await ledgerBalanceMicroUnits(client, availableAccountId);
    if (availableBalance < amountDue) {
      throw new Error("payment_activation_funding_restore_insufficient");
    }

    const transactionId = randomUUID();
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, 'USDC', 'quote payment restored to checkout after activation failure'),
          ($1, $4, $5, 'USDC', 'quote payment restored to checkout after activation failure')
      `,
      [transactionId, availableAccountId, (-amountDue).toString(), checkoutAccountId, amountDue.toString()]
    );
    const updated = await client.query<QuotePaymentIntentRow>(
      `
        UPDATE quote_payment_intents
        SET
          activation_funding_transaction_id = NULL,
          updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [intent.id]
    );
    await client.query(
      `
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'payment.checkout_restored_after_activation_failure', 'quote_payment_intent', $2, $3)
      `,
      [
        input.userId,
        intent.id,
        {
          quoteId: input.quoteId,
          amountMicroUnits: amountDue.toString(),
          ledgerTransactionId: transactionId,
          originalActivationFundingTransactionId: intent.activation_funding_transaction_id
        }
      ]
    );
    await client.query("COMMIT");
    committed = true;
    return rowToIntent(updated.rows[0]);
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
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
        AND status IN ('confirmed', 'activating', 'activated')
      RETURNING *
    `,
    [input.quoteId, input.userId, input.ticketId]
  );
  if (!result.rows[0]) throw new Error("payment_intent_not_confirmed");
  await getPool().query(
    `
      UPDATE quote_payment_exposure_reservations
      SET status = 'consumed', updated_at = now()
      WHERE payment_intent_id = $1
        AND status IN ('reserved', 'expired')
    `,
    [result.rows[0].id]
  );
  return rowToIntent(result.rows[0]);
}

export async function markQuotePaymentRecoverable(input: {
  quoteId: string;
  userId: string;
  reason: PaymentRecoveryReason;
  detail?: string;
  finalQuoteId?: string;
  finalPayoutMicroUsd?: string | number | bigint;
}) {
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const intentResult = await client.query<QuotePaymentIntentRow>(
      `
        SELECT *
        FROM quote_payment_intents
        WHERE quote_id = $1
          AND user_id = $2
        FOR UPDATE
      `,
      [input.quoteId, input.userId]
    );
    const intent = intentResult.rows[0];
    if (!intent) throw new Error("payment_intent_not_found");

    const recovered = await markIntentRecoverableInTransaction(client, {
      intent,
      reason: input.reason,
      detail: input.detail,
      finalQuoteId: input.finalQuoteId,
      finalPayoutMicroUsd: input.finalPayoutMicroUsd
    });
    await client.query("COMMIT");
    committed = true;
    return rowToIntent(recovered);
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markQuotePaymentFailed(input: { quoteId: string; userId: string; reason: string }) {
  return markQuotePaymentRecoverable({
    quoteId: input.quoteId,
    userId: input.userId,
    reason: "activation_failed",
    detail: input.reason
  });
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
    submission_deadline_at: Date;
    tracking_deadline_at: Date | null;
    max_adverse_bps: number;
    estimated_payout_micro_usd: string;
    min_final_payout_micro_usd: string;
    final_payout_micro_usd: string | null;
    final_quote_id: string | null;
    amount_received_micro_units: string;
    surplus_micro_units: string;
    checkout_ledger_transaction_id: string | null;
    activation_funding_transaction_id: string | null;
    activation_deadline_at: Date | null;
    activation_claim_token: string | null;
    activation_claimed_at: Date | null;
    activation_lease_expires_at: Date | null;
    recovery_reason: PaymentRecoveryReason | null;
    recovery_detail: string | null;
    submitted_at: Date | null;
    confirmed_at: Date | null;
    activated_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `
      SELECT *
      FROM quote_payment_intents
      WHERE user_id = $1
        AND chain_id = $2
        AND treasury_address = $3
        AND usdc_contract_address = $4
        AND status IN ('submitted', 'expired')
        AND tx_hash = $5
        AND onchain_deposit_id IS NULL
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `,
    [input.userId, input.chainId, toAddress, tokenAddress, txHash]
  );
  const intent = result.rows[0];
  if (!intent) return undefined;

  const credited = await creditQuotePaymentCheckoutHold(client, {
    intent,
    depositId: input.depositId,
    walletId: input.walletId,
    amountMicroUnits: input.amountMicroUnits,
    confirmations: input.confirmations
  });

  return {
    paymentIntentId: intent.id,
    quoteId: intent.quote_id,
    userId: intent.user_id,
    ledgerTransactionId: credited.transactionId
  };
}
