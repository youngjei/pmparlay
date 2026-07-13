import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./client";

export type PendingSettlementLeg = {
  ticketLegId: string;
  ticketId: string;
  quoteId: string;
  question: string;
  outcome: string;
  marketUrl?: string;
  conditionId?: string;
  tokenId?: string;
  endDate?: string;
  negRisk?: boolean;
  status: string;
  resolutionState?: string;
  resolutionAttempts?: number;
  resolutionUpdatedAt?: string;
  nextResolutionCheckAt?: string;
  lastResolutionError?: string;
  ticketStatus: string;
  createdAt: string;
};

export type SettlementResult = "won" | "lost" | "voided" | "disputed";
export type ResolutionState =
  | "pending"
  | "resolution_candidate"
  | "awaiting_oracle"
  | "disputed"
  | "resolved_won"
  | "resolved_lost"
  | "resolved_void"
  | "resolved_partial"
  | "settlement_blocked";

export type SettlementProofInput = {
  ticketLegId: string;
  source: string;
  proofKind: string;
  result: "pending" | "won" | "lost" | "voided" | "partial" | "disputed" | "blocked";
  confidence: "api_signal" | "onchain_confirmed" | "manual_override";
  conditionId?: string;
  tokenId?: string;
  winningTokenId?: string;
  payoutNumerator?: number;
  payoutDenominator?: number;
  blockNumber?: number;
  txHash?: string;
  resolvedAt?: string;
  raw?: unknown;
};

export type SettlementProof = SettlementProofInput & {
  id: string;
  checkedAt: string;
  createdAt: string;
};

export type SettlementLegListOptions = {
  dueOnly?: boolean;
  includeBlocked?: boolean;
};

export type SettledLeg = {
  ticketLegId: string;
  ticketId: string;
  legStatus: SettlementResult;
  ticketStatus: "live" | "won" | "lost" | "voided" | "paid";
};

export function deriveTicketStatus(statuses: string[]): SettledLeg["ticketStatus"] {
  if (statuses.some((status) => status === "lost")) return "lost";
  if (statuses.some((status) => status === "pending" || status === "disputed")) return "live";
  if (statuses.some((status) => status === "voided")) return "voided";
  return "won";
}

function resolutionStateForResult(result: SettlementResult): ResolutionState {
  if (result === "won") return "resolved_won";
  if (result === "lost") return "resolved_lost";
  if (result === "voided") return "resolved_void";
  return "disputed";
}

export async function listPendingSettlementLegs(limit = 100, options: SettlementLegListOptions = {}): Promise<PendingSettlementLeg[]> {
  const filters = [
    "ticket_legs.status IN ('pending', 'disputed')",
    "tickets.status IN ('accepted', 'live')"
  ];

  if (options.dueOnly) {
    filters.push("ticket_legs.next_resolution_check_at <= now()");
  }

  if (options.includeBlocked === false) {
    filters.push("ticket_legs.resolution_state <> 'settlement_blocked'");
  }

  const result = await getPool().query<{
    ticketLegId: string;
    ticketId: string;
    quoteId: string;
    question: string;
    outcome: string;
    marketUrl: string | null;
    conditionId: string | null;
    tokenId: string | null;
    endDate: Date | null;
    negRisk: boolean | null;
    status: string;
    resolutionState: string;
    resolutionAttempts: number;
    resolutionUpdatedAt: Date | null;
    nextResolutionCheckAt: Date | null;
    lastResolutionError: string | null;
    ticketStatus: string;
    createdAt: Date;
  }>(
    `
      SELECT
        ticket_legs.id AS "ticketLegId",
        tickets.id AS "ticketId",
        tickets.quote_id AS "quoteId",
        markets.question,
        quote_legs.outcome,
        markets.market_url AS "marketUrl",
        markets.condition_id AS "conditionId",
        market_outcomes.token_id AS "tokenId",
        markets.end_date AS "endDate",
        markets.neg_risk AS "negRisk",
        ticket_legs.status,
        ticket_legs.resolution_state AS "resolutionState",
        ticket_legs.resolution_attempts AS "resolutionAttempts",
        ticket_legs.resolution_updated_at AS "resolutionUpdatedAt",
        ticket_legs.next_resolution_check_at AS "nextResolutionCheckAt",
        ticket_legs.last_resolution_error AS "lastResolutionError",
        tickets.status AS "ticketStatus",
        ticket_legs.created_at AS "createdAt"
      FROM ticket_legs
      JOIN tickets ON tickets.id = ticket_legs.ticket_id
      JOIN quote_legs ON quote_legs.id = ticket_legs.quote_leg_id
      JOIN markets ON markets.id = quote_legs.market_id
      JOIN market_outcomes ON market_outcomes.id = quote_legs.outcome_id
      WHERE ${filters.join("\n        AND ")}
      ORDER BY ticket_legs.created_at ASC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows.map((row) => ({
    ticketLegId: row.ticketLegId,
    ticketId: row.ticketId,
    quoteId: row.quoteId,
    question: row.question,
    outcome: row.outcome,
    marketUrl: row.marketUrl || undefined,
    conditionId: row.conditionId || undefined,
    tokenId: row.tokenId || undefined,
    endDate: row.endDate?.toISOString(),
    negRisk: row.negRisk ?? undefined,
    status: row.status,
    resolutionState: row.resolutionState,
    resolutionAttempts: row.resolutionAttempts,
    resolutionUpdatedAt: row.resolutionUpdatedAt?.toISOString(),
    nextResolutionCheckAt: row.nextResolutionCheckAt?.toISOString(),
    lastResolutionError: row.lastResolutionError || undefined,
    ticketStatus: row.ticketStatus,
    createdAt: row.createdAt.toISOString()
  }));
}

export async function recordSettlementProof(client: pg.PoolClient, input: SettlementProofInput) {
  await client.query(
    `
      INSERT INTO settlement_proofs (
        ticket_leg_id,
        source,
        proof_kind,
        result,
        confidence,
        condition_id,
        token_id,
        winning_token_id,
        payout_numerator,
        payout_denominator,
        block_number,
        tx_hash,
        resolved_at,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `,
    [
      input.ticketLegId,
      input.source,
      input.proofKind,
      input.result,
      input.confidence,
      input.conditionId || null,
      input.tokenId || null,
      input.winningTokenId || null,
      input.payoutNumerator ?? null,
      input.payoutDenominator ?? null,
      input.blockNumber ?? null,
      input.txHash || null,
      input.resolvedAt || null,
      input.raw || {}
    ]
  );
}

export async function listSettlementProofs(ticketLegId: string, limit = 50): Promise<SettlementProof[]> {
  const result = await getPool().query<{
    id: string;
    source: string;
    proofKind: string;
    result: SettlementProofInput["result"];
    confidence: SettlementProofInput["confidence"];
    conditionId: string | null;
    tokenId: string | null;
    winningTokenId: string | null;
    payoutNumerator: string | null;
    payoutDenominator: string | null;
    blockNumber: string | null;
    txHash: string | null;
    resolvedAt: Date | null;
    checkedAt: Date;
    raw: unknown;
    createdAt: Date;
  }>(
    `
      SELECT
        id,
        source,
        proof_kind AS "proofKind",
        result,
        confidence,
        condition_id AS "conditionId",
        token_id AS "tokenId",
        winning_token_id AS "winningTokenId",
        payout_numerator::text AS "payoutNumerator",
        payout_denominator::text AS "payoutDenominator",
        block_number::text AS "blockNumber",
        tx_hash AS "txHash",
        resolved_at AS "resolvedAt",
        checked_at AS "checkedAt",
        raw,
        created_at AS "createdAt"
      FROM settlement_proofs
      WHERE ticket_leg_id = $1
      ORDER BY checked_at DESC, created_at DESC
      LIMIT $2
    `,
    [ticketLegId, limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    ticketLegId,
    source: row.source,
    proofKind: row.proofKind,
    result: row.result,
    confidence: row.confidence,
    conditionId: row.conditionId || undefined,
    tokenId: row.tokenId || undefined,
    winningTokenId: row.winningTokenId || undefined,
    payoutNumerator: row.payoutNumerator === null ? undefined : Number(row.payoutNumerator),
    payoutDenominator: row.payoutDenominator === null ? undefined : Number(row.payoutDenominator),
    blockNumber: row.blockNumber === null ? undefined : Number(row.blockNumber),
    txHash: row.txHash || undefined,
    resolvedAt: row.resolvedAt?.toISOString(),
    checkedAt: row.checkedAt.toISOString(),
    raw: row.raw,
    createdAt: row.createdAt.toISOString()
  }));
}

export async function recordSettlementObservation(input: {
  ticketLegId: string;
  resolutionState: ResolutionState;
  source: string;
  proofKind: string;
  result?: SettlementProofInput["result"];
  confidence?: SettlementProofInput["confidence"];
  proofReference?: string;
  conditionId?: string;
  tokenId?: string;
  winningTokenId?: string;
  nextCheckSeconds?: number;
  error?: string;
  raw?: unknown;
}) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `
        UPDATE ticket_legs
        SET
          resolution_state = $2,
          resolution_attempts = resolution_attempts + 1,
          next_resolution_check_at = now() + ($3::text || ' seconds')::interval,
          resolution_updated_at = now(),
          last_resolution_error = $4
        WHERE id = $1
          AND status IN ('pending', 'disputed')
      `,
      [input.ticketLegId, input.resolutionState, input.nextCheckSeconds ?? 300, input.error || null]
    );

    if (updated.rowCount === 0) {
      await client.query("COMMIT");
      return false;
    }

    await recordSettlementProof(client, {
      ticketLegId: input.ticketLegId,
      source: input.source,
      proofKind: input.proofKind,
      result: input.result || "pending",
      confidence: input.confidence || "api_signal",
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      winningTokenId: input.winningTokenId,
      raw: input.raw
    });

    await client.query(
      `
        INSERT INTO audit_log (action, entity_type, entity_id, metadata)
        VALUES ('ticket_leg.resolution_observed', 'ticket_leg', $1, $2)
      `,
      [
        input.ticketLegId,
        {
          resolutionState: input.resolutionState,
          source: input.source,
          proofKind: input.proofKind,
          error: input.error || null
        }
      ]
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateTicketStatus(client: pg.PoolClient, ticketId: string) {
  const statusesResult = await client.query<{ status: string }>(
    `
      SELECT status
      FROM ticket_legs
      WHERE ticket_id = $1
      ORDER BY created_at ASC
    `,
    [ticketId]
  );
  const nextStatus = deriveTicketStatus(statusesResult.rows.map((row) => row.status));

  await client.query(
    `
      UPDATE tickets
      SET status = $2, updated_at = now()
      WHERE id = $1
    `,
    [ticketId, nextStatus]
  );

  return nextStatus;
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

function accountTypes(accountingMode: string) {
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

async function payFinalTicketIfNeeded(client: pg.PoolClient, ticketId: string, ticketStatus: SettledLeg["ticketStatus"]) {
  if (ticketStatus !== "won" && ticketStatus !== "voided" && ticketStatus !== "lost") return ticketStatus;

  const ticket = await client.query<{
    user_id: string;
    stake_micro_usd: string;
    offered_payout_micro_usd: string;
    accounting_mode: string;
    funding_currency: string;
  }>(
    `
      SELECT
        tickets.user_id,
        tickets.accounting_mode,
        tickets.funding_currency,
        quotes.stake_micro_usd::text,
        quotes.offered_payout_micro_usd::text
      FROM tickets
      JOIN quotes ON quotes.id = tickets.quote_id
      WHERE tickets.id = $1
      FOR UPDATE
    `,
    [ticketId]
  );
  const row = ticket.rows[0];
  if (!row) throw new Error("ticket_not_found");

  const finalAuditAction = ticketStatus === "lost" ? "ticket.reserve_released" : "ticket.paid";
  const alreadyFinalized = await client.query<{ id: string }>(
    `
      SELECT id
      FROM audit_log
      WHERE action = $2
        AND entity_type = 'ticket'
        AND entity_id = $1
      LIMIT 1
    `,
    [ticketId, finalAuditAction]
  );

  if (alreadyFinalized.rows[0]) return ticketStatus === "lost" ? "lost" : "paid";

  const payoutMicroUsd = ticketStatus === "won" ? Number(row.offered_payout_micro_usd) : Number(row.stake_micro_usd);
  const accounts = accountTypes(row.accounting_mode);
  const currency = row.funding_currency;
  if (row.accounting_mode === "house_book_usdc" && currency !== "USDC") {
    throw new Error("invalid_house_book_currency");
  }
  const userAccountId = await ensureLedgerAccount(client, row.user_id, accounts.userAvailable, currency);
  const houseAccountId = await ensureLedgerAccount(client, null, accounts.houseOperating, currency);
  const houseReserveAccountId = await ensureLedgerAccount(client, null, accounts.houseReserve, currency);
  const transactionId = randomUUID();
  const releaseTransactionId = randomUUID();

  const reserve = await client.query<{
    id: string;
    net_liability_micro_units: string;
    status: string;
  }>(
    `
      SELECT id, net_liability_micro_units::text, status
      FROM ticket_reserves
      WHERE ticket_id = $1
      FOR UPDATE
    `,
    [ticketId]
  );
  const reserveRow = reserve.rows[0];
  const reservedLiability = Number(reserveRow?.net_liability_micro_units || 0);

  if (reservedLiability > 0 && reserveRow?.status === "reserved") {
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, $5, 'ticket liability reserve released'),
          ($1, $4, $6, $5, 'ticket liability reserve released')
      `,
      [releaseTransactionId, houseReserveAccountId, -reservedLiability, houseAccountId, currency, reservedLiability]
    );
  }

  if (ticketStatus !== "lost") {
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, $5, $6),
          ($1, $4, $7, $5, $6)
      `,
      [transactionId, userAccountId, payoutMicroUsd, houseAccountId, currency, "ticket settlement payout", -payoutMicroUsd]
    );
  }

  if (reserveRow) {
    await client.query(
      `
        UPDATE ticket_reserves
        SET
          status = $2,
          release_transaction_id = $3,
          updated_at = now()
        WHERE id = $1
      `,
      [reserveRow.id, ticketStatus === "won" ? "paid" : ticketStatus === "voided" ? "voided" : "released", reservedLiability > 0 ? releaseTransactionId : null]
    );
  }

  await client.query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, $4, 'ticket', $2, $3)
    `,
    [
      row.user_id,
      ticketId,
      {
        payoutMicroUnits: ticketStatus === "lost" ? 0 : payoutMicroUsd,
        payoutType: ticketStatus,
        accountingMode: row.accounting_mode,
        currency,
        ledgerTransactionId: ticketStatus === "lost" ? null : transactionId,
        releaseTransactionId: reservedLiability > 0 ? releaseTransactionId : null
      },
      finalAuditAction
    ]
  );

  if (ticketStatus === "lost") return "lost";

  await client.query("UPDATE tickets SET status = 'paid', updated_at = now() WHERE id = $1", [ticketId]);
  return "paid";
}

export async function recordLegSettlement(input: {
  ticketLegId: string;
  result: SettlementResult;
  source?: string;
  proofReference?: string;
  proof?: Omit<SettlementProofInput, "ticketLegId">;
  raw?: unknown;
}): Promise<SettledLeg> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const legResult = await client.query<{ ticket_id: string; status: string }>(
      `
        SELECT ticket_id, status
        FROM ticket_legs
        WHERE id = $1
        FOR UPDATE
      `,
      [input.ticketLegId]
    );
    const leg = legResult.rows[0];
    if (!leg) {
      throw new Error("ticket_leg_not_found");
    }

    if (["won", "lost", "voided"].includes(leg.status) && leg.status !== input.result) {
      throw new Error(`settlement_conflict:${leg.status}`);
    }

    await client.query("SELECT id FROM tickets WHERE id = $1 FOR UPDATE", [leg.ticket_id]);

    if (leg.status === input.result) {
      await recordSettlementProof(client, {
        ticketLegId: input.ticketLegId,
        source: input.source || "manual_ops",
        proofKind: input.proof?.proofKind || "manual_replay",
        result: input.result,
        confidence: input.proof?.confidence || "manual_override",
        conditionId: input.proof?.conditionId,
        tokenId: input.proof?.tokenId,
        winningTokenId: input.proof?.winningTokenId,
        payoutNumerator: input.proof?.payoutNumerator,
        payoutDenominator: input.proof?.payoutDenominator,
        blockNumber: input.proof?.blockNumber,
        txHash: input.proof?.txHash,
        resolvedAt: input.proof?.resolvedAt,
        raw: input.raw || input.proof?.raw || {}
      });

      const ticket = await client.query<{ status: SettledLeg["ticketStatus"] }>("SELECT status FROM tickets WHERE id = $1", [leg.ticket_id]);
      await client.query("COMMIT");

      return {
        ticketLegId: input.ticketLegId,
        ticketId: leg.ticket_id,
        legStatus: input.result,
        ticketStatus: ticket.rows[0]?.status || "live"
      };
    }

    await client.query(
      `
        INSERT INTO settlements (ticket_leg_id, source, result, proof_reference, raw)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (ticket_leg_id, source)
        DO UPDATE SET
          result = EXCLUDED.result,
          proof_reference = EXCLUDED.proof_reference,
          raw = EXCLUDED.raw
      `,
      [input.ticketLegId, input.source || "manual_ops", input.result, input.proofReference || null, input.raw || {}]
    );

    await client.query(
      `
        UPDATE ticket_legs
        SET
          status = $2,
          resolution_state = $3,
          resolution_updated_at = now(),
          last_resolution_error = NULL,
          settled_at = CASE WHEN $2 = 'disputed' THEN settled_at ELSE now() END
        WHERE id = $1
      `,
      [input.ticketLegId, input.result, resolutionStateForResult(input.result)]
    );

    await recordSettlementProof(client, {
      ticketLegId: input.ticketLegId,
      source: input.source || "manual_ops",
      proofKind: input.proof?.proofKind || "manual",
      result: input.result,
      confidence: input.proof?.confidence || "manual_override",
      conditionId: input.proof?.conditionId,
      tokenId: input.proof?.tokenId,
      winningTokenId: input.proof?.winningTokenId,
      payoutNumerator: input.proof?.payoutNumerator,
      payoutDenominator: input.proof?.payoutDenominator,
      blockNumber: input.proof?.blockNumber,
      txHash: input.proof?.txHash,
      resolvedAt: input.proof?.resolvedAt,
      raw: input.raw || input.proof?.raw || {}
    });

    const derivedTicketStatus = await updateTicketStatus(client, leg.ticket_id);
    const ticketStatus = await payFinalTicketIfNeeded(client, leg.ticket_id, derivedTicketStatus);

    await client.query(
      `
        INSERT INTO audit_log (action, entity_type, entity_id, metadata)
        VALUES ('ticket_leg.settled', 'ticket_leg', $1, $2)
      `,
      [
        input.ticketLegId,
        {
          ticketId: leg.ticket_id,
          result: input.result,
          source: input.source || "manual_ops",
          ticketStatus
        }
      ]
    );

    await client.query(
      `
        INSERT INTO outbox (topic, payload)
        VALUES ($1, $2)
      `,
      [
        "ticket.settlement.updated",
        {
          ticketId: leg.ticket_id,
          ticketLegId: input.ticketLegId,
          legStatus: input.result,
          ticketStatus
        }
      ]
    );

    await client.query("COMMIT");

    return {
      ticketLegId: input.ticketLegId,
      ticketId: leg.ticket_id,
      legStatus: input.result,
      ticketStatus
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
