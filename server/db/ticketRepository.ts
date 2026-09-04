import { randomUUID } from "node:crypto";
import type pg from "pg";
import { assertFinancialGateOpenInTransaction } from "../financialGate";
import { getPool } from "./client";
import {
  prepareTicketSettlementIdentities,
  validateAndFreezeTicketSettlementIdentitiesInTransaction,
  type FrozenSettlementIdentity,
  type SettlementIdentityValidation
} from "./settlementRepository";

export type AcceptedTicket = {
  ticketId: string;
  quoteId: string;
  status: "accepted";
  ledgerTransactionId: string;
  reserveTransactionId?: string;
  accountingMode: AccountingMode;
  currency: LedgerCurrency;
};

export type TicketDetail = {
  ticketId: string;
  quoteId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stakeUsd: number;
  operationFeeUsd: number;
  amountPaidUsd: number;
  potentialPayoutUsd: number;
  claimableAmountUsd: number;
  settlementPolicyReviewRequired: boolean;
  accountingMode: string;
  currency: string;
  purchaseTxHash?: string;
  purchaseChainId?: number;
  legs: Array<{
    ticketLegId: string;
    status: string;
    settledAt?: string;
    resolutionState?: string;
    resolutionUpdatedAt?: string;
    nextResolutionCheckAt?: string;
    lastResolutionError?: string;
    endDate?: string;
    question: string;
    outcome: string;
    marketUrl?: string;
  }>;
};

type ClaimableTicketCursor = {
  createdAt: string;
  ticketId: string;
};

export type ListClaimableTicketsInput = {
  cursor?: string;
  limit: number;
};

export type ClaimableTicketsPage = {
  tickets: Array<{
    ticketId: string;
    quoteId: string;
    status: "claimable";
    createdAt: string;
    updatedAt: string;
    stakeUsd: number;
    operationFeeUsd: number;
    amountPaidUsd: number;
    potentialPayoutUsd: number;
    claimableAmountUsd: number;
    accountingMode: string;
    currency: string;
    legs: number;
    legStatusCounts: {
      pending: number;
      won: number;
      lost: number;
      voided: number;
      disputed: number;
    };
  }>;
  pageInfo: {
    limit: number;
    hasMore: boolean;
    nextCursor?: string;
  };
};

export type AcceptQuoteOptions = {
  accountingMode?: AccountingMode;
  currency?: LedgerCurrency;
  allowExpiredQuote?: boolean;
  includeSoftReservations?: boolean;
  excludePaymentIntentId?: string;
  requireSettlementIdentity?: boolean;
  validateSettlementIdentity?: (identity: FrozenSettlementIdentity) => Promise<SettlementIdentityValidation>;
  assertFinancialGateOpenInTransaction?: typeof assertFinancialGateOpenInTransaction;
  maxUserLiabilityUsd?: number;
  maxMarketLiabilityUsd: number;
  maxEventLiabilityUsd: number;
};

type AccountingMode = "play_money" | "house_book_usdc";
type LedgerCurrency = "USD" | "USDC";

class QuoteExpiredAfterStatusUpdate extends Error {
  constructor() {
    super("quote_expired");
  }
}

function microUsdToUsd(value: string | number | bigint | null) {
  return Number(BigInt(value || 0)) / 1_000_000;
}

function claimableAmountUsd(status: string, offeredPayoutMicroUsd: string, finalPayoutMicroUsd?: string | null) {
  if (status !== "claimable" && status !== "paid") return 0;
  return microUsdToUsd(finalPayoutMicroUsd ?? offeredPayoutMicroUsd);
}

const cursorTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function isCanonicalCursorTimestamp(value: string) {
  const match = cursorTimestampPattern.exec(value);
  if (!match) return false;

  const [, year, month, day, hour, minute, second, microseconds] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${microseconds.slice(0, 3)}Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second)
  );
}

const ticketIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseClaimableTicketsCursor(cursor: string): ClaimableTicketCursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    throw new Error("invalid_claimable_ticket_cursor");
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      Object.keys(parsed).length !== 2 ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.ticketId !== "string" ||
      !isCanonicalCursorTimestamp(parsed.createdAt) ||
      !ticketIdPattern.test(parsed.ticketId)
    ) {
      throw new Error("invalid_claimable_ticket_cursor");
    }

    const canonical = encodeClaimableTicketsCursor({
      createdAt: parsed.createdAt,
      ticketId: parsed.ticketId
    });
    if (canonical !== cursor) {
      throw new Error("invalid_claimable_ticket_cursor");
    }

    return {
      createdAt: parsed.createdAt,
      ticketId: parsed.ticketId
    };
  } catch {
    throw new Error("invalid_claimable_ticket_cursor");
  }
}

function encodeClaimableTicketsCursor(cursor: ClaimableTicketCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function usdLimitToMicroUnits(value: number, label: string) {
  const scaled = Math.round(value * 1_000_000);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(scaled)) {
    throw new Error(`invalid_exposure_limit:${label}`);
  }
  return BigInt(scaled);
}

async function ensureLedgerAccount(client: pg.PoolClient, userId: string | null, accountType: string, currency: string) {
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

  if (!existing.rows[0]) {
    throw new Error(`Unable to create ledger account ${accountType}:${currency}`);
  }

  return existing.rows[0].id;
}

async function existingTicket(client: pg.PoolClient, quoteId: string, userId: string) {
  const result = await client.query<AcceptedTicket>(
    `
      SELECT
        tickets.id AS "ticketId",
        tickets.quote_id AS "quoteId",
        tickets.status AS "status",
        COALESCE(audit_log.metadata->>'ledgerTransactionId', '') AS "ledgerTransactionId",
        NULLIF(audit_log.metadata->>'reserveTransactionId', '') AS "reserveTransactionId",
        tickets.accounting_mode AS "accountingMode",
        tickets.funding_currency AS "currency"
      FROM tickets
      LEFT JOIN audit_log
        ON audit_log.entity_id = tickets.id
        AND audit_log.action = 'quote.accepted'
      WHERE tickets.quote_id = $1
        AND tickets.user_id = $2
      LIMIT 1
    `,
    [quoteId, userId]
  );

  return result.rows[0];
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

function accountTypes(accountingMode: AccountingMode) {
  if (accountingMode === "house_book_usdc") {
    return {
      userAvailable: "user_usdc_available",
      houseOperating: "house_usdc_operating",
      houseReserve: "house_usdc_reserve"
    };
  }

  return {
    userAvailable: "play_money",
    houseOperating: "house_play_money",
    houseReserve: "house_play_money_reserve"
  };
}

async function enforceFundingCapacity(
  client: pg.PoolClient,
  input: {
    accountingMode: AccountingMode;
    userAccountId: string;
    houseOperatingAccountId: string;
    houseReserveAccountId: string;
    amountDueMicroUnits: bigint;
    netLiabilityMicroUnits: bigint;
  }
) {
  if (input.accountingMode !== "house_book_usdc") return;

  const accountIds = [input.userAccountId, input.houseOperatingAccountId, input.houseReserveAccountId].sort();
  for (const accountId of accountIds) {
    await client.query("SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE", [accountId]);
  }

  const userBalance = await ledgerBalanceMicroUnits(client, input.userAccountId);
  if (userBalance < input.amountDueMicroUnits) {
    throw new Error("insufficient_user_balance");
  }

  const houseOperatingBalance = await ledgerBalanceMicroUnits(client, input.houseOperatingAccountId);
  if (houseOperatingBalance < input.netLiabilityMicroUnits) {
    throw new Error("insufficient_house_reserve");
  }
}

async function enforceAcceptExposureLimits(
  client: pg.PoolClient,
  userId: string,
  quoteId: string,
  incrementalLiabilityMicroUsd: bigint,
  options?: AcceptQuoteOptions
) {
  if (!options) return;

  const legs = await client.query<{
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

  const lockKeys = [
    ...new Set([
      `user:${userId}`,
      ...legs.rows.map((leg) => `market:${leg.source_market_id}:${leg.outcome}`),
      ...legs.rows.map((leg) => `event:${leg.market_url}`)
    ])
  ].sort();

  for (const lockKey of lockKeys) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  }

  const includeSoftReservations = options.includeSoftReservations === true;
  const excludedPaymentIntentId = options.excludePaymentIntentId || null;
  const marketExposure = await client.query<{
    source_market_id: string;
    outcome: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      WITH quote_targets AS (
        SELECT markets.source_market_id, quote_legs.outcome
        FROM quote_legs
        JOIN markets ON markets.id = quote_legs.market_id
        WHERE quote_legs.quote_id = $1
      ),
      hard AS (
        SELECT open_market_exposure.source_market_id, open_market_exposure.outcome, open_market_exposure.worst_case_liability_micro_usd::BIGINT AS exposure
        FROM open_market_exposure
        JOIN quote_targets
          ON quote_targets.source_market_id = open_market_exposure.source_market_id
          AND quote_targets.outcome = open_market_exposure.outcome
      ),
      soft AS (
        SELECT
          markets.source_market_id,
          quote_legs.outcome,
          sum(quote_payment_exposure_reservations.liability_micro_usd)::BIGINT AS exposure
        FROM quote_payment_exposure_reservations
        JOIN quote_legs ON quote_legs.quote_id = quote_payment_exposure_reservations.quote_id
        JOIN markets ON markets.id = quote_legs.market_id
        JOIN quote_targets
          ON quote_targets.source_market_id = markets.source_market_id
          AND quote_targets.outcome = quote_legs.outcome
        WHERE $2::boolean
          AND quote_payment_exposure_reservations.status = 'reserved'
          AND quote_payment_exposure_reservations.expires_at > now()
          AND ($3::uuid IS NULL OR quote_payment_exposure_reservations.payment_intent_id <> $3)
        GROUP BY markets.source_market_id, quote_legs.outcome
      )
      SELECT source_market_id, outcome, sum(exposure)::text AS worst_case_liability_micro_usd
      FROM (
        SELECT * FROM hard
        UNION ALL
        SELECT * FROM soft
      ) exposure
      GROUP BY source_market_id, outcome
    `,
    [quoteId, includeSoftReservations, excludedPaymentIntentId]
  );
  const marketExposureByKey = new Map(
    marketExposure.rows.map((row) => [`${row.source_market_id}:${row.outcome}`, BigInt(row.worst_case_liability_micro_usd)])
  );
  const maxMarketLiabilityMicroUsd = usdLimitToMicroUnits(options.maxMarketLiabilityUsd, "market");

  for (const leg of legs.rows) {
    const currentExposureMicroUsd = marketExposureByKey.get(`${leg.source_market_id}:${leg.outcome}`) || 0n;
    if (currentExposureMicroUsd + incrementalLiabilityMicroUsd > maxMarketLiabilityMicroUsd) {
      throw new Error("quote_exposure_limit:market");
    }
  }

  const eventExposure = await client.query<{
    market_url: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      WITH quote_targets AS (
        SELECT markets.market_url
        FROM quote_legs
        JOIN markets ON markets.id = quote_legs.market_id
        WHERE quote_legs.quote_id = $1
      ),
      hard AS (
        SELECT open_event_exposure.market_url, open_event_exposure.worst_case_liability_micro_usd::BIGINT AS exposure
        FROM open_event_exposure
        JOIN quote_targets ON quote_targets.market_url = open_event_exposure.market_url
      ),
      soft AS (
        SELECT
          markets.market_url,
          sum(quote_payment_exposure_reservations.liability_micro_usd)::BIGINT AS exposure
        FROM quote_payment_exposure_reservations
        JOIN quote_legs ON quote_legs.quote_id = quote_payment_exposure_reservations.quote_id
        JOIN markets ON markets.id = quote_legs.market_id
        JOIN quote_targets ON quote_targets.market_url = markets.market_url
        WHERE $2::boolean
          AND quote_payment_exposure_reservations.status = 'reserved'
          AND quote_payment_exposure_reservations.expires_at > now()
          AND ($3::uuid IS NULL OR quote_payment_exposure_reservations.payment_intent_id <> $3)
        GROUP BY markets.market_url
      )
      SELECT market_url, sum(exposure)::text AS worst_case_liability_micro_usd
      FROM (
        SELECT * FROM hard
        UNION ALL
        SELECT * FROM soft
      ) exposure
      GROUP BY market_url
    `,
    [quoteId, includeSoftReservations, excludedPaymentIntentId]
  );
  const eventExposureByUrl = new Map(eventExposure.rows.map((row) => [row.market_url, BigInt(row.worst_case_liability_micro_usd)]));
  const maxEventLiabilityMicroUsd = usdLimitToMicroUnits(options.maxEventLiabilityUsd, "event");

  for (const marketUrl of new Set(legs.rows.map((leg) => leg.market_url))) {
    const currentExposureMicroUsd = eventExposureByUrl.get(marketUrl) || 0n;
    if (currentExposureMicroUsd + incrementalLiabilityMicroUsd > maxEventLiabilityMicroUsd) {
      throw new Error("quote_exposure_limit:event");
    }
  }

  if (options.maxUserLiabilityUsd !== undefined) {
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
          WHERE $2::boolean
            AND user_id = $1
            AND status = 'reserved'
            AND expires_at > now()
            AND ($3::uuid IS NULL OR payment_intent_id <> $3)
        )
        SELECT (COALESCE((SELECT exposure FROM hard), 0) + COALESCE((SELECT exposure FROM soft), 0))::text
          AS worst_case_liability_micro_usd
      `,
      [userId, includeSoftReservations, excludedPaymentIntentId]
    );
    const currentExposureMicroUsd = BigInt(userExposure.rows[0]?.worst_case_liability_micro_usd || 0);
    const maxUserLiabilityMicroUsd = usdLimitToMicroUnits(options.maxUserLiabilityUsd, "user");
    if (currentExposureMicroUsd + incrementalLiabilityMicroUsd > maxUserLiabilityMicroUsd) {
      throw new Error("quote_exposure_limit:user");
    }
  }
}

export async function acceptQuoteInTransaction(client: pg.PoolClient, quoteId: string, userId: string, options?: AcceptQuoteOptions): Promise<AcceptedTicket> {
  const accountingMode = options?.accountingMode || "play_money";
  const currency: LedgerCurrency = options?.currency || (accountingMode === "house_book_usdc" ? "USDC" : "USD");
  if (accountingMode === "house_book_usdc" && currency !== "USDC") {
    throw new Error("invalid_house_book_currency");
  }
  if (accountingMode === "house_book_usdc") {
    await (options?.assertFinancialGateOpenInTransaction || assertFinancialGateOpenInTransaction)(client, {
      operation: "ticket_accept"
    });
  }

  const quoteResult = await client.query<{
    id: string;
    status: "quoted" | "accepted" | "expired" | "rejected";
    user_id: string | null;
    stake_micro_usd: string;
    operation_fee_micro_usd: string;
    offered_payout_micro_usd: string;
    risk_decision: "accept" | "review" | "reject";
    expires_at: Date;
  }>(
    `
      SELECT
        id,
        status,
        user_id,
        stake_micro_usd::text,
        operation_fee_micro_usd::text,
        offered_payout_micro_usd::text,
        risk_decision,
        expires_at
      FROM quotes
      WHERE id = $1
      FOR UPDATE
    `,
    [quoteId]
  );

  const quote = quoteResult.rows[0];
  if (!quote) {
    throw new Error("quote_not_found");
  }

  if (quote.user_id && quote.user_id !== userId) {
    throw new Error("quote_not_found");
  }

  if (quote.status === "accepted") {
    const ticket = await existingTicket(client, quoteId, userId);
    if (ticket) return ticket;
  }

  if (quote.status !== "quoted" && !(options?.allowExpiredQuote && quote.status === "expired")) {
    throw new Error(`quote_not_acceptable:${quote.status}`);
  }

  if (!options?.allowExpiredQuote && quote.expires_at.getTime() <= Date.now()) {
    await client.query("UPDATE quotes SET status = 'expired' WHERE id = $1", [quoteId]);
    throw new QuoteExpiredAfterStatusUpdate();
  }

  if (accountingMode === "house_book_usdc" && quote.risk_decision !== "accept") {
    throw new Error(`quote_requires_review:${quote.risk_decision}`);
  }

  const accounts = accountTypes(accountingMode);
  const userAccountId = await ensureLedgerAccount(client, userId, accounts.userAvailable, currency);
  const houseAccountId = await ensureLedgerAccount(client, null, accounts.houseOperating, currency);
  const houseReserveAccountId = await ensureLedgerAccount(client, null, accounts.houseReserve, currency);
  const ticketId = randomUUID();
  const transactionId = randomUUID();
  const reserveTransactionId = randomUUID();
  const stakeMicroUsd = BigInt(quote.stake_micro_usd);
  const operationFeeMicroUsd = BigInt(quote.operation_fee_micro_usd);
  const offeredPayoutMicroUsd = BigInt(quote.offered_payout_micro_usd);
  const amountDue = stakeMicroUsd + operationFeeMicroUsd;
  const netLiability = offeredPayoutMicroUsd > stakeMicroUsd ? offeredPayoutMicroUsd - stakeMicroUsd : 0n;

  await enforceFundingCapacity(client, {
    accountingMode,
    userAccountId,
    houseOperatingAccountId: houseAccountId,
    houseReserveAccountId,
    amountDueMicroUnits: amountDue,
    netLiabilityMicroUnits: netLiability
  });
  await enforceAcceptExposureLimits(client, userId, quoteId, netLiability, options);

  await client.query("UPDATE quotes SET status = 'accepted', accepted_at = now(), user_id = $2 WHERE id = $1", [quoteId, userId]);
  await client.query(
    `
      INSERT INTO tickets (id, user_id, quote_id, status, accounting_mode, funding_currency)
      VALUES ($1, $2, $3, 'accepted', $4, $5)
    `,
    [ticketId, userId, quoteId, accountingMode, currency]
  );
  await client.query(
    `
      INSERT INTO ticket_legs (ticket_id, quote_leg_id, status, accepted_price_bps)
      SELECT $1, quote_legs.id, 'pending', quote_legs.quoted_price_bps
      FROM quote_legs
      WHERE quote_legs.quote_id = $2
    `,
    [ticketId, quoteId]
  );

  let identities: FrozenSettlementIdentity[] = [];
  if (options?.requireSettlementIdentity) {
    const candidates = await prepareTicketSettlementIdentities(client, { ticketId });
    identities = await validateAndFreezeTicketSettlementIdentitiesInTransaction(client, {
      ticketId,
      candidateIdentities: candidates,
      validateCandidateIdentity: options.validateSettlementIdentity
    });
  }

  await client.query(
    `
      INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
      VALUES
        ($1, $2, $3, $6, 'quote accepted'),
        ($1, $4, $5, $6, 'quote accepted')
    `,
    [transactionId, userAccountId, (-amountDue).toString(), houseAccountId, amountDue.toString(), currency]
  );
  if (netLiability > 0n) {
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, $5, 'ticket liability reserved'),
          ($1, $4, $6, $5, 'ticket liability reserved')
      `,
      [reserveTransactionId, houseAccountId, (-netLiability).toString(), houseReserveAccountId, currency, netLiability.toString()]
    );
  }
  await client.query(
    `
      INSERT INTO ticket_reserves (
        ticket_id,
        user_id,
        accounting_mode,
        currency,
        stake_micro_units,
        operation_fee_micro_units,
        offered_payout_micro_units,
        net_liability_micro_units,
        status,
        purchase_transaction_id,
        reserve_transaction_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $10)
    `,
    [
      ticketId,
      userId,
      accountingMode,
      currency,
      stakeMicroUsd.toString(),
      operationFeeMicroUsd.toString(),
      offeredPayoutMicroUsd.toString(),
      netLiability.toString(),
      transactionId,
      netLiability > 0n ? reserveTransactionId : null
    ]
  );
  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'quote.accepted', 'ticket', $2, $3)
    `,
    [
      userId,
      ticketId,
      {
        quoteId,
        ledgerTransactionId: transactionId,
        reserveTransactionId: netLiability > 0n ? reserveTransactionId : null,
        accountingMode,
        currency,
        amountDueMicroUnits: amountDue.toString(),
        netLiabilityMicroUnits: netLiability.toString(),
        settlementIdentityLegs: identities.length
      }
    ]
  );

  return {
    ticketId,
    quoteId,
    status: "accepted",
    ledgerTransactionId: transactionId,
    reserveTransactionId: netLiability > 0n ? reserveTransactionId : undefined,
    accountingMode,
    currency
  };
}

export async function acceptQuote(quoteId: string, userId: string, options?: AcceptQuoteOptions): Promise<AcceptedTicket> {
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const ticket = await acceptQuoteInTransaction(client, quoteId, userId, options);
    await client.query("COMMIT");
    committed = true;
    return ticket;
  } catch (error) {
    if (error instanceof QuoteExpiredAfterStatusUpdate) {
      await client.query("COMMIT");
      committed = true;
      throw new Error("quote_expired");
    }
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listTickets(userId: string) {
  const result = await getPool().query<{
    ticketId: string;
    quoteId: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    stakeMicroUsd: string;
    operationFeeMicroUsd: string;
    potentialPayoutMicroUsd: string;
    accountingMode: string;
    currency: string;
    legs: string;
    pendingLegs: string;
    wonLegs: string;
    lostLegs: string;
    voidedLegs: string;
    disputedLegs: string;
    finalPayoutMicroUsd: string | null;
    settlementPolicyReviewRequired: boolean;
  }>(
    `
      SELECT
        tickets.id AS "ticketId",
        tickets.quote_id AS "quoteId",
        tickets.status,
        tickets.created_at AS "createdAt",
        tickets.updated_at AS "updatedAt",
        COALESCE(ticket_reserves.stake_micro_units, quotes.stake_micro_usd)::text AS "stakeMicroUsd",
        COALESCE(ticket_reserves.operation_fee_micro_units, quotes.operation_fee_micro_usd)::text AS "operationFeeMicroUsd",
        COALESCE(ticket_reserves.offered_payout_micro_units, quotes.offered_payout_micro_usd)::text AS "potentialPayoutMicroUsd",
        tickets.accounting_mode AS "accountingMode",
        tickets.funding_currency AS "currency",
        count(ticket_legs.id)::text AS legs,
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'pending')::text AS "pendingLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'won')::text AS "wonLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'lost')::text AS "lostLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'voided')::text AS "voidedLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'disputed')::text AS "disputedLegs",
        ticket_settlement_summaries.final_payout_micro_units::text AS "finalPayoutMicroUsd",
        (ticket_settlement_policy_quarantines.id IS NOT NULL) AS "settlementPolicyReviewRequired"
      FROM tickets
      JOIN quotes ON quotes.id = tickets.quote_id
      LEFT JOIN ticket_reserves ON ticket_reserves.ticket_id = tickets.id
      LEFT JOIN ticket_legs ON ticket_legs.ticket_id = tickets.id
      LEFT JOIN ticket_settlement_summaries ON ticket_settlement_summaries.ticket_id = tickets.id
      LEFT JOIN ticket_settlement_policy_quarantines
        ON ticket_settlement_policy_quarantines.ticket_id = tickets.id
        AND ticket_settlement_policy_quarantines.resolved_at IS NULL
      WHERE tickets.user_id = $1
      GROUP BY tickets.id, quotes.id, ticket_reserves.id, ticket_settlement_summaries.id,
        ticket_settlement_policy_quarantines.id
      ORDER BY tickets.created_at DESC
      LIMIT 50
    `,
    [userId]
  );

  return result.rows.map((row) => ({
    ticketId: row.ticketId,
    quoteId: row.quoteId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stakeUsd: microUsdToUsd(row.stakeMicroUsd),
    operationFeeUsd: microUsdToUsd(row.operationFeeMicroUsd),
    amountPaidUsd: microUsdToUsd(BigInt(row.stakeMicroUsd) + BigInt(row.operationFeeMicroUsd)),
    potentialPayoutUsd: microUsdToUsd(row.potentialPayoutMicroUsd),
    claimableAmountUsd: row.settlementPolicyReviewRequired
      ? 0
      : claimableAmountUsd(row.status, row.potentialPayoutMicroUsd, row.finalPayoutMicroUsd),
    settlementPolicyReviewRequired: Boolean(row.settlementPolicyReviewRequired),
    accountingMode: row.accountingMode,
    currency: row.currency,
    legs: Number(row.legs),
    legStatusCounts: {
      pending: Number(row.pendingLegs),
      won: Number(row.wonLegs),
      lost: Number(row.lostLegs),
      voided: Number(row.voidedLegs),
      disputed: Number(row.disputedLegs)
    }
  }));
}

export async function listClaimableTickets(userId: string, input: ListClaimableTicketsInput): Promise<ClaimableTicketsPage> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("invalid_claimable_ticket_limit");
  }

  const cursor = input.cursor ? parseClaimableTicketsCursor(input.cursor) : undefined;
  const result = await getPool().query<{
    ticketId: string;
    quoteId: string;
    status: "claimable";
    createdAt: Date;
    cursorCreatedAt: string;
    updatedAt: Date;
    stakeMicroUsd: string;
    operationFeeMicroUsd: string;
    potentialPayoutMicroUsd: string;
    accountingMode: string;
    currency: string;
    legs: string;
    pendingLegs: string;
    wonLegs: string;
    lostLegs: string;
    voidedLegs: string;
    disputedLegs: string;
    finalPayoutMicroUsd: string | null;
  }>(
    `
      SELECT
        tickets.id AS "ticketId",
        tickets.quote_id AS "quoteId",
        tickets.status,
        tickets.created_at AS "createdAt",
        to_char(tickets.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt",
        tickets.updated_at AS "updatedAt",
        COALESCE(ticket_reserves.stake_micro_units, quotes.stake_micro_usd)::text AS "stakeMicroUsd",
        COALESCE(ticket_reserves.operation_fee_micro_units, quotes.operation_fee_micro_usd)::text AS "operationFeeMicroUsd",
        COALESCE(ticket_reserves.offered_payout_micro_units, quotes.offered_payout_micro_usd)::text AS "potentialPayoutMicroUsd",
        tickets.accounting_mode AS "accountingMode",
        tickets.funding_currency AS "currency",
        count(ticket_legs.id)::text AS legs,
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'pending')::text AS "pendingLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'won')::text AS "wonLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'lost')::text AS "lostLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'voided')::text AS "voidedLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'disputed')::text AS "disputedLegs",
        ticket_settlement_summaries.final_payout_micro_units::text AS "finalPayoutMicroUsd"
      FROM tickets
      JOIN quotes ON quotes.id = tickets.quote_id
      LEFT JOIN ticket_reserves ON ticket_reserves.ticket_id = tickets.id
      LEFT JOIN ticket_legs ON ticket_legs.ticket_id = tickets.id
      LEFT JOIN ticket_settlement_summaries ON ticket_settlement_summaries.ticket_id = tickets.id
      LEFT JOIN ticket_settlement_policy_quarantines
        ON ticket_settlement_policy_quarantines.ticket_id = tickets.id
        AND ticket_settlement_policy_quarantines.resolved_at IS NULL
      WHERE tickets.user_id = $1
        AND tickets.status = 'claimable'
        AND ticket_settlement_policy_quarantines.id IS NULL
        AND (
          $2::timestamptz IS NULL
          OR tickets.created_at < $2::timestamptz
          OR (tickets.created_at = $2::timestamptz AND tickets.id < $3::uuid)
        )
      GROUP BY tickets.id, quotes.id, ticket_reserves.id, ticket_settlement_summaries.id
      ORDER BY tickets.created_at DESC, tickets.id DESC
      LIMIT $4
    `,
    [userId, cursor?.createdAt || null, cursor?.ticketId || null, input.limit + 1]
  );

  const hasMore = result.rows.length > input.limit;
  const pageRows = result.rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);

  return {
    tickets: pageRows.map((row) => ({
      ticketId: row.ticketId,
      quoteId: row.quoteId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      stakeUsd: microUsdToUsd(row.stakeMicroUsd),
      operationFeeUsd: microUsdToUsd(row.operationFeeMicroUsd),
      amountPaidUsd: microUsdToUsd(BigInt(row.stakeMicroUsd) + BigInt(row.operationFeeMicroUsd)),
      potentialPayoutUsd: microUsdToUsd(row.potentialPayoutMicroUsd),
      claimableAmountUsd: claimableAmountUsd(row.status, row.potentialPayoutMicroUsd, row.finalPayoutMicroUsd),
      accountingMode: row.accountingMode,
      currency: row.currency,
      legs: Number(row.legs),
      legStatusCounts: {
        pending: Number(row.pendingLegs),
        won: Number(row.wonLegs),
        lost: Number(row.lostLegs),
        voided: Number(row.voidedLegs),
        disputed: Number(row.disputedLegs)
      }
    })),
    pageInfo: {
      limit: input.limit,
      hasMore,
      nextCursor: hasMore && lastRow ? encodeClaimableTicketsCursor({ createdAt: lastRow.cursorCreatedAt, ticketId: lastRow.ticketId }) : undefined
    }
  };
}

export async function getTicket(ticketId: string, userId: string): Promise<TicketDetail | undefined> {
  const ticketResult = await getPool().query<{
    ticketId: string;
    quoteId: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    stakeMicroUsd: string;
    operationFeeMicroUsd: string;
    potentialPayoutMicroUsd: string;
    accountingMode: string;
    currency: string;
    purchaseTxHash: string | null;
    purchaseChainId: number | null;
    finalPayoutMicroUsd: string | null;
    settlementPolicyReviewRequired: boolean;
  }>(
    `
      SELECT
        tickets.id AS "ticketId",
        tickets.quote_id AS "quoteId",
        tickets.status,
        tickets.created_at AS "createdAt",
        tickets.updated_at AS "updatedAt",
        COALESCE(ticket_reserves.stake_micro_units, quotes.stake_micro_usd)::text AS "stakeMicroUsd",
        COALESCE(ticket_reserves.operation_fee_micro_units, quotes.operation_fee_micro_usd)::text AS "operationFeeMicroUsd",
        COALESCE(ticket_reserves.offered_payout_micro_units, quotes.offered_payout_micro_usd)::text AS "potentialPayoutMicroUsd",
        tickets.accounting_mode AS "accountingMode",
        tickets.funding_currency AS "currency",
        purchase_payment.tx_hash AS "purchaseTxHash",
        purchase_payment.chain_id AS "purchaseChainId",
        ticket_settlement_summaries.final_payout_micro_units::text AS "finalPayoutMicroUsd",
        EXISTS (
          SELECT 1
          FROM ticket_settlement_policy_quarantines
          WHERE ticket_settlement_policy_quarantines.ticket_id = tickets.id
            AND ticket_settlement_policy_quarantines.resolved_at IS NULL
        ) AS "settlementPolicyReviewRequired"
      FROM tickets
      JOIN quotes ON quotes.id = tickets.quote_id
      LEFT JOIN ticket_reserves ON ticket_reserves.ticket_id = tickets.id
      LEFT JOIN ticket_settlement_summaries ON ticket_settlement_summaries.ticket_id = tickets.id
      LEFT JOIN LATERAL (
        SELECT quote_payment_intents.tx_hash, quote_payment_intents.chain_id
        FROM quote_payment_intents
        WHERE quote_payment_intents.ticket_id = tickets.id
          OR quote_payment_intents.quote_id = tickets.quote_id
        ORDER BY quote_payment_intents.activated_at DESC NULLS LAST, quote_payment_intents.updated_at DESC
        LIMIT 1
      ) AS purchase_payment ON true
      WHERE tickets.id = $1
        AND tickets.user_id = $2
      LIMIT 1
    `,
    [ticketId, userId]
  );

  const ticket = ticketResult.rows[0];
  if (!ticket) return undefined;

  const legsResult = await getPool().query<{
    ticketLegId: string;
    status: string;
    settledAt: Date | null;
    resolutionState: string;
    resolutionUpdatedAt: Date | null;
    nextResolutionCheckAt: Date | null;
    lastResolutionError: string | null;
    endDate: Date | null;
    question: string;
    outcome: string;
    marketUrl: string | null;
  }>(
    `
      SELECT
        ticket_legs.id AS "ticketLegId",
        ticket_legs.status,
        ticket_legs.settled_at AS "settledAt",
        ticket_legs.resolution_state AS "resolutionState",
        ticket_legs.resolution_updated_at AS "resolutionUpdatedAt",
        ticket_legs.next_resolution_check_at AS "nextResolutionCheckAt",
        ticket_legs.last_resolution_error AS "lastResolutionError",
        markets.end_date AS "endDate",
        markets.question,
        quote_legs.outcome,
        markets.market_url AS "marketUrl"
      FROM ticket_legs
      JOIN quote_legs ON quote_legs.id = ticket_legs.quote_leg_id
      JOIN markets ON markets.id = quote_legs.market_id
      WHERE ticket_legs.ticket_id = $1
      ORDER BY ticket_legs.created_at ASC
    `,
    [ticketId]
  );

  return {
    ticketId: ticket.ticketId,
    quoteId: ticket.quoteId,
    status: ticket.status,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    stakeUsd: Number(ticket.stakeMicroUsd) / 1_000_000,
    operationFeeUsd: Number(ticket.operationFeeMicroUsd) / 1_000_000,
    amountPaidUsd: microUsdToUsd(BigInt(ticket.stakeMicroUsd) + BigInt(ticket.operationFeeMicroUsd)),
    potentialPayoutUsd: Number(ticket.potentialPayoutMicroUsd) / 1_000_000,
    claimableAmountUsd: ticket.settlementPolicyReviewRequired
      ? 0
      : claimableAmountUsd(ticket.status, ticket.potentialPayoutMicroUsd, ticket.finalPayoutMicroUsd),
    settlementPolicyReviewRequired: Boolean(ticket.settlementPolicyReviewRequired),
    accountingMode: ticket.accountingMode,
    currency: ticket.currency,
    purchaseTxHash: ticket.purchaseTxHash || undefined,
    purchaseChainId: ticket.purchaseChainId || undefined,
    legs: legsResult.rows.map((leg) => ({
      ticketLegId: leg.ticketLegId,
      status: leg.status,
      settledAt: leg.settledAt?.toISOString(),
      resolutionState: leg.resolutionState,
      resolutionUpdatedAt: leg.resolutionUpdatedAt?.toISOString(),
      nextResolutionCheckAt: leg.nextResolutionCheckAt?.toISOString(),
      lastResolutionError: leg.lastResolutionError || undefined,
      endDate: leg.endDate?.toISOString(),
      question: leg.question,
      outcome: leg.outcome,
      marketUrl: leg.marketUrl || undefined
    }))
  };
}
