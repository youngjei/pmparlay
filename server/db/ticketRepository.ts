import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./client";

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

type AcceptQuoteOptions = {
  accountingMode?: AccountingMode;
  currency?: LedgerCurrency;
  allowExpiredQuote?: boolean;
  maxUserLiabilityUsd?: number;
  maxMarketLiabilityUsd: number;
  maxEventLiabilityUsd: number;
};

type AccountingMode = "play_money" | "house_book_usdc";
type LedgerCurrency = "USD" | "USDC";

function microUsdToUsd(value: string | number | null) {
  return Number(value || 0) / 1_000_000;
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

  return Number(result.rows[0]?.balance || 0);
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
    amountDueMicroUnits: number;
    netLiabilityMicroUnits: number;
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
  incrementalLiabilityUsd: number,
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

  const marketExposure = await client.query<{
    source_market_id: string;
    outcome: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      SELECT source_market_id, outcome, worst_case_liability_micro_usd::text
      FROM open_market_exposure
      WHERE (source_market_id, outcome) IN (
        SELECT markets.source_market_id, quote_legs.outcome
        FROM quote_legs
        JOIN markets ON markets.id = quote_legs.market_id
        WHERE quote_legs.quote_id = $1
      )
    `,
    [quoteId]
  );
  const marketExposureByKey = new Map(
    marketExposure.rows.map((row) => [`${row.source_market_id}:${row.outcome}`, microUsdToUsd(row.worst_case_liability_micro_usd)])
  );

  for (const leg of legs.rows) {
    const currentExposureUsd = marketExposureByKey.get(`${leg.source_market_id}:${leg.outcome}`) || 0;
    if (currentExposureUsd + incrementalLiabilityUsd > options.maxMarketLiabilityUsd) {
      throw new Error("quote_exposure_limit:market");
    }
  }

  const eventExposure = await client.query<{
    market_url: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      SELECT market_url, worst_case_liability_micro_usd::text
      FROM open_event_exposure
      WHERE market_url IN (
        SELECT markets.market_url
        FROM quote_legs
        JOIN markets ON markets.id = quote_legs.market_id
        WHERE quote_legs.quote_id = $1
      )
    `,
    [quoteId]
  );
  const eventExposureByUrl = new Map(eventExposure.rows.map((row) => [row.market_url, microUsdToUsd(row.worst_case_liability_micro_usd)]));

  for (const marketUrl of new Set(legs.rows.map((leg) => leg.market_url))) {
    const currentExposureUsd = eventExposureByUrl.get(marketUrl) || 0;
    if (currentExposureUsd + incrementalLiabilityUsd > options.maxEventLiabilityUsd) {
      throw new Error("quote_exposure_limit:event");
    }
  }

  if (options.maxUserLiabilityUsd) {
    const userExposure = await client.query<{ worst_case_liability_micro_usd: string }>(
      `
        SELECT worst_case_liability_micro_usd::text
        FROM open_user_exposure
        WHERE user_id = $1
      `,
      [userId]
    );
    const currentExposureUsd = microUsdToUsd(userExposure.rows[0]?.worst_case_liability_micro_usd || 0);
    if (currentExposureUsd + incrementalLiabilityUsd > options.maxUserLiabilityUsd) {
      throw new Error("quote_exposure_limit:user");
    }
  }
}

export async function acceptQuote(quoteId: string, userId: string, options?: AcceptQuoteOptions): Promise<AcceptedTicket> {
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");

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
      if (ticket) {
        await client.query("COMMIT");
        committed = true;
        return ticket;
      }
    }

    if (quote.status !== "quoted" && !(options?.allowExpiredQuote && quote.status === "expired")) {
      throw new Error(`quote_not_acceptable:${quote.status}`);
    }

    if (!options?.allowExpiredQuote && quote.expires_at.getTime() <= Date.now()) {
      await client.query("UPDATE quotes SET status = 'expired' WHERE id = $1", [quoteId]);
      await client.query("COMMIT");
      committed = true;
      throw new Error("quote_expired");
    }

    const accountingMode = options?.accountingMode || "play_money";
    const currency: LedgerCurrency = options?.currency || (accountingMode === "house_book_usdc" ? "USDC" : "USD");
    if (accountingMode === "house_book_usdc" && currency !== "USDC") {
      throw new Error("invalid_house_book_currency");
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
    const amountDue = Number(quote.stake_micro_usd) + Number(quote.operation_fee_micro_usd);
    const netLiability = Math.max(0, Number(quote.offered_payout_micro_usd) - Number(quote.stake_micro_usd));
    const incrementalLiabilityUsd = microUsdToUsd(netLiability);

    await enforceFundingCapacity(client, {
      accountingMode,
      userAccountId,
      houseOperatingAccountId: houseAccountId,
      houseReserveAccountId,
      amountDueMicroUnits: amountDue,
      netLiabilityMicroUnits: netLiability
    });
    await enforceAcceptExposureLimits(client, userId, quoteId, incrementalLiabilityUsd, options);

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
        INSERT INTO ticket_legs (ticket_id, quote_leg_id, status)
        SELECT $1, quote_legs.id, 'pending'
        FROM quote_legs
        WHERE quote_legs.quote_id = $2
      `,
      [ticketId, quoteId]
    );
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, $6, 'quote accepted'),
          ($1, $4, $5, $6, 'quote accepted')
      `,
      [transactionId, userAccountId, -amountDue, houseAccountId, amountDue, currency]
    );
    if (netLiability > 0) {
      await client.query(
        `
          INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
          VALUES
            ($1, $2, $3, $5, 'ticket liability reserved'),
            ($1, $4, $6, $5, 'ticket liability reserved')
        `,
        [reserveTransactionId, houseAccountId, -netLiability, houseReserveAccountId, currency, netLiability]
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
        Number(quote.stake_micro_usd),
        Number(quote.operation_fee_micro_usd),
        Number(quote.offered_payout_micro_usd),
        netLiability,
        transactionId,
        netLiability > 0 ? reserveTransactionId : null
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
          reserveTransactionId: netLiability > 0 ? reserveTransactionId : null,
          accountingMode,
          currency,
          amountDueMicroUnits: amountDue,
          netLiabilityMicroUnits: netLiability
        }
      ]
    );

    await client.query("COMMIT");
    committed = true;

    return {
      ticketId,
      quoteId,
      status: "accepted",
      ledgerTransactionId: transactionId,
      reserveTransactionId: netLiability > 0 ? reserveTransactionId : undefined,
      accountingMode,
      currency
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
  }>(
    `
      SELECT
        tickets.id AS "ticketId",
        tickets.quote_id AS "quoteId",
        tickets.status,
        tickets.created_at AS "createdAt",
        tickets.updated_at AS "updatedAt",
        quotes.stake_micro_usd::text AS "stakeMicroUsd",
        quotes.operation_fee_micro_usd::text AS "operationFeeMicroUsd",
        quotes.offered_payout_micro_usd::text AS "potentialPayoutMicroUsd",
        tickets.accounting_mode AS "accountingMode",
        tickets.funding_currency AS "currency",
        count(ticket_legs.id)::text AS legs,
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'pending')::text AS "pendingLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'won')::text AS "wonLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'lost')::text AS "lostLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'voided')::text AS "voidedLegs",
        count(ticket_legs.id) FILTER (WHERE ticket_legs.status = 'disputed')::text AS "disputedLegs"
      FROM tickets
      JOIN quotes ON quotes.id = tickets.quote_id
      LEFT JOIN ticket_legs ON ticket_legs.ticket_id = tickets.id
      WHERE tickets.user_id = $1
      GROUP BY tickets.id, quotes.id
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
    amountPaidUsd: microUsdToUsd(Number(row.stakeMicroUsd) + Number(row.operationFeeMicroUsd)),
    potentialPayoutUsd: microUsdToUsd(row.potentialPayoutMicroUsd),
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
  }>(
    `
      SELECT
        tickets.id AS "ticketId",
        tickets.quote_id AS "quoteId",
        tickets.status,
        tickets.created_at AS "createdAt",
        tickets.updated_at AS "updatedAt",
        quotes.stake_micro_usd::text AS "stakeMicroUsd",
        quotes.operation_fee_micro_usd::text AS "operationFeeMicroUsd",
        quotes.offered_payout_micro_usd::text AS "potentialPayoutMicroUsd",
        tickets.accounting_mode AS "accountingMode",
        tickets.funding_currency AS "currency",
        purchase_payment.tx_hash AS "purchaseTxHash",
        purchase_payment.chain_id AS "purchaseChainId"
      FROM tickets
      JOIN quotes ON quotes.id = tickets.quote_id
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
    amountPaidUsd: (Number(ticket.stakeMicroUsd) + Number(ticket.operationFeeMicroUsd)) / 1_000_000,
    potentialPayoutUsd: Number(ticket.potentialPayoutMicroUsd) / 1_000_000,
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
