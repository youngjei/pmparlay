import { randomUUID } from "node:crypto";
import type pg from "pg";
import { config, type SettlementAuthority } from "../config";
import { assertFinancialGateOpenInTransaction } from "../financialGate";
import { validateCtfSettlementIdentity, type CtfSettlementIdentityValidation } from "../resolvers/polymarketSettlementResolver";
import {
  validatePolymarketApiSettlementIdentity,
  type PolymarketApiIdentityValidation
} from "../resolvers/polymarketApiSettlement";
import { getPool } from "./client";

type BigintLike = bigint | number | string;

function bigintString(value: BigintLike | undefined | null) {
  if (value === undefined || value === null) return null;
  return BigInt(value).toString();
}

function bigintArray(value: BigintLike[] | undefined | null) {
  return value ? value.map((item) => BigInt(item).toString()) : null;
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]));
  }
  return value;
}

function positiveBigint(value: BigintLike | undefined | null, errorCode: string) {
  const parsed = BigInt(value ?? 0);
  if (parsed <= 0n) throw new Error(errorCode);
  return parsed;
}

export type PendingSettlementLeg = {
  ticketLegId: string;
  ticketId: string;
  quoteId: string;
  question: string;
  outcome: string;
  marketUrl?: string;
  conditionId?: string;
  tokenId?: string;
  settlementSource?: string;
  settlementAuthority?: SettlementAuthority;
  settlementChainId?: number;
  settlementContractAddress?: string;
  settlementCollateralAddress?: string;
  settlementConditionId?: string;
  settlementTokenId?: string;
  settlementOutcomeIndex?: number;
  settlementPayoutSlotCount?: number;
  settlementQuestionId?: string;
  settlementUmaAdapter?: string;
  settlementUmaAdapterVersion?: string;
  settlementEventId?: string;
  settlementNegRiskGroupId?: string;
  settlementNegRisk?: boolean;
  settlementRulesSnapshotHash?: string;
  settlementSourceSnapshotId?: string;
  settlementQuestion?: string;
  settlementOutcome?: string;
  settlementSourceMarketId?: string;
  settlementPositionId?: string;
  settlementCollectionId?: string;
  settlementFrozenAt?: string;
  settlementDueAt?: string;
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
  chainId?: number;
  contractAddress?: string;
  collateralAddress?: string;
  conditionId?: string;
  tokenId?: string;
  outcomeIndex?: number;
  winningTokenId?: string;
  payoutNumerator?: BigintLike;
  payoutDenominator?: BigintLike;
  payoutVector?: BigintLike[];
  blockNumber?: BigintLike;
  blockHash?: string;
  txHash?: string;
  resolvedAt?: string;
  providerEvidence?: unknown;
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
  blockedOnly?: boolean;
};

export type SettledLeg = {
  ticketLegId: string;
  ticketId: string;
  legStatus: SettlementResult;
  ticketStatus: "live" | "won" | "lost" | "voided" | "claimable" | "paid";
};

export function deriveTicketStatus(statuses: string[]): SettledLeg["ticketStatus"] {
  if (statuses.some((status) => status === "voided")) return "voided";
  if (statuses.some((status) => status === "pending" || status === "disputed")) return "live";
  if (statuses.some((status) => status === "lost")) return "lost";
  if (statuses.length === 0) return "live";
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
    "tickets.status IN ('accepted', 'live', 'won', 'lost', 'voided')"
  ];

  if (options.dueOnly) {
    filters.push("ticket_legs.next_resolution_check_at <= now()");
  }

  if (options.blockedOnly) {
    filters.push("ticket_legs.resolution_state = 'settlement_blocked'");
  } else if (options.includeBlocked === false) {
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
    settlementSource: string | null;
    settlementAuthority: SettlementAuthority | null;
    settlementChainId: number | null;
    settlementContractAddress: string | null;
    settlementCollateralAddress: string | null;
    settlementConditionId: string | null;
    settlementTokenId: string | null;
    settlementOutcomeIndex: number | null;
    settlementPayoutSlotCount: number | null;
    settlementQuestionId: string | null;
    settlementUmaAdapter: string | null;
    settlementUmaAdapterVersion: string | null;
    settlementEventId: string | null;
    settlementNegRiskGroupId: string | null;
    settlementNegRisk: boolean | null;
    settlementRulesSnapshotHash: string | null;
    settlementSourceSnapshotId: string | null;
    settlementQuestion: string | null;
    settlementOutcome: string | null;
    settlementSourceMarketId: string | null;
    settlementPositionId: string | null;
    settlementCollectionId: string | null;
    settlementFrozenAt: Date | null;
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
        COALESCE(ticket_legs.settlement_question, ticket_legs.settlement_identity_raw->>'question', markets.question) AS question,
        quote_legs.outcome,
        markets.market_url AS "marketUrl",
        ticket_legs.settlement_condition_id AS "conditionId",
        ticket_legs.settlement_token_id AS "tokenId",
        ticket_legs.settlement_source AS "settlementSource",
        ticket_legs.settlement_authority AS "settlementAuthority",
        ticket_legs.settlement_chain_id AS "settlementChainId",
        ticket_legs.settlement_contract_address AS "settlementContractAddress",
        ticket_legs.settlement_collateral_address AS "settlementCollateralAddress",
        ticket_legs.settlement_condition_id AS "settlementConditionId",
        ticket_legs.settlement_token_id AS "settlementTokenId",
        ticket_legs.settlement_outcome_index AS "settlementOutcomeIndex",
        ticket_legs.settlement_payout_slot_count AS "settlementPayoutSlotCount",
        ticket_legs.settlement_question_id AS "settlementQuestionId",
        ticket_legs.settlement_uma_adapter AS "settlementUmaAdapter",
        ticket_legs.settlement_uma_adapter_version AS "settlementUmaAdapterVersion",
        ticket_legs.settlement_event_id AS "settlementEventId",
        ticket_legs.settlement_neg_risk_group_id AS "settlementNegRiskGroupId",
        ticket_legs.settlement_neg_risk AS "settlementNegRisk",
        ticket_legs.settlement_rules_snapshot_hash AS "settlementRulesSnapshotHash",
        ticket_legs.settlement_source_snapshot_id::text AS "settlementSourceSnapshotId",
        ticket_legs.settlement_question AS "settlementQuestion",
        ticket_legs.settlement_outcome AS "settlementOutcome",
        ticket_legs.settlement_source_market_id AS "settlementSourceMarketId",
        ticket_legs.settlement_position_id AS "settlementPositionId",
        ticket_legs.settlement_collection_id AS "settlementCollectionId",
        ticket_legs.settlement_frozen_at AS "settlementFrozenAt",
        ticket_legs.settlement_due_at AS "endDate",
        ticket_legs.settlement_neg_risk AS "negRisk",
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
    settlementSource: row.settlementSource || undefined,
    settlementAuthority: row.settlementAuthority || undefined,
    settlementChainId: row.settlementChainId ?? undefined,
    settlementContractAddress: row.settlementContractAddress || undefined,
    settlementCollateralAddress: row.settlementCollateralAddress || undefined,
    settlementConditionId: row.settlementConditionId || undefined,
    settlementTokenId: row.settlementTokenId || undefined,
    settlementOutcomeIndex: row.settlementOutcomeIndex ?? undefined,
    settlementPayoutSlotCount: row.settlementPayoutSlotCount ?? undefined,
    settlementQuestionId: row.settlementQuestionId || undefined,
    settlementUmaAdapter: row.settlementUmaAdapter || undefined,
    settlementUmaAdapterVersion: row.settlementUmaAdapterVersion || undefined,
    settlementEventId: row.settlementEventId || undefined,
    settlementNegRiskGroupId: row.settlementNegRiskGroupId || undefined,
    settlementNegRisk: row.settlementNegRisk ?? undefined,
    settlementRulesSnapshotHash: row.settlementRulesSnapshotHash || undefined,
    settlementSourceSnapshotId: row.settlementSourceSnapshotId || undefined,
    settlementQuestion: row.settlementQuestion || undefined,
    settlementOutcome: row.settlementOutcome || undefined,
    settlementSourceMarketId: row.settlementSourceMarketId || undefined,
    settlementPositionId: row.settlementPositionId || undefined,
    settlementCollectionId: row.settlementCollectionId || undefined,
    settlementFrozenAt: row.settlementFrozenAt?.toISOString(),
    settlementDueAt: row.endDate?.toISOString(),
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

export function listBlockedSettlementLegs(limit = 100, options: Omit<SettlementLegListOptions, "includeBlocked" | "blockedOnly"> = {}) {
  return listPendingSettlementLegs(limit, {
    ...options,
    blockedOnly: true
  });
}

export async function recordSettlementProof(client: pg.PoolClient, input: SettlementProofInput) {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO settlement_proofs (
        ticket_leg_id,
        source,
        proof_kind,
        result,
        confidence,
        chain_id,
        contract_address,
        collateral_address,
        condition_id,
        token_id,
        outcome_index,
        winning_token_id,
        payout_numerator,
        payout_denominator,
        payout_vector,
        block_number,
        block_hash,
        tx_hash,
        resolved_at,
        provider_evidence,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING id
    `,
    [
      input.ticketLegId,
      input.source,
      input.proofKind,
      input.result,
      input.confidence,
      input.chainId ?? null,
      input.contractAddress || null,
      input.collateralAddress || null,
      input.conditionId || null,
      input.tokenId || null,
      input.outcomeIndex ?? null,
      input.winningTokenId || null,
      bigintString(input.payoutNumerator),
      bigintString(input.payoutDenominator),
      bigintArray(input.payoutVector),
      bigintString(input.blockNumber),
      input.blockHash || null,
      input.txHash || null,
      input.resolvedAt || null,
      JSON.stringify(jsonSafe(input.providerEvidence ?? [])),
      JSON.stringify(jsonSafe(input.raw ?? {}))
    ]
  );
  if (!result.rows[0]?.id) throw new Error("settlement_proof_insert_failed");
  return result.rows[0].id;
}

export async function listSettlementProofs(ticketLegId: string, limit = 50): Promise<SettlementProof[]> {
  const result = await getPool().query<{
    id: string;
    source: string;
    proofKind: string;
    result: SettlementProofInput["result"];
    confidence: SettlementProofInput["confidence"];
    chainId: number | null;
    contractAddress: string | null;
    collateralAddress: string | null;
    conditionId: string | null;
    tokenId: string | null;
    outcomeIndex: number | null;
    winningTokenId: string | null;
    payoutNumerator: string | null;
    payoutDenominator: string | null;
    payoutVector: string[] | null;
    blockNumber: string | null;
    blockHash: string | null;
    txHash: string | null;
    resolvedAt: Date | null;
    providerEvidence: unknown;
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
        chain_id AS "chainId",
        contract_address AS "contractAddress",
        collateral_address AS "collateralAddress",
        condition_id AS "conditionId",
        token_id AS "tokenId",
        outcome_index AS "outcomeIndex",
        winning_token_id AS "winningTokenId",
        payout_numerator::text AS "payoutNumerator",
        payout_denominator::text AS "payoutDenominator",
        payout_vector::text[] AS "payoutVector",
        block_number::text AS "blockNumber",
        block_hash AS "blockHash",
        tx_hash AS "txHash",
        resolved_at AS "resolvedAt",
        provider_evidence AS "providerEvidence",
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
    chainId: row.chainId ?? undefined,
    contractAddress: row.contractAddress || undefined,
    collateralAddress: row.collateralAddress || undefined,
    conditionId: row.conditionId || undefined,
    tokenId: row.tokenId || undefined,
    outcomeIndex: row.outcomeIndex ?? undefined,
    winningTokenId: row.winningTokenId || undefined,
    payoutNumerator: row.payoutNumerator === null ? undefined : row.payoutNumerator,
    payoutDenominator: row.payoutDenominator === null ? undefined : row.payoutDenominator,
    payoutVector: row.payoutVector === null ? undefined : row.payoutVector,
    blockNumber: row.blockNumber === null ? undefined : row.blockNumber,
    blockHash: row.blockHash || undefined,
    txHash: row.txHash || undefined,
    resolvedAt: row.resolvedAt?.toISOString(),
    providerEvidence: row.providerEvidence,
    checkedAt: row.checkedAt.toISOString(),
    raw: row.raw,
    createdAt: row.createdAt.toISOString()
  }));
}

export type PolymarketApiSettlementCandidate = {
  proofId: string;
  fingerprint: string;
  firstObservedAt: string;
  observedAt: string;
  result: "won" | "lost" | "voided";
};

export async function getLatestPolymarketApiSettlementCandidate(
  ticketLegId: string
): Promise<PolymarketApiSettlementCandidate | undefined> {
  const result = await getPool().query<{
    proofId: string;
    result: string;
    raw: unknown;
    createdAt: Date;
  }>(
    `
      SELECT
        id AS "proofId",
        result,
        raw,
        created_at AS "createdAt"
      FROM settlement_proofs
      WHERE ticket_leg_id = $1
        AND source = 'polymarket_api'
        AND proof_kind = 'polymarket_api_resolution_candidate'
        AND result IN ('won', 'lost', 'voided')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [ticketLegId]
  );
  const row = result.rows[0];
  if (!row || !row.raw || typeof row.raw !== "object" || Array.isArray(row.raw)) return undefined;
  const raw = row.raw as Record<string, unknown>;
  const fingerprint = typeof raw.fingerprint === "string" ? raw.fingerprint : undefined;
  const firstObservedAt = typeof raw.firstObservedAt === "string" ? raw.firstObservedAt : undefined;
  if (
    !fingerprint ||
    !firstObservedAt ||
    !Number.isFinite(Date.parse(firstObservedAt)) ||
    !["won", "lost", "voided"].includes(row.result)
  ) {
    return undefined;
  }
  return {
    proofId: row.proofId,
    fingerprint,
    firstObservedAt: new Date(firstObservedAt).toISOString(),
    observedAt: row.createdAt.toISOString(),
    result: row.result as PolymarketApiSettlementCandidate["result"]
  };
}

export async function recordSettlementObservation(input: {
  ticketLegId: string;
  resolutionState: ResolutionState;
  source: string;
  proofKind: string;
  result?: SettlementProofInput["result"];
  confidence?: SettlementProofInput["confidence"];
  proofReference?: string;
  chainId?: number;
  contractAddress?: string;
  collateralAddress?: string;
  conditionId?: string;
  tokenId?: string;
  outcomeIndex?: number;
  winningTokenId?: string;
  payoutNumerator?: BigintLike;
  payoutDenominator?: BigintLike;
  payoutVector?: BigintLike[];
  blockNumber?: BigintLike;
  blockHash?: string;
  providerEvidence?: unknown;
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
      chainId: input.chainId,
      contractAddress: input.contractAddress,
      collateralAddress: input.collateralAddress,
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      outcomeIndex: input.outcomeIndex,
      winningTokenId: input.winningTokenId,
      payoutNumerator: input.payoutNumerator,
      payoutDenominator: input.payoutDenominator,
      payoutVector: input.payoutVector,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      providerEvidence: input.providerEvidence,
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

export type FrozenSettlementIdentity = {
  ticketLegId: string;
  ticketId: string;
  settlementSource: string;
  settlementAuthority: SettlementAuthority;
  settlementChainId: number;
  settlementContractAddress: string;
  settlementCollateralAddress: string;
  settlementConditionId: string;
  settlementTokenId: string;
  settlementOutcomeIndex: number;
  settlementPayoutSlotCount: number;
  settlementQuestionId?: string;
  settlementUmaAdapter?: string;
  settlementUmaAdapterVersion?: string;
  settlementEventId?: string;
  settlementNegRiskGroupId?: string;
  settlementNegRisk?: boolean;
  settlementRulesSnapshotHash?: string;
  settlementSourceSnapshotId?: string;
  settlementQuestion?: string;
  settlementOutcome?: string;
  settlementSourceMarketId?: string;
  settlementPositionId?: string;
  settlementCollectionId?: string;
  settlementFrozenAt: string;
  settlementDueAt: string;
};

export type FreezeTicketSettlementIdentitiesInput = {
  ticketId: string;
  settlementSource?: string;
  settlementAuthority?: SettlementAuthority;
  settlementChainId?: number;
  settlementContractAddress?: string;
  settlementCollateralAddress?: string;
  settlementPayoutSlotCount?: number;
  settlementQuestionId?: string;
  settlementUmaAdapter?: string;
  settlementUmaAdapterVersion?: string;
  settlementEventId?: string;
  settlementNegRiskGroupId?: string;
  settlementRulesSnapshotHash?: string;
};

/**
 * Populate a settlement identity while the ticket leg is still mutable.  Call
 * finalizeTicketSettlementIdentities only after the configured authority has
 * validated the frozen market identity.
 */
export async function prepareTicketSettlementIdentities(
  client: pg.PoolClient,
  input: FreezeTicketSettlementIdentitiesInput
): Promise<FrozenSettlementIdentity[]> {
  const settlementSource = input.settlementSource || "polymarket_ctf";
  const settlementAuthority = input.settlementAuthority || config.SETTLEMENT_AUTHORITY;
  const settlementChainId = input.settlementChainId || 137;
  const settlementContractAddress = input.settlementContractAddress || "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
  const settlementCollateralAddress = input.settlementCollateralAddress || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const settlementPayoutSlotCount = input.settlementPayoutSlotCount || 2;

  const result = await client.query<{
    ticketLegId: string;
    ticketId: string;
    settlementSource: string | null;
    settlementAuthority: SettlementAuthority | null;
    settlementChainId: number | null;
    settlementContractAddress: string | null;
    settlementCollateralAddress: string | null;
    settlementConditionId: string | null;
    settlementTokenId: string | null;
    settlementOutcomeIndex: number | null;
    settlementPayoutSlotCount: number | null;
    settlementQuestionId: string | null;
    settlementUmaAdapter: string | null;
    settlementUmaAdapterVersion: string | null;
    settlementEventId: string | null;
    settlementNegRiskGroupId: string | null;
    settlementNegRisk: boolean | null;
    settlementRulesSnapshotHash: string | null;
    settlementSourceSnapshotId: string | null;
    settlementQuestion: string | null;
    settlementOutcome: string | null;
    settlementSourceMarketId: string | null;
    settlementPositionId: string | null;
    settlementCollectionId: string | null;
    settlementFrozenAt: Date | null;
    settlementDueAt: Date | null;
  }>(
    `
      WITH leg_identity AS (
        SELECT
          ticket_legs.id AS ticket_leg_id,
          ticket_legs.ticket_id,
          quote_legs.market_snapshot_id,
          market_snapshots.source_response_hash,
          market_snapshots.raw AS snapshot_raw,
          quote_legs.outcome AS quoted_outcome,
          snapshot_outcome.value AS outcome_raw,
          snapshot_outcome.ordinality - 1 AS outcome_index,
          COALESCE(snapshot_outcome.value->>'marketId', market_snapshots.raw->>'marketId') AS source_market_id,
          snapshot_outcome.value->>'conditionId' AS condition_id,
          snapshot_outcome.value->>'tokenId' AS token_id,
          snapshot_outcome.value->>'question' AS question,
          COALESCE(snapshot_outcome.value->>'outcome', quote_legs.outcome) AS outcome,
          snapshot_outcome.value->>'marketUrl' AS market_url,
          snapshot_outcome.value->>'eventGroupKey' AS event_group_key,
          snapshot_outcome.value->>'eventSlug' AS event_slug,
          snapshot_outcome.value->>'eventTitle' AS event_title,
          CASE
            WHEN snapshot_outcome.value ? 'negRisk' THEN (snapshot_outcome.value->>'negRisk')::boolean
            ELSE NULL
          END AS neg_risk,
          CASE
            WHEN pg_input_is_valid(snapshot_outcome.value->>'endDate', 'timestamp with time zone')
              THEN (snapshot_outcome.value->>'endDate')::timestamptz
            WHEN pg_input_is_valid(market_snapshots.raw->'market'->>'endDate', 'timestamp with time zone')
              THEN (market_snapshots.raw->'market'->>'endDate')::timestamptz
            ELSE NULL
          END AS settlement_due_at
        FROM ticket_legs
        JOIN quote_legs ON quote_legs.id = ticket_legs.quote_leg_id
        JOIN market_snapshots ON market_snapshots.id = quote_legs.market_snapshot_id
        LEFT JOIN LATERAL (
          SELECT value, ordinality
          FROM jsonb_array_elements(COALESCE(market_snapshots.raw->'outcomes', '[]'::jsonb)) WITH ORDINALITY AS outcome(value, ordinality)
          WHERE outcome.value->>'outcome' = quote_legs.outcome
          LIMIT 1
        ) snapshot_outcome ON true
        WHERE ticket_legs.ticket_id = $1
        FOR UPDATE OF ticket_legs
      )
      UPDATE ticket_legs
      SET
        settlement_source = COALESCE(ticket_legs.settlement_source, $2),
        settlement_authority = COALESCE(ticket_legs.settlement_authority, $13),
        settlement_chain_id = COALESCE(ticket_legs.settlement_chain_id, $3),
        settlement_contract_address = COALESCE(ticket_legs.settlement_contract_address, $4),
        settlement_collateral_address = COALESCE(ticket_legs.settlement_collateral_address, $5),
        settlement_condition_id = COALESCE(ticket_legs.settlement_condition_id, leg_identity.condition_id),
        settlement_token_id = COALESCE(ticket_legs.settlement_token_id, leg_identity.token_id),
        settlement_outcome_index = COALESCE(ticket_legs.settlement_outcome_index, leg_identity.outcome_index),
        settlement_payout_slot_count = COALESCE(ticket_legs.settlement_payout_slot_count, $6),
        settlement_question_id = COALESCE(ticket_legs.settlement_question_id, $7, leg_identity.outcome_raw->>'questionId'),
        settlement_uma_adapter = COALESCE(ticket_legs.settlement_uma_adapter, $8),
        settlement_uma_adapter_version = COALESCE(ticket_legs.settlement_uma_adapter_version, $9),
        settlement_event_id = COALESCE(ticket_legs.settlement_event_id, $10, leg_identity.event_slug),
        settlement_neg_risk_group_id = COALESCE(ticket_legs.settlement_neg_risk_group_id, $11),
        settlement_rules_snapshot_hash = COALESCE(ticket_legs.settlement_rules_snapshot_hash, $12, leg_identity.source_response_hash),
        settlement_source_snapshot_id = COALESCE(ticket_legs.settlement_source_snapshot_id, leg_identity.market_snapshot_id),
        settlement_neg_risk = COALESCE(ticket_legs.settlement_neg_risk, leg_identity.neg_risk),
        settlement_question = COALESCE(ticket_legs.settlement_question, leg_identity.question),
        settlement_outcome = COALESCE(ticket_legs.settlement_outcome, leg_identity.outcome),
        settlement_source_market_id = COALESCE(ticket_legs.settlement_source_market_id, leg_identity.source_market_id),
        settlement_position_id = COALESCE(ticket_legs.settlement_position_id, leg_identity.token_id),
        settlement_due_at = COALESCE(ticket_legs.settlement_due_at, leg_identity.settlement_due_at),
        settlement_identity_raw = CASE
          WHEN ticket_legs.settlement_frozen_at IS NULL THEN jsonb_build_object(
            'sourceMarketId', leg_identity.source_market_id,
            'validationAuthority', $13,
            'question', leg_identity.question,
            'conditionId', leg_identity.condition_id,
            'tokenId', leg_identity.token_id,
            'positionId', leg_identity.token_id,
            'outcome', leg_identity.outcome,
            'outcomeIndex', leg_identity.outcome_index,
            'ctfAddress', $4,
            'collateralAddress', $5,
            'marketUrl', leg_identity.market_url,
            'eventGroupKey', leg_identity.event_group_key,
            'eventSlug', leg_identity.event_slug,
            'eventTitle', leg_identity.event_title,
            'umaAdapter', $8,
            'umaAdapterVersion', $9,
            'rulesSnapshotHash', COALESCE($12, leg_identity.source_response_hash),
            'marketSnapshotId', leg_identity.market_snapshot_id,
            'sourceSnapshotHash', leg_identity.source_response_hash,
            'settlementDueAt', leg_identity.settlement_due_at,
            'negRisk', leg_identity.neg_risk,
            'snapshotOutcome', leg_identity.outcome_raw
          )
          ELSE ticket_legs.settlement_identity_raw
        END
      FROM leg_identity
      WHERE ticket_legs.id = leg_identity.ticket_leg_id
      RETURNING
        ticket_legs.id AS "ticketLegId",
        ticket_legs.ticket_id AS "ticketId",
        ticket_legs.settlement_source AS "settlementSource",
        ticket_legs.settlement_authority AS "settlementAuthority",
        ticket_legs.settlement_chain_id AS "settlementChainId",
        ticket_legs.settlement_contract_address AS "settlementContractAddress",
        ticket_legs.settlement_collateral_address AS "settlementCollateralAddress",
        ticket_legs.settlement_condition_id AS "settlementConditionId",
        ticket_legs.settlement_token_id AS "settlementTokenId",
        ticket_legs.settlement_outcome_index AS "settlementOutcomeIndex",
        ticket_legs.settlement_payout_slot_count AS "settlementPayoutSlotCount",
        ticket_legs.settlement_question_id AS "settlementQuestionId",
        ticket_legs.settlement_uma_adapter AS "settlementUmaAdapter",
        ticket_legs.settlement_uma_adapter_version AS "settlementUmaAdapterVersion",
        ticket_legs.settlement_event_id AS "settlementEventId",
        ticket_legs.settlement_neg_risk_group_id AS "settlementNegRiskGroupId",
        ticket_legs.settlement_neg_risk AS "settlementNegRisk",
        ticket_legs.settlement_rules_snapshot_hash AS "settlementRulesSnapshotHash",
        ticket_legs.settlement_source_snapshot_id::text AS "settlementSourceSnapshotId",
        ticket_legs.settlement_question AS "settlementQuestion",
        ticket_legs.settlement_outcome AS "settlementOutcome",
        ticket_legs.settlement_source_market_id AS "settlementSourceMarketId",
        ticket_legs.settlement_position_id AS "settlementPositionId",
        ticket_legs.settlement_collection_id AS "settlementCollectionId",
        ticket_legs.settlement_frozen_at AS "settlementFrozenAt",
        ticket_legs.settlement_due_at AS "settlementDueAt"
    `,
    [
      input.ticketId,
      settlementSource,
      settlementChainId,
      settlementContractAddress,
      settlementCollateralAddress,
      settlementPayoutSlotCount,
      input.settlementQuestionId || null,
      input.settlementUmaAdapter || null,
      input.settlementUmaAdapterVersion || null,
      input.settlementEventId || null,
      input.settlementNegRiskGroupId || null,
      input.settlementRulesSnapshotHash || null,
      settlementAuthority
    ]
  );

  if (result.rows.length === 0) {
    throw new Error("ticket_settlement_identity_no_legs");
  }

  const incomplete = result.rows.find(
    (row) =>
      !row.settlementSource ||
      !row.settlementAuthority ||
      !row.settlementChainId ||
      !row.settlementContractAddress ||
      !row.settlementCollateralAddress ||
      !row.settlementConditionId ||
      !row.settlementTokenId ||
      !row.settlementPositionId ||
      !row.settlementSourceMarketId ||
      !row.settlementQuestion ||
      !row.settlementOutcome ||
      !row.settlementDueAt ||
      row.settlementOutcomeIndex === null ||
      row.settlementOutcomeIndex === undefined ||
      !row.settlementPayoutSlotCount
  );
  if (incomplete) {
    throw new Error("ticket_settlement_identity_incomplete");
  }

  return result.rows.map((row) => ({
    ticketLegId: row.ticketLegId,
    ticketId: row.ticketId,
    settlementSource: row.settlementSource!,
    settlementAuthority: row.settlementAuthority!,
    settlementChainId: row.settlementChainId!,
    settlementContractAddress: row.settlementContractAddress!,
    settlementCollateralAddress: row.settlementCollateralAddress!,
    settlementConditionId: row.settlementConditionId!,
    settlementTokenId: row.settlementTokenId!,
    settlementOutcomeIndex: row.settlementOutcomeIndex!,
    settlementPayoutSlotCount: row.settlementPayoutSlotCount!,
    settlementQuestionId: row.settlementQuestionId || undefined,
    settlementUmaAdapter: row.settlementUmaAdapter || undefined,
    settlementUmaAdapterVersion: row.settlementUmaAdapterVersion || undefined,
    settlementEventId: row.settlementEventId || undefined,
    settlementNegRiskGroupId: row.settlementNegRiskGroupId || undefined,
    settlementNegRisk: row.settlementNegRisk ?? undefined,
    settlementRulesSnapshotHash: row.settlementRulesSnapshotHash || undefined,
    settlementSourceSnapshotId: row.settlementSourceSnapshotId || undefined,
    settlementQuestion: row.settlementQuestion || undefined,
    settlementOutcome: row.settlementOutcome || undefined,
    settlementSourceMarketId: row.settlementSourceMarketId || undefined,
    settlementPositionId: row.settlementPositionId || undefined,
    settlementCollectionId: row.settlementCollectionId || undefined,
    settlementDueAt: row.settlementDueAt!.toISOString(),
    // Candidate identities are deliberately not frozen until their CTF
    // position identity has been validated in the same transaction.
    settlementFrozenAt: row.settlementFrozenAt?.toISOString() || ""
  }));
}

async function finalizeTicketSettlementIdentities(
  client: pg.PoolClient,
  ticketId: string
): Promise<FrozenSettlementIdentity[]> {
  const result = await client.query<{
    ticketLegId: string;
    ticketId: string;
    settlementSource: string | null;
    settlementAuthority: SettlementAuthority | null;
    settlementChainId: number | null;
    settlementContractAddress: string | null;
    settlementCollateralAddress: string | null;
    settlementConditionId: string | null;
    settlementTokenId: string | null;
    settlementOutcomeIndex: number | null;
    settlementPayoutSlotCount: number | null;
    settlementQuestionId: string | null;
    settlementUmaAdapter: string | null;
    settlementUmaAdapterVersion: string | null;
    settlementEventId: string | null;
    settlementNegRiskGroupId: string | null;
    settlementNegRisk: boolean | null;
    settlementRulesSnapshotHash: string | null;
    settlementSourceSnapshotId: string | null;
    settlementQuestion: string | null;
    settlementOutcome: string | null;
    settlementSourceMarketId: string | null;
    settlementPositionId: string | null;
    settlementCollectionId: string | null;
    settlementFrozenAt: Date | null;
    settlementDueAt: Date | null;
  }>(
    `
      UPDATE ticket_legs
      SET settlement_frozen_at = COALESCE(settlement_frozen_at, now())
      WHERE ticket_id = $1
      RETURNING
        id AS "ticketLegId",
        ticket_id AS "ticketId",
        settlement_source AS "settlementSource",
        settlement_authority AS "settlementAuthority",
        settlement_chain_id AS "settlementChainId",
        settlement_contract_address AS "settlementContractAddress",
        settlement_collateral_address AS "settlementCollateralAddress",
        settlement_condition_id AS "settlementConditionId",
        settlement_token_id AS "settlementTokenId",
        settlement_outcome_index AS "settlementOutcomeIndex",
        settlement_payout_slot_count AS "settlementPayoutSlotCount",
        settlement_question_id AS "settlementQuestionId",
        settlement_uma_adapter AS "settlementUmaAdapter",
        settlement_uma_adapter_version AS "settlementUmaAdapterVersion",
        settlement_event_id AS "settlementEventId",
        settlement_neg_risk_group_id AS "settlementNegRiskGroupId",
        settlement_neg_risk AS "settlementNegRisk",
        settlement_rules_snapshot_hash AS "settlementRulesSnapshotHash",
        settlement_source_snapshot_id::text AS "settlementSourceSnapshotId",
        settlement_question AS "settlementQuestion",
        settlement_outcome AS "settlementOutcome",
        settlement_source_market_id AS "settlementSourceMarketId",
        settlement_position_id AS "settlementPositionId",
        settlement_collection_id AS "settlementCollectionId",
        settlement_frozen_at AS "settlementFrozenAt",
        settlement_due_at AS "settlementDueAt"
    `,
    [ticketId]
  );

  const incomplete = result.rows.find(
    (row) =>
      row.settlementSource !== "polymarket_ctf" ||
      !row.settlementAuthority ||
      row.settlementChainId !== 137 ||
      !row.settlementContractAddress ||
      !row.settlementCollateralAddress ||
      !row.settlementConditionId ||
      !row.settlementTokenId ||
      !row.settlementPositionId ||
      (row.settlementAuthority === "polygon_ctf" && !row.settlementCollectionId) ||
      !row.settlementDueAt ||
      row.settlementOutcomeIndex === null ||
      row.settlementOutcomeIndex === undefined ||
      !row.settlementPayoutSlotCount ||
      !row.settlementQuestion ||
      !row.settlementOutcome ||
      !row.settlementSourceMarketId ||
      !row.settlementSourceSnapshotId ||
      !row.settlementRulesSnapshotHash ||
      !row.settlementFrozenAt
  );
  if (incomplete) throw new Error("ticket_settlement_identity_incomplete");

  return result.rows.map((row) => ({
    ticketLegId: row.ticketLegId,
    ticketId: row.ticketId,
    settlementSource: row.settlementSource!,
    settlementAuthority: row.settlementAuthority!,
    settlementChainId: row.settlementChainId!,
    settlementContractAddress: row.settlementContractAddress!,
    settlementCollateralAddress: row.settlementCollateralAddress!,
    settlementConditionId: row.settlementConditionId!,
    settlementTokenId: row.settlementTokenId!,
    settlementOutcomeIndex: row.settlementOutcomeIndex!,
    settlementPayoutSlotCount: row.settlementPayoutSlotCount!,
    settlementQuestionId: row.settlementQuestionId || undefined,
    settlementUmaAdapter: row.settlementUmaAdapter || undefined,
    settlementUmaAdapterVersion: row.settlementUmaAdapterVersion || undefined,
    settlementEventId: row.settlementEventId || undefined,
    settlementNegRiskGroupId: row.settlementNegRiskGroupId || undefined,
    settlementNegRisk: row.settlementNegRisk ?? undefined,
    settlementRulesSnapshotHash: row.settlementRulesSnapshotHash || undefined,
    settlementSourceSnapshotId: row.settlementSourceSnapshotId || undefined,
    settlementQuestion: row.settlementQuestion || undefined,
    settlementOutcome: row.settlementOutcome || undefined,
    settlementSourceMarketId: row.settlementSourceMarketId || undefined,
    settlementPositionId: row.settlementPositionId || undefined,
    settlementCollectionId: row.settlementCollectionId || undefined,
    settlementDueAt: row.settlementDueAt!.toISOString(),
    settlementFrozenAt: row.settlementFrozenAt!.toISOString()
  }));
}

export type ValidateFrozenSettlementIdentitiesInput = {
  ticketId: string;
  validateIdentity?: typeof validateCtfSettlementIdentity;
  candidateIdentities?: FrozenSettlementIdentity[];
  validateCandidateIdentity?: (identity: FrozenSettlementIdentity) => Promise<SettlementIdentityValidation>;
};

export type SettlementIdentityValidation =
  | (CtfSettlementIdentityValidation & { authority?: "polygon_ctf" })
  | PolymarketApiIdentityValidation;

export type FrozenSettlementIdentityValidationResult = {
  ticketLegId: string;
  valid: boolean;
  retryable: boolean;
  computedPositionId?: string;
  collectionId?: string;
  blockNumber?: number;
  blockHash?: string;
  authority: SettlementAuthority;
  identityFingerprint?: string;
  error?: string;
};

class SettlementIdentityValidationFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

export async function validateFrozenSettlementIdentitiesForTicketInTransaction(
  client: pg.PoolClient,
  input: ValidateFrozenSettlementIdentitiesInput
): Promise<FrozenSettlementIdentityValidationResult[]> {
  const validator = input.validateIdentity || validateCtfSettlementIdentity;
  const rows = await client.query<{
    ticketLegId: string;
    settlementAuthority: SettlementAuthority | null;
    settlementChainId: number | null;
    settlementContractAddress: string | null;
    settlementCollateralAddress: string | null;
    settlementConditionId: string | null;
    settlementTokenId: string | null;
    settlementOutcomeIndex: number | null;
    settlementPayoutSlotCount: number | null;
    settlementSourceMarketId: string | null;
    settlementOutcome: string | null;
    settlementNegRisk: boolean | null;
  }>(
    `
      SELECT
        id AS "ticketLegId",
        settlement_authority AS "settlementAuthority",
        settlement_chain_id AS "settlementChainId",
        settlement_contract_address AS "settlementContractAddress",
        settlement_collateral_address AS "settlementCollateralAddress",
        settlement_condition_id AS "settlementConditionId",
        settlement_token_id AS "settlementTokenId",
        settlement_outcome_index AS "settlementOutcomeIndex",
        settlement_payout_slot_count AS "settlementPayoutSlotCount",
        settlement_source_market_id AS "settlementSourceMarketId",
        settlement_outcome AS "settlementOutcome",
        settlement_neg_risk AS "settlementNegRisk"
      FROM ticket_legs
      WHERE ticket_id = $1
      ORDER BY created_at ASC
      FOR UPDATE
    `,
    [input.ticketId]
  );

  if (rows.rows.length === 0) {
    throw new Error("ticket_settlement_identity_no_legs");
  }

  const results: FrozenSettlementIdentityValidationResult[] = [];
  for (const row of rows.rows) {
    if (
      !row.settlementChainId ||
      !row.settlementAuthority ||
      !row.settlementContractAddress ||
      !row.settlementCollateralAddress ||
      !row.settlementConditionId ||
      !row.settlementTokenId ||
      row.settlementOutcomeIndex === null ||
      row.settlementOutcomeIndex === undefined
    ) {
      throw new Error(`settlement_identity_not_frozen:${row.ticketLegId}`);
    }

    const candidate = input.candidateIdentities?.find((identity) => identity.ticketLegId === row.ticketLegId);
    let validation: SettlementIdentityValidation;
    if (candidate && input.validateCandidateIdentity) {
      validation = await input.validateCandidateIdentity(candidate);
    } else if (row.settlementAuthority === "polymarket_api") {
      if (!row.settlementSourceMarketId || !row.settlementOutcome) {
        throw new Error(`settlement_identity_not_frozen:${row.ticketLegId}`);
      }
      validation = await validatePolymarketApiSettlementIdentity({
        sourceMarketId: row.settlementSourceMarketId,
        conditionId: row.settlementConditionId,
        tokenId: row.settlementTokenId,
        outcome: row.settlementOutcome,
        outcomeIndex: row.settlementOutcomeIndex,
        outcomeSlotCount: row.settlementPayoutSlotCount || 2,
        negRisk: row.settlementNegRisk ?? undefined
      });
    } else {
      validation = {
        authority: "polygon_ctf",
        ...(await validator({
          chainId: row.settlementChainId,
          contractAddress: row.settlementContractAddress,
          collateralAddress: row.settlementCollateralAddress,
          conditionId: row.settlementConditionId,
          tokenId: row.settlementTokenId,
          outcomeIndex: row.settlementOutcomeIndex,
          outcomeSlotCount: row.settlementPayoutSlotCount || 2
        }))
      };
    }

    const authority = row.settlementAuthority;
    const ctfValidation = validation as CtfSettlementIdentityValidation;
    const apiValidation = validation as PolymarketApiIdentityValidation;
    let validationError = validation.error;
    if (validation.valid && authority === "polymarket_api") {
      const providers = new Set(
        apiValidation.providerEvidence
          .filter((item) => item.status === "ok")
          .map((item) => item.provider)
      );
      if (
        apiValidation.authority !== "polymarket_api" ||
        apiValidation.computedPositionId !== row.settlementTokenId ||
        !apiValidation.identityFingerprint ||
        !providers.has("gamma") ||
        !providers.has("clob")
      ) {
        validationError = "polymarket_api_identity_validation_incomplete";
      }
    } else if (validation.valid) {
      if (
        !ctfValidation.computedPositionId ||
        !ctfValidation.collectionId ||
        ctfValidation.blockNumber === undefined ||
        ctfValidation.blockNumber === null ||
        !ctfValidation.blockHash
      ) {
        validationError = "ctf_identity_validation_incomplete";
      } else {
        try {
          assertActivationGradePositionValidation(row, ctfValidation);
        } catch (error) {
          validationError = error instanceof Error ? error.message : "ctf_identity_validation_provenance_invalid";
        }
      }
    }
    const validationPassed = validation.valid && !validationError;
    const blockNumber = authority === "polygon_ctf" ? ctfValidation.blockNumber : undefined;
    const blockHash = authority === "polygon_ctf" ? ctfValidation.blockHash : undefined;
    const collectionId = authority === "polygon_ctf" ? ctfValidation.collectionId : undefined;
    const identityFingerprint = authority === "polymarket_api" ? apiValidation.identityFingerprint : undefined;

    const validationProofId = await recordSettlementProof(client, {
      ticketLegId: row.ticketLegId,
      source: "legwork_settlement_identity",
      proofKind: authority === "polymarket_api" ? "polymarket_api_identity_validation" : "ctf_position_id_validation",
      result: validationPassed ? "pending" : "blocked",
      confidence: authority === "polygon_ctf" && validationPassed ? "onchain_confirmed" : "api_signal",
      chainId: row.settlementChainId,
      contractAddress: row.settlementContractAddress,
      collateralAddress: row.settlementCollateralAddress,
      conditionId: row.settlementConditionId,
      tokenId: row.settlementTokenId,
      outcomeIndex: row.settlementOutcomeIndex,
      blockNumber,
      blockHash,
      providerEvidence: validation.providerEvidence,
      raw: {
        ...validation,
        authority,
        identityFingerprint
      }
    });

    await client.query(
      `
        INSERT INTO audit_log (action, entity_type, entity_id, metadata)
        VALUES ('ticket_leg.settlement_identity_validated', 'ticket_leg', $1, $2)
      `,
      [
        row.ticketLegId,
        {
          ticketId: input.ticketId,
          valid: validationPassed,
          authority,
          retryable: validation.retryable,
          error: validationError || null,
          computedPositionId: validation.computedPositionId || null,
          collectionId: collectionId || null,
          identityFingerprint: identityFingerprint || null,
          blockNumber: blockNumber === undefined ? null : blockNumber.toString(),
          blockHash: blockHash || null
        }
      ]
    );

    if (!validationPassed) {
      await client.query(
        `
          UPDATE ticket_legs
          SET
            resolution_state = CASE WHEN $3::boolean THEN resolution_state ELSE 'settlement_blocked' END,
            last_resolution_error = $2,
            resolution_updated_at = now(),
            next_resolution_check_at = now() + CASE WHEN $3::boolean THEN interval '5 minutes' ELSE interval '1 hour' END
          WHERE id = $1
            AND status IN ('pending', 'disputed')
        `,
        [row.ticketLegId, validationError || "settlement_identity_validation_failed", validation.retryable]
      );
      throw new SettlementIdentityValidationFailure(
        `settlement_identity_validation_failed:${row.ticketLegId}:${validationError || "unknown"}`,
        validation.retryable
      );
    }

    const computedPositionId = validation.computedPositionId;

    await client.query(
      `
        UPDATE ticket_legs
        SET
          settlement_position_id = $2,
          settlement_collection_id = $3,
          settlement_identity_validation_proof_id = $4,
          settlement_identity_validation_block_number = $5,
          settlement_identity_validation_block_hash = $6,
          settlement_identity_raw = COALESCE(settlement_identity_raw, '{}'::jsonb)
            || jsonb_strip_nulls(jsonb_build_object(
              'positionId', $2::text,
              'collectionId', $3::text,
              'validationProofId', $4::text,
              'validationBlockHash', $6::text,
              'validationAuthority', $7::text,
              'identityFingerprint', $8::text
            ))
        WHERE id = $1
      `,
      [row.ticketLegId, computedPositionId, collectionId, validationProofId, blockNumber, blockHash, authority, identityFingerprint]
    );

    results.push({
      ticketLegId: row.ticketLegId,
      valid: validation.valid,
      retryable: validation.retryable,
      computedPositionId: validation.computedPositionId,
      collectionId,
      blockNumber,
      blockHash,
      authority,
      identityFingerprint,
      error: validation.error
    });
  }

  return results;
}

export async function validateAndFreezeTicketSettlementIdentitiesInTransaction(
  client: pg.PoolClient,
  input: ValidateFrozenSettlementIdentitiesInput
): Promise<FrozenSettlementIdentity[]> {
  await validateFrozenSettlementIdentitiesForTicketInTransaction(client, input);
  return finalizeTicketSettlementIdentities(client, input.ticketId);
}

export async function quarantineSettlementTicket(input: {
  ticketId: string;
  reason: string;
  retryable: boolean;
  retrySeconds?: number;
}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `
        UPDATE ticket_legs
        SET
          resolution_state = 'settlement_blocked',
          last_resolution_error = $2,
          resolution_updated_at = now(),
          next_resolution_check_at = now() + ($3::text || ' seconds')::interval
        WHERE ticket_id = $1
          AND status IN ('pending', 'disputed')
      `,
      [input.ticketId, input.reason, input.retrySeconds ?? 3600]
    );
    const quarantines = await client.query<{ quarantine_count: number }>(
      `
        INSERT INTO settlement_identity_quarantines (
          ticket_leg_id,
          ticket_id,
          reason,
          identity_snapshot,
          retryable,
          next_retry_at,
          resolved_at
        )
        SELECT
          id,
          ticket_id,
          $2,
          to_jsonb(ticket_legs),
          $3,
          CASE WHEN $3 THEN now() + ($4::text || ' seconds')::interval ELSE NULL END,
          NULL
        FROM ticket_legs
        WHERE ticket_id = $1
          AND status IN ('pending', 'disputed')
        ON CONFLICT (ticket_leg_id) DO UPDATE
        SET
          reason = EXCLUDED.reason,
          identity_snapshot = EXCLUDED.identity_snapshot,
          last_quarantined_at = now(),
          quarantine_count = settlement_identity_quarantines.quarantine_count + 1,
          retryable = EXCLUDED.retryable,
          next_retry_at = EXCLUDED.next_retry_at,
          resolved_at = NULL
        RETURNING quarantine_count
      `,
      [input.ticketId, input.reason, input.retryable, input.retrySeconds ?? 300]
    );
    const attempts = Math.max(0, ...quarantines.rows.map((row) => row.quarantine_count));
    await client.query(
      `
        INSERT INTO audit_log (action, entity_type, entity_id, metadata)
        VALUES ('ticket.settlement_quarantined', 'ticket', $1, $2)
      `,
      [
        input.ticketId,
        {
          reason: input.reason,
          affectedLegs: updated.rowCount || 0,
          retryable: input.retryable,
          attempts
        }
      ]
    );
    await client.query("COMMIT");
    return updated.rowCount || 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function backfillSettlementIdentities(
  limit = 100,
  dependencies: { validateIdentity?: typeof validateCtfSettlementIdentity } = {}
) {
  const tickets = await getPool().query<{ ticketId: string }>(
    `
      SELECT DISTINCT ticket_legs.ticket_id AS "ticketId"
      FROM ticket_legs
      JOIN tickets ON tickets.id = ticket_legs.ticket_id
      WHERE tickets.status IN ('accepted', 'live', 'won', 'lost', 'voided')
        AND NOT EXISTS (
          SELECT 1
          FROM settlement_identity_quarantines
          WHERE settlement_identity_quarantines.ticket_id = ticket_legs.ticket_id
            AND settlement_identity_quarantines.resolved_at IS NULL
            AND (
              settlement_identity_quarantines.retryable = false
              OR settlement_identity_quarantines.next_retry_at > now()
            )
        )
        AND (
          ticket_legs.settlement_frozen_at IS NULL
          OR ticket_legs.settlement_condition_id IS NULL
          OR ticket_legs.settlement_token_id IS NULL
          OR ticket_legs.settlement_outcome_index IS NULL
          OR ticket_legs.settlement_position_id IS NULL
        )
      ORDER BY ticket_legs.ticket_id
      LIMIT $1
    `,
    [limit]
  );

  const results: Array<{ ticketId: string; status: "frozen" | "retryable" | "quarantined" | "skipped"; error?: string }> = [];
  for (const ticket of tickets.rows) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const lockedTicket = await client.query<{ status: string }>(
        "SELECT status FROM tickets WHERE id = $1 FOR UPDATE",
        [ticket.ticketId]
      );
      if (!lockedTicket.rows[0]) throw new Error("ticket_not_found");
      if (!["accepted", "live", "won", "lost", "voided"].includes(lockedTicket.rows[0].status)) {
        await client.query("COMMIT");
        results.push({ ticketId: ticket.ticketId, status: "skipped" });
        continue;
      }
      await prepareTicketSettlementIdentities(client, { ticketId: ticket.ticketId });
      await validateAndFreezeTicketSettlementIdentitiesInTransaction(client, {
        ticketId: ticket.ticketId,
        validateIdentity: dependencies.validateIdentity
      });
      await client.query(
        `
          UPDATE ticket_legs
          SET
            resolution_state = 'pending',
            last_resolution_error = NULL,
            resolution_updated_at = now(),
            next_resolution_check_at = now()
          WHERE ticket_id = $1
            AND status IN ('pending', 'disputed')
            AND EXISTS (
              SELECT 1
              FROM settlement_identity_quarantines
              WHERE settlement_identity_quarantines.ticket_leg_id = ticket_legs.id
                AND settlement_identity_quarantines.resolved_at IS NULL
            )
        `,
        [ticket.ticketId]
      );
      await client.query(
        `
          UPDATE settlement_identity_quarantines
          SET resolved_at = now(), next_retry_at = NULL
          WHERE ticket_id = $1
            AND resolved_at IS NULL
        `,
        [ticket.ticketId]
      );
      await client.query("COMMIT");
      results.push({ ticketId: ticket.ticketId, status: "frozen" });
    } catch (error) {
      await client.query("ROLLBACK");
      const message = error instanceof Error ? error.message : "settlement_identity_backfill_failed";
      const retryable = error instanceof SettlementIdentityValidationFailure && error.retryable;
      await quarantineSettlementTicket({ ticketId: ticket.ticketId, reason: message, retryable });
      results.push({ ticketId: ticket.ticketId, status: retryable ? "retryable" : "quarantined", error: message });
    } finally {
      client.release();
    }
  }

  return {
    checked: tickets.rows.length,
    results
  };
}

export async function getSettlementIdentityQuarantineSummary() {
  const result = await getPool().query<{
    unresolved: string;
    permanent: string;
    retryable: string;
  }>(
    `
      SELECT
        count(*) FILTER (WHERE resolved_at IS NULL)::text AS unresolved,
        count(*) FILTER (WHERE resolved_at IS NULL AND retryable = false)::text AS permanent,
        count(*) FILTER (WHERE resolved_at IS NULL AND retryable = true)::text AS retryable
      FROM settlement_identity_quarantines
    `
  );
  return {
    unresolved: Number(result.rows[0]?.unresolved || 0),
    permanent: Number(result.rows[0]?.permanent || 0),
    retryable: Number(result.rows[0]?.retryable || 0)
  };
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
      userClaimable: "user_usdc_claimable",
      houseOperating: "house_usdc_operating",
      houseReserve: "house_usdc_reserve"
    };
  }

  return {
    userAvailable: "play_money",
    userClaimable: "play_money_claimable",
    houseOperating: "house_play_money",
    houseReserve: "house_play_money_reserve"
  };
}

type LockedSettlementIdentity = {
  settlementSource: string | null;
  settlementAuthority: SettlementAuthority | null;
  settlementChainId: number | null;
  settlementContractAddress: string | null;
  settlementCollateralAddress: string | null;
  settlementConditionId: string | null;
  settlementTokenId: string | null;
  settlementPositionId: string | null;
  settlementSourceMarketId: string | null;
  settlementOutcome: string | null;
  settlementOutcomeIndex: number | null;
  settlementPayoutSlotCount: number | null;
  settlementIdentityValidationProofId: string | null;
  settlementIdentityValidationBlockNumber: string | null;
  settlementIdentityValidationBlockHash: string | null;
  settlementFrozenAt: Date | null;
};

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function canonicalUint(value: BigintLike | undefined, errorCode: string) {
  if (value === undefined || (typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new Error(errorCode);
  }
  const text = value.toString();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(errorCode);
  return BigInt(text);
}

function expectedProviderLabel(index: number) {
  if (index === 0) return "primary";
  if (index === 1) return "secondary";
  return `rpc_${index + 1}`;
}

function assertActivationGradePositionValidation(
  identity: {
    settlementChainId: number | null;
    settlementContractAddress: string | null;
    settlementCollateralAddress: string | null;
    settlementConditionId: string | null;
    settlementTokenId: string | null;
    settlementOutcomeIndex: number | null;
  },
  validation: CtfSettlementIdentityValidation
) {
  if (
    identity.settlementChainId !== config.POLYGON_SETTLEMENT_CHAIN_ID ||
    identity.settlementChainId !== 137 ||
    !identity.settlementContractAddress ||
    !sameHex(identity.settlementContractAddress, config.POLYMARKET_CTF_ADDRESS) ||
    !identity.settlementCollateralAddress ||
    !sameHex(identity.settlementCollateralAddress, config.POLYMARKET_COLLATERAL_ADDRESS) ||
    !identity.settlementConditionId ||
    !identity.settlementTokenId ||
    identity.settlementOutcomeIndex === null ||
    validation.computedPositionId !== identity.settlementTokenId ||
    !validation.collectionId ||
    !/^0x[0-9a-fA-F]{64}$/.test(validation.collectionId) ||
    validation.blockNumber === undefined ||
    !Number.isSafeInteger(validation.blockNumber) ||
    validation.blockNumber <= 0 ||
    !validation.blockHash ||
    !/^0x[0-9a-fA-F]{64}$/.test(validation.blockHash)
  ) {
    throw new Error("ctf_identity_validation_provenance_invalid");
  }

  if (config.POLYGON_RPC_ENDPOINTS.length < config.SETTLEMENT_RPC_QUORUM) {
    throw new Error("ctf_position_rpc_quorum_unconfigured");
  }

  const blockHash = validation.blockHash.toLowerCase();
  const operators = new Set<string>();
  const endpoints = new Set<string>();
  for (const [index, endpoint] of config.POLYGON_RPC_ENDPOINTS.entries()) {
    const item = validation.providerEvidence.find(
      (candidate) => candidate.status === "ok" && candidate.rpcEndpointId === endpoint.endpointId
    );
    if (!item) continue;
    const proofBlockNumber = item.blockNumber ?? item.proofBlockNumber;
    const proofBlockHash = item.blockHash ?? item.proofBlockHash;
    const canonicalRead =
      (item.readMode === "blockHash" && item.blockHashReadSupported === true) ||
      (item.readMode === "blockNumber_reverified" && item.blockHashReverified === true);
    if (
      item.provider !== expectedProviderLabel(index) ||
      item.rpcOperator !== endpoint.operator ||
      item.rpcHost !== new URL(endpoint.url).host ||
      item.chainId !== identity.settlementChainId ||
      proofBlockNumber !== validation.blockNumber ||
      typeof proofBlockHash !== "string" ||
      proofBlockHash.toLowerCase() !== blockHash ||
      item.computedPositionId !== validation.computedPositionId ||
      !item.collectionId ||
      !sameHex(item.collectionId, validation.collectionId) ||
      item.finalizedBlockNumber === undefined ||
      item.finalizedBlockNumber < validation.blockNumber ||
      !canonicalRead
    ) {
      throw new Error("ctf_identity_validation_provenance_invalid");
    }
    operators.add(endpoint.operator);
    endpoints.add(endpoint.endpointId);
  }

  if (operators.size < config.SETTLEMENT_RPC_QUORUM || endpoints.size < config.SETTLEMENT_RPC_QUORUM) {
    throw new Error("ctf_position_quorum_unavailable");
  }
}

function assertHouseBookCtfFinality(
  input: {
    source?: string;
    result: SettlementResult;
    proofReference?: string;
    proof?: Omit<SettlementProofInput, "ticketLegId">;
  },
  leg: LockedSettlementIdentity
) {
  const proof = input.proof;
  if (
    leg.settlementAuthority !== "polygon_ctf" ||
    leg.settlementSource !== "polymarket_ctf" ||
    leg.settlementChainId !== 137 ||
    leg.settlementChainId !== config.POLYGON_SETTLEMENT_CHAIN_ID ||
    !leg.settlementContractAddress ||
    !sameHex(leg.settlementContractAddress, config.POLYMARKET_CTF_ADDRESS) ||
    !leg.settlementCollateralAddress ||
    !sameHex(leg.settlementCollateralAddress, config.POLYMARKET_COLLATERAL_ADDRESS) ||
    !leg.settlementConditionId ||
    !leg.settlementTokenId ||
    !leg.settlementPositionId ||
    leg.settlementPositionId !== leg.settlementTokenId ||
    leg.settlementOutcomeIndex === null ||
    leg.settlementPayoutSlotCount === null ||
    !leg.settlementIdentityValidationProofId ||
    !leg.settlementIdentityValidationBlockNumber ||
    !leg.settlementIdentityValidationBlockHash ||
    !/^0x[0-9a-fA-F]{64}$/.test(leg.settlementIdentityValidationBlockHash) ||
    !leg.settlementFrozenAt
  ) {
    throw new Error("house_book_settlement_frozen_identity_invalid");
  }

  if (
    input.source !== "polymarket_ctf" ||
    proof?.source !== "polymarket_ctf" ||
    proof.confidence !== "onchain_confirmed" ||
    proof.chainId !== leg.settlementChainId ||
    !proof.contractAddress ||
    !sameHex(proof.contractAddress, leg.settlementContractAddress) ||
    !proof.collateralAddress ||
    !sameHex(proof.collateralAddress, leg.settlementCollateralAddress) ||
    !proof.conditionId ||
    !sameHex(proof.conditionId, leg.settlementConditionId) ||
    proof.tokenId !== leg.settlementTokenId ||
    proof.outcomeIndex !== leg.settlementOutcomeIndex ||
    proof.winningTokenId !== undefined ||
    proof.blockNumber === undefined ||
    !proof.blockHash ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.blockHash) ||
    !proof.payoutVector ||
    proof.payoutVector.length !== leg.settlementPayoutSlotCount ||
    proof.payoutNumerator === undefined ||
    proof.payoutVector[leg.settlementOutcomeIndex] === undefined ||
    !proof.resolvedAt ||
    !Number.isFinite(Date.parse(proof.resolvedAt))
  ) {
    throw new Error("house_book_settlement_requires_polygon_ctf_finality");
  }

  let payoutDenominator: bigint;
  let payoutVector: bigint[];
  let proofBlockNumber: bigint;
  let validationBlockNumber: bigint;
  try {
    payoutDenominator = canonicalUint(proof.payoutDenominator, "house_book_settlement_invalid_payout_denominator");
    payoutVector = proof.payoutVector.map((value) => canonicalUint(value, "house_book_settlement_invalid_payout_vector"));
    proofBlockNumber = canonicalUint(proof.blockNumber, "house_book_settlement_invalid_block_number");
    validationBlockNumber = canonicalUint(
      leg.settlementIdentityValidationBlockNumber,
      "house_book_settlement_frozen_identity_invalid"
    );
    if (payoutDenominator <= 0n) throw new Error("house_book_settlement_invalid_payout_denominator");
    if (proofBlockNumber <= 0n) throw new Error("house_book_settlement_invalid_block_number");
    if (validationBlockNumber <= 0n) throw new Error("house_book_settlement_frozen_identity_invalid");
    if (proofBlockNumber < validationBlockNumber) throw new Error("house_book_settlement_predates_identity_validation");
    if (
      proofBlockNumber === validationBlockNumber &&
      !sameHex(proof.blockHash, leg.settlementIdentityValidationBlockHash)
    ) {
      throw new Error("house_book_settlement_identity_validation_block_mismatch");
    }
    if (payoutVector.some((value) => value > payoutDenominator)) {
      throw new Error("house_book_settlement_invalid_payout_vector");
    }
    if (payoutVector.reduce((sum, value) => sum + value, 0n) !== payoutDenominator) {
      throw new Error("house_book_settlement_invalid_payout_vector");
    }
    if (canonicalUint(proof.payoutNumerator, "house_book_settlement_invalid_payout_vector") !== payoutVector[leg.settlementOutcomeIndex]) {
      throw new Error("house_book_settlement_payout_vector_mismatch");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("house_book_settlement")) throw error;
    throw new Error("house_book_settlement_invalid_payout_vector");
  }

  const hasPartialPayout = payoutVector.some((numerator) => numerator !== 0n && numerator !== payoutDenominator);
  const fullWinnerIndexes = payoutVector.flatMap((numerator, index) => (numerator === payoutDenominator ? [index] : []));
  const derivedResult: SettlementResult =
    hasPartialPayout || fullWinnerIndexes.length !== 1
      ? "voided"
      : fullWinnerIndexes[0] === leg.settlementOutcomeIndex
        ? "won"
        : "lost";
  const derivedProofKind = derivedResult === "voided" ? "ctf_partial_or_canceled_payout" : "ctf_payout_vector";
  if (
    input.result !== derivedResult ||
    proof.result !== derivedResult ||
    proof.proofKind !== derivedProofKind ||
    input.proofReference !== derivedProofKind
  ) {
    throw new Error("house_book_settlement_result_mismatch");
  }

  const evidence = Array.isArray(proof.providerEvidence) ? proof.providerEvidence : [];
  const proofBlockHash = proof.blockHash.toLowerCase();
  const configuredEndpoints = config.POLYGON_RPC_ENDPOINTS;
  if (configuredEndpoints.length < config.SETTLEMENT_RPC_QUORUM) {
    throw new Error("house_book_settlement_ctf_operator_quorum_unavailable");
  }

  const matchedOperators = new Set<string>();
  const matchedEndpoints = new Set<string>();
  for (const [index, endpoint] of configuredEndpoints.entries()) {
    const item = evidence.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const value = candidate as Record<string, unknown>;
      return value.status === "ok" && value.rpcEndpointId === endpoint.endpointId;
    });
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;

    let evidenceBlockNumber: bigint;
    let finalizedBlockNumber: bigint;
    let evidenceDenominator: bigint;
    let evidenceVector: bigint[];
    try {
      evidenceBlockNumber = canonicalUint(
        (value.blockNumber ?? value.proofBlockNumber) as BigintLike | undefined,
        "house_book_settlement_malformed_provider_evidence"
      );
      finalizedBlockNumber = canonicalUint(
        value.finalizedBlockNumber as BigintLike | undefined,
        "house_book_settlement_malformed_provider_evidence"
      );
      evidenceDenominator = canonicalUint(
        value.payoutDenominator as BigintLike | undefined,
        "house_book_settlement_malformed_provider_evidence"
      );
      if (!Array.isArray(value.payoutNumerators)) throw new Error("house_book_settlement_malformed_provider_evidence");
      evidenceVector = value.payoutNumerators.map((number) =>
        canonicalUint(number as BigintLike, "house_book_settlement_malformed_provider_evidence")
      );
    } catch {
      throw new Error("house_book_settlement_malformed_provider_evidence");
    }

    const blockHash = value.blockHash ?? value.proofBlockHash;
    const endpointHost = new URL(endpoint.url).host;
    const canonicalRead =
      (value.readMode === "blockHash" && value.blockHashReadSupported === true) ||
      (value.readMode === "blockNumber_reverified" && value.blockHashReverified === true);
    if (
      value.provider !== expectedProviderLabel(index) ||
      value.rpcOperator !== endpoint.operator ||
      value.rpcHost !== endpointHost ||
      value.chainId !== leg.settlementChainId ||
      evidenceBlockNumber !== proofBlockNumber ||
      finalizedBlockNumber < proofBlockNumber ||
      typeof blockHash !== "string" ||
      blockHash.toLowerCase() !== proofBlockHash ||
      evidenceDenominator !== payoutDenominator ||
      evidenceVector.length !== payoutVector.length ||
      evidenceVector.some((number, vectorIndex) => number !== payoutVector[vectorIndex]) ||
      !canonicalRead
    ) {
      throw new Error("house_book_settlement_malformed_provider_evidence");
    }
    matchedOperators.add(endpoint.operator);
    matchedEndpoints.add(endpoint.endpointId);
  }

  if (
    matchedOperators.size < config.SETTLEMENT_RPC_QUORUM ||
    matchedEndpoints.size < config.SETTLEMENT_RPC_QUORUM
  ) {
    throw new Error("house_book_settlement_ctf_operator_quorum_unavailable");
  }
}

function apiEvidenceRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalApiPrice(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (Math.abs(parsed) < 1e-9) return "0";
  if (Math.abs(parsed - 0.5) < 1e-9) return "0.5";
  if (Math.abs(parsed - 1) < 1e-9) return "1";
  return undefined;
}

async function assertHouseBookPolymarketApiFinality(
  client: pg.PoolClient,
  input: {
    ticketLegId: string;
    source?: string;
    result: SettlementResult;
    proofReference?: string;
    proof?: Omit<SettlementProofInput, "ticketLegId">;
  },
  leg: LockedSettlementIdentity
) {
  const proof = input.proof;
  if (
    leg.settlementAuthority !== "polymarket_api" ||
    leg.settlementSource !== "polymarket_ctf" ||
    leg.settlementChainId !== 137 ||
    !leg.settlementContractAddress ||
    !sameHex(leg.settlementContractAddress, config.POLYMARKET_CTF_ADDRESS) ||
    !leg.settlementCollateralAddress ||
    !sameHex(leg.settlementCollateralAddress, config.POLYMARKET_COLLATERAL_ADDRESS) ||
    !leg.settlementConditionId ||
    !leg.settlementTokenId ||
    leg.settlementPositionId !== leg.settlementTokenId ||
    !leg.settlementSourceMarketId ||
    !leg.settlementOutcome ||
    leg.settlementOutcomeIndex === null ||
    leg.settlementPayoutSlotCount === null ||
    !leg.settlementIdentityValidationProofId ||
    leg.settlementIdentityValidationBlockNumber !== null ||
    leg.settlementIdentityValidationBlockHash !== null ||
    !leg.settlementFrozenAt
  ) {
    throw new Error("house_book_settlement_frozen_identity_invalid");
  }

  if (
    input.source !== "polymarket_api" ||
    proof?.source !== "polymarket_api" ||
    proof.confidence !== "api_signal" ||
    proof.chainId !== leg.settlementChainId ||
    !proof.contractAddress ||
    !sameHex(proof.contractAddress, leg.settlementContractAddress) ||
    !proof.collateralAddress ||
    !sameHex(proof.collateralAddress, leg.settlementCollateralAddress) ||
    !proof.conditionId ||
    !sameHex(proof.conditionId, leg.settlementConditionId) ||
    proof.tokenId !== leg.settlementTokenId ||
    proof.outcomeIndex !== leg.settlementOutcomeIndex ||
    proof.blockNumber !== undefined ||
    proof.blockHash !== undefined ||
    !proof.payoutVector ||
    proof.payoutVector.length !== leg.settlementPayoutSlotCount ||
    proof.payoutNumerator === undefined ||
    proof.payoutDenominator === undefined ||
    !proof.resolvedAt ||
    !Number.isFinite(Date.parse(proof.resolvedAt))
  ) {
    throw new Error("house_book_settlement_requires_polymarket_api_finality");
  }

  const payoutDenominator = canonicalUint(proof.payoutDenominator, "house_book_settlement_invalid_payout_denominator");
  const payoutVector = proof.payoutVector.map((value) => canonicalUint(value, "house_book_settlement_invalid_payout_vector"));
  if (
    payoutDenominator <= 0n ||
    payoutVector.some((value) => value > payoutDenominator) ||
    payoutVector.reduce((sum, value) => sum + value, 0n) !== payoutDenominator ||
    canonicalUint(proof.payoutNumerator, "house_book_settlement_invalid_payout_vector") !==
      payoutVector[leg.settlementOutcomeIndex]
  ) {
    throw new Error("house_book_settlement_invalid_payout_vector");
  }

  const hasPartialPayout = payoutVector.some((numerator) => numerator !== 0n && numerator !== payoutDenominator);
  const fullWinnerIndexes = payoutVector.flatMap((numerator, index) => (numerator === payoutDenominator ? [index] : []));
  const derivedResult: SettlementResult =
    hasPartialPayout || fullWinnerIndexes.length !== 1
      ? "voided"
      : fullWinnerIndexes[0] === leg.settlementOutcomeIndex
        ? "won"
        : "lost";
  const derivedProofKind = derivedResult === "voided" ? "polymarket_api_50_50_void" : "polymarket_api_outcome";
  if (
    input.result !== derivedResult ||
    proof.result !== derivedResult ||
    proof.proofKind !== derivedProofKind ||
    input.proofReference !== derivedProofKind
  ) {
    throw new Error("house_book_settlement_result_mismatch");
  }

  const evidence = Array.isArray(proof.providerEvidence) ? proof.providerEvidence.map(apiEvidenceRecord).filter(Boolean) : [];
  const gamma = evidence.find((item) => item?.provider === "gamma" && item.status === "ok");
  const clob = evidence.find((item) => item?.provider === "clob" && item.status === "ok");
  const gammaPrices = Array.isArray(gamma?.outcomePrices) ? gamma!.outcomePrices.map(canonicalApiPrice) : [];
  const gammaTokenIds = Array.isArray(gamma?.tokenIds) ? gamma!.tokenIds : [];
  const gammaOutcomes = Array.isArray(gamma?.outcomes) ? gamma!.outcomes : [];
  const clobTokens = Array.isArray(clob?.tokens) ? clob!.tokens.map(apiEvidenceRecord).filter(Boolean) : [];
  const selectedGammaOutcome = gammaOutcomes[leg.settlementOutcomeIndex];
  const selectedGammaToken = gammaTokenIds[leg.settlementOutcomeIndex];
  if (
    !gamma ||
    !clob ||
    gamma.sourceMarketId !== leg.settlementSourceMarketId ||
    typeof gamma.conditionId !== "string" ||
    !sameHex(gamma.conditionId, leg.settlementConditionId) ||
    gamma.closed !== true ||
    typeof gamma.umaResolutionStatus !== "string" ||
    gamma.umaResolutionStatus.trim().toLowerCase() !== "resolved" ||
    typeof clob.conditionId !== "string" ||
    !sameHex(clob.conditionId, leg.settlementConditionId) ||
    clob.closed !== true ||
    clob.acceptingOrders !== false ||
    gammaPrices.length !== leg.settlementPayoutSlotCount ||
    gammaTokenIds.length !== leg.settlementPayoutSlotCount ||
    gammaOutcomes.length !== leg.settlementPayoutSlotCount ||
    clobTokens.length !== leg.settlementPayoutSlotCount ||
    selectedGammaToken !== leg.settlementTokenId ||
    typeof selectedGammaOutcome !== "string" ||
    selectedGammaOutcome.trim().toLowerCase() !== leg.settlementOutcome.trim().toLowerCase()
  ) {
    throw new Error("house_book_settlement_malformed_provider_evidence");
  }

  if (derivedResult === "voided") {
    if (
      payoutDenominator !== 2n ||
      payoutVector.some((value) => value !== 1n) ||
      gammaPrices.some((value) => value !== "0.5") ||
      clob.is50_50Outcome !== true ||
      proof.winningTokenId !== undefined ||
      clobTokens.some((token) => token?.winner === true || canonicalApiPrice(token?.price) !== "0.5")
    ) {
      throw new Error("house_book_settlement_malformed_provider_evidence");
    }
  } else {
    const winningIndex = payoutVector.findIndex((value) => value === payoutDenominator);
    const winningTokenId = gammaTokenIds[winningIndex];
    const clobWinners = clobTokens.filter((token) => token?.winner === true);
    if (
      payoutDenominator !== 1n ||
      gammaPrices.some((value, index) => value !== payoutVector[index]?.toString()) ||
      !winningTokenId ||
      proof.winningTokenId !== winningTokenId ||
      clobWinners.length !== 1 ||
      clobWinners[0]?.tokenId !== winningTokenId
    ) {
      throw new Error("house_book_settlement_malformed_provider_evidence");
    }
  }

  const raw = apiEvidenceRecord(proof.raw);
  const candidateProofId = typeof raw?.candidateProofId === "string" ? raw.candidateProofId : undefined;
  const fingerprint = typeof raw?.fingerprint === "string" ? raw.fingerprint : undefined;
  const firstObservedAt = typeof raw?.firstObservedAt === "string" ? raw.firstObservedAt : undefined;
  const confirmedAt = typeof raw?.confirmedAt === "string" ? raw.confirmedAt : undefined;
  if (
    !candidateProofId ||
    !fingerprint ||
    !firstObservedAt ||
    !confirmedAt ||
    !Number.isFinite(Date.parse(firstObservedAt)) ||
    !Number.isFinite(Date.parse(confirmedAt)) ||
    Date.parse(confirmedAt) - Date.parse(firstObservedAt) < config.SETTLEMENT_API_STABILITY_MS
  ) {
    throw new Error("house_book_settlement_api_stability_unproven");
  }

  const candidate = await client.query<{
    result: string;
    conditionId: string | null;
    tokenId: string | null;
    outcomeIndex: number | null;
    payoutNumerator: string | null;
    payoutDenominator: string | null;
    payoutVector: string[] | null;
    raw: unknown;
    createdAt: Date;
    checkedAt: Date;
  }>(
    `
      SELECT
        result,
        condition_id AS "conditionId",
        token_id AS "tokenId",
        outcome_index AS "outcomeIndex",
        payout_numerator::text AS "payoutNumerator",
        payout_denominator::text AS "payoutDenominator",
        payout_vector::text[] AS "payoutVector",
        raw,
        created_at AS "createdAt",
        now() AS "checkedAt"
      FROM settlement_proofs
      WHERE id = $1
        AND ticket_leg_id = $2
        AND source = 'polymarket_api'
        AND proof_kind = 'polymarket_api_resolution_candidate'
        AND confidence = 'api_signal'
      FOR SHARE
    `,
    [candidateProofId, input.ticketLegId]
  );
  const prior = candidate.rows[0];
  const priorRaw = apiEvidenceRecord(prior?.raw);
  if (
    !prior ||
    prior.result !== derivedResult ||
    !prior.conditionId ||
    !sameHex(prior.conditionId, leg.settlementConditionId) ||
    prior.tokenId !== leg.settlementTokenId ||
    prior.outcomeIndex !== leg.settlementOutcomeIndex ||
    prior.payoutNumerator !== proof.payoutNumerator?.toString() ||
    prior.payoutDenominator !== proof.payoutDenominator?.toString() ||
    !prior.payoutVector ||
    prior.payoutVector.length !== payoutVector.length ||
    prior.payoutVector.some((value, index) => value !== payoutVector[index]?.toString()) ||
    priorRaw?.fingerprint !== fingerprint ||
    priorRaw?.firstObservedAt !== firstObservedAt ||
    prior.createdAt.getTime() > Date.parse(confirmedAt)
  ) {
    throw new Error("house_book_settlement_api_candidate_mismatch");
  }
  if (prior.checkedAt.getTime() - prior.createdAt.getTime() < config.SETTLEMENT_API_STABILITY_MS) {
    throw new Error("house_book_settlement_api_stability_unproven");
  }
}

async function assertHouseBookSettlementFinality(
  client: pg.PoolClient,
  input: {
    ticketLegId: string;
    source?: string;
    result: SettlementResult;
    proofReference?: string;
    proof?: Omit<SettlementProofInput, "ticketLegId">;
  },
  leg: LockedSettlementIdentity
) {
  if (leg.settlementAuthority === "polymarket_api") {
    await assertHouseBookPolymarketApiFinality(client, input, leg);
    return;
  }
  assertHouseBookCtfFinality(input, leg);
}

async function makeFinalTicketClaimableIfNeeded(client: pg.PoolClient, ticketId: string, ticketStatus: SettledLeg["ticketStatus"]) {
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

  const finalAuditAction = ticketStatus === "lost" ? "ticket.reserve_released" : "ticket.claimable";
  const alreadyFinalized = await client.query<{ action: string }>(
    `
      SELECT action
      FROM audit_log
      WHERE action = ANY($2::text[])
        AND entity_type = 'ticket'
        AND entity_id = $1
      LIMIT 1
    `,
    [ticketId, ticketStatus === "lost" ? ["ticket.reserve_released"] : ["ticket.claimable", "ticket.paid"]]
  );

  if (alreadyFinalized.rows[0]) {
    if (ticketStatus === "lost") return "lost";
    return alreadyFinalized.rows[0].action === "ticket.paid" ? "paid" : "claimable";
  }

  const payoutMicroUsd = ticketStatus === "won" ? BigInt(row.offered_payout_micro_usd) : BigInt(row.stake_micro_usd);
  const accounts = accountTypes(row.accounting_mode);
  const currency = row.funding_currency;
  if (row.accounting_mode === "house_book_usdc" && currency !== "USDC") {
    throw new Error("invalid_house_book_currency");
  }
  const userClaimableAccountId = await ensureLedgerAccount(client, row.user_id, accounts.userClaimable, currency);
  const houseAccountId = await ensureLedgerAccount(client, null, accounts.houseOperating, currency);
  const houseReserveAccountId = await ensureLedgerAccount(client, null, accounts.houseReserve, currency);
  const transactionId = randomUUID();

  const reserve = await client.query<{
    id: string;
    net_liability_micro_units: string;
    status: string;
    release_transaction_id: string | null;
  }>(
    `
      SELECT id, net_liability_micro_units::text, status, release_transaction_id::text
      FROM ticket_reserves
      WHERE ticket_id = $1
      FOR UPDATE
    `,
    [ticketId]
  );
  const reserveRow = reserve.rows[0];
  const reservedLiability = BigInt(reserveRow?.net_liability_micro_units || 0);
  const releasesReserveNow = reservedLiability > 0n && reserveRow?.status === "reserved";
  const releaseTransactionId = releasesReserveNow
    ? randomUUID()
    : reserveRow?.release_transaction_id || null;

  if (releasesReserveNow) {
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, $5, 'ticket liability reserve released'),
          ($1, $4, $6, $5, 'ticket liability reserve released')
      `,
      [releaseTransactionId, houseReserveAccountId, (-reservedLiability).toString(), houseAccountId, currency, reservedLiability.toString()]
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
      [transactionId, userClaimableAccountId, payoutMicroUsd.toString(), houseAccountId, currency, "ticket settlement claimable", (-payoutMicroUsd).toString()]
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
      [reserveRow.id, ticketStatus === "won" ? "paid" : ticketStatus === "voided" ? "voided" : "released", releaseTransactionId]
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
        claimableMicroUnits: ticketStatus === "lost" ? "0" : payoutMicroUsd.toString(),
        settlementFinalStatus: ticketStatus,
        accountingMode: row.accounting_mode,
        currency,
        ledgerTransactionId: ticketStatus === "lost" ? null : transactionId,
        releaseTransactionId
      },
      finalAuditAction
    ]
  );

  if (ticketStatus === "lost") return "lost";

  await client.query("UPDATE tickets SET status = 'claimable', updated_at = now() WHERE id = $1", [ticketId]);
  return "claimable";
}

async function applyWholeTicketVoidPolicy(client: pg.PoolClient, ticketId: string, triggeringTicketLegId: string, source: string) {
  const openLegs = await client.query<{ id: string }>(
    `
      SELECT id
      FROM ticket_legs
      WHERE ticket_id = $1
        AND id <> $2
        AND status IN ('pending', 'disputed')
      FOR UPDATE
    `,
    [ticketId, triggeringTicketLegId]
  );

  for (const leg of openLegs.rows) {
    await client.query(
      `
        INSERT INTO settlements (ticket_leg_id, source, result, proof_reference, raw)
        VALUES ($1, 'legwork_void_policy', 'voided', 'whole_ticket_void_precedence', $2)
      `,
      [
        leg.id,
        {
          ticketId,
          triggeringTicketLegId,
          source,
          policy: "any_final_void_voids_whole_ticket"
        }
      ]
    );

    await client.query(
      `
        UPDATE ticket_legs
        SET
          status = 'voided',
          resolution_state = 'resolved_void',
          resolution_updated_at = now(),
          last_resolution_error = NULL,
          settled_at = COALESCE(settled_at, now())
        WHERE id = $1
      `,
      [leg.id]
    );

    await recordSettlementProof(client, {
      ticketLegId: leg.id,
      source: "legwork_void_policy",
      proofKind: "whole_ticket_void_precedence",
      result: "voided",
      confidence: "manual_override",
      raw: {
        ticketId,
        triggeringTicketLegId,
        source,
        policy: "any_final_void_voids_whole_ticket"
      }
    });
  }

  return openLegs.rows.length;
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

export type TicketClaimResult = {
  ticketId: string;
  userId: string;
  status: "claimed" | "already_claimed";
  ticketStatus: "paid";
  amountMicroUnits: string;
  currency: string;
  ledgerTransactionId: string;
  idempotencyKey: string;
};

type SettlementClaimRow = {
  ticket_id: string;
  amount_micro_units: string;
  currency: string;
  ledger_transaction_id: string;
  idempotency_key: string;
};

function ticketClaimResult(claim: SettlementClaimRow, userId: string): TicketClaimResult {
  return {
    ticketId: claim.ticket_id,
    userId,
    status: "already_claimed",
    ticketStatus: "paid",
    amountMicroUnits: claim.amount_micro_units,
    currency: claim.currency,
    ledgerTransactionId: claim.ledger_transaction_id,
    idempotencyKey: claim.idempotency_key
  };
}

async function findCommittedClaimForKey(queryable: Pick<pg.Pool | pg.PoolClient, "query">, userId: string, idempotencyKey: string) {
  return queryable.query<SettlementClaimRow>(
    `
      SELECT
        ticket_id,
        amount_micro_units::text,
        currency,
        ledger_transaction_id::text,
        idempotency_key
      FROM settlement_claims
      WHERE user_id = $1
        AND idempotency_key = $2
        AND status = 'completed'
      LIMIT 1
    `,
    [userId, idempotencyKey]
  );
}

export async function claimTicketToAvailable(input: {
  ticketId: string;
  userId: string;
  idempotencyKey: string;
  assertFinancialGateOpenInTransaction?: typeof assertFinancialGateOpenInTransaction;
}): Promise<TicketClaimResult> {
  if (!input.idempotencyKey.trim()) {
    throw new Error("idempotency_key_required");
  }

  const pool = getPool();
  const committedReplay = (await findCommittedClaimForKey(pool, input.userId, input.idempotencyKey)).rows[0];
  if (committedReplay) {
    if (committedReplay.ticket_id !== input.ticketId) {
      throw new Error("settlement_claim_idempotency_conflict");
    }
    return ticketClaimResult(committedReplay, input.userId);
  }

  const unlockedTicket = await pool.query<{ accounting_mode: string }>(
    `
      SELECT accounting_mode
      FROM tickets
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [input.ticketId, input.userId]
  );
  const initialAccountingMode = unlockedTicket.rows[0]?.accounting_mode;
  if (!initialAccountingMode) throw new Error("ticket_not_found");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    if (initialAccountingMode === "house_book_usdc") {
      await (input.assertFinancialGateOpenInTransaction || assertFinancialGateOpenInTransaction)(client, { operation: "ticket_claim" });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `settlement-claim:${input.userId}:${input.idempotencyKey}`
    ]);

    const existingForKey = await client.query<SettlementClaimRow>(
      `
        SELECT
          ticket_id,
          amount_micro_units::text,
          currency,
          ledger_transaction_id::text,
          idempotency_key
        FROM settlement_claims
        WHERE user_id = $1
          AND idempotency_key = $2
          AND status = 'completed'
        FOR UPDATE
      `,
      [input.userId, input.idempotencyKey]
    );
    const keyedClaim = existingForKey.rows[0];
    if (keyedClaim) {
      if (keyedClaim.ticket_id !== input.ticketId) {
        throw new Error("settlement_claim_idempotency_conflict");
      }
      await client.query("COMMIT");
      return ticketClaimResult(keyedClaim, input.userId);
    }

    const ticketResult = await client.query<{
      id: string;
      user_id: string;
      status: string;
      accounting_mode: string;
      funding_currency: string;
    }>(
      `
        SELECT id, user_id, status, accounting_mode, funding_currency
        FROM tickets
        WHERE id = $1
        FOR UPDATE
      `,
      [input.ticketId]
    );
    const ticket = ticketResult.rows[0];
    if (!ticket || ticket.user_id !== input.userId) {
      throw new Error("ticket_not_found");
    }
    if (ticket.accounting_mode !== initialAccountingMode) {
      throw new Error("ticket_accounting_mode_changed");
    }

    const existingForTicket = await client.query<{
      amount_micro_units: string;
      currency: string;
      ledger_transaction_id: string;
      idempotency_key: string;
    }>(
      `
        SELECT
          amount_micro_units::text,
          currency,
          ledger_transaction_id::text,
          idempotency_key
        FROM settlement_claims
        WHERE ticket_id = $1
        FOR UPDATE
      `,
      [input.ticketId]
    );
    const ticketClaim = existingForTicket.rows[0];
    if (ticketClaim) {
      await client.query("COMMIT");
      return {
        ticketId: input.ticketId,
        userId: input.userId,
        status: "already_claimed",
        ticketStatus: "paid",
        amountMicroUnits: ticketClaim.amount_micro_units,
        currency: ticketClaim.currency,
        ledgerTransactionId: ticketClaim.ledger_transaction_id,
        idempotencyKey: ticketClaim.idempotency_key
      };
    }

    if (ticket.status !== "claimable") {
      throw new Error("ticket_not_claimable");
    }

    const claimableAudit = await client.query<{
      metadata: {
        claimableMicroUnits?: string | number;
        currency?: string;
        accountingMode?: string;
      };
    }>(
      `
        SELECT metadata
        FROM audit_log
        WHERE action = 'ticket.claimable'
          AND entity_type = 'ticket'
          AND entity_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.ticketId]
    );
    const claimableMicroUnits = positiveBigint(claimableAudit.rows[0]?.metadata?.claimableMicroUnits, "ticket_claimable_amount_missing");

    const accounts = accountTypes(ticket.accounting_mode);
    const currency = ticket.funding_currency;
    const claimableAccountId = await ensureLedgerAccount(client, input.userId, accounts.userClaimable, currency);
    const availableAccountId = await ensureLedgerAccount(client, input.userId, accounts.userAvailable, currency);
    await client.query("SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
      [claimableAccountId, availableAccountId].sort()
    ]);

    const claimableBalance = await ledgerBalanceMicroUnits(client, claimableAccountId);
    if (claimableBalance < claimableMicroUnits) {
      throw new Error("insufficient_claimable_balance");
    }

    const transactionId = randomUUID();
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $4, $5, 'ticket claim to available'),
          ($1, $3, $6, $5, 'ticket claim to available')
      `,
      [transactionId, availableAccountId, claimableAccountId, claimableMicroUnits.toString(), currency, (-claimableMicroUnits).toString()]
    );
    await client.query(
      `
        INSERT INTO settlement_claims (
          ticket_id,
          user_id,
          idempotency_key,
          amount_micro_units,
          currency,
          ledger_transaction_id,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'completed')
      `,
      [input.ticketId, input.userId, input.idempotencyKey, claimableMicroUnits.toString(), currency, transactionId]
    );
    await client.query("UPDATE tickets SET status = 'paid', updated_at = now() WHERE id = $1", [input.ticketId]);
    await client.query(
      `
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'ticket.claimed', 'ticket', $2, $3)
      `,
      [
        input.userId,
        input.ticketId,
        {
          amountMicroUnits: claimableMicroUnits.toString(),
          currency,
          ledgerTransactionId: transactionId,
          idempotencyKey: input.idempotencyKey
        }
      ]
    );
    await client.query(
      `
        INSERT INTO outbox (topic, payload)
        VALUES ($1, $2)
      `,
      [
        "ticket.claimed",
        {
          ticketId: input.ticketId,
          userId: input.userId,
          amountMicroUnits: claimableMicroUnits.toString(),
          currency,
          ticketStatus: "paid"
        }
      ]
    );

    await client.query("COMMIT");
    return {
      ticketId: input.ticketId,
      userId: input.userId,
      status: "claimed",
      ticketStatus: "paid",
      amountMicroUnits: claimableMicroUnits.toString(),
      currency,
      ledgerTransactionId: transactionId,
      idempotencyKey: input.idempotencyKey
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordLegSettlement(input: {
  ticketLegId: string;
  result: SettlementResult;
  source?: string;
  proofReference?: string;
  proof?: Omit<SettlementProofInput, "ticketLegId">;
  raw?: unknown;
  assertFinancialGateOpenInTransaction?: typeof assertFinancialGateOpenInTransaction;
}): Promise<SettledLeg> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const legTicketResult = await client.query<{ ticket_id: string; accounting_mode: string }>(
      `
        SELECT ticket_legs.ticket_id, tickets.accounting_mode
        FROM ticket_legs
        JOIN tickets ON tickets.id = ticket_legs.ticket_id
        WHERE ticket_legs.id = $1
      `,
      [input.ticketLegId]
    );
    const legTicket = legTicketResult.rows[0];
    if (!legTicket) {
      throw new Error("ticket_leg_not_found");
    }
    if (legTicket.accounting_mode === "house_book_usdc") {
      await (input.assertFinancialGateOpenInTransaction || assertFinancialGateOpenInTransaction)(client, { operation: "ticket_settlement" });
    }

    const lockedTicket = await client.query<{ accounting_mode: string; status: string }>(
      "SELECT accounting_mode, status FROM tickets WHERE id = $1 FOR UPDATE",
      [legTicket.ticket_id]
    );
    if (!lockedTicket.rows[0] || lockedTicket.rows[0].accounting_mode !== legTicket.accounting_mode) {
      throw new Error("ticket_accounting_mode_changed");
    }
    if (lockedTicket.rows[0].status === "claimable" || lockedTicket.rows[0].status === "paid") {
      throw new Error("ticket_settlement_terminal_status");
    }

    const legResult = await client.query<{
      ticket_id: string;
      status: string;
      settlementSource: string | null;
      settlementAuthority: SettlementAuthority | null;
      settlementChainId: number | null;
      settlementContractAddress: string | null;
      settlementCollateralAddress: string | null;
      settlementConditionId: string | null;
      settlementTokenId: string | null;
      settlementPositionId: string | null;
      settlementSourceMarketId: string | null;
      settlementOutcome: string | null;
      settlementOutcomeIndex: number | null;
      settlementPayoutSlotCount: number | null;
      settlementIdentityValidationProofId: string | null;
      settlementIdentityValidationBlockNumber: string | null;
      settlementIdentityValidationBlockHash: string | null;
      settlementFrozenAt: Date | null;
    }>(
      `
        SELECT
          ticket_id,
          status,
          settlement_source AS "settlementSource",
          settlement_authority AS "settlementAuthority",
          settlement_chain_id AS "settlementChainId",
          settlement_contract_address AS "settlementContractAddress",
          settlement_collateral_address AS "settlementCollateralAddress",
          settlement_condition_id AS "settlementConditionId",
          settlement_token_id AS "settlementTokenId",
          settlement_position_id AS "settlementPositionId",
          settlement_source_market_id AS "settlementSourceMarketId",
          settlement_outcome AS "settlementOutcome",
          settlement_outcome_index AS "settlementOutcomeIndex",
          settlement_payout_slot_count AS "settlementPayoutSlotCount",
          settlement_identity_validation_proof_id::text AS "settlementIdentityValidationProofId",
          settlement_identity_validation_block_number::text AS "settlementIdentityValidationBlockNumber",
          settlement_identity_validation_block_hash AS "settlementIdentityValidationBlockHash",
          settlement_frozen_at AS "settlementFrozenAt"
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
    if (leg.ticket_id !== legTicket.ticket_id) {
      throw new Error("ticket_leg_ticket_changed");
    }

    if (["won", "lost", "voided"].includes(leg.status) && leg.status !== input.result) {
      throw new Error(`settlement_conflict:${leg.status}`);
    }

    if (legTicket.accounting_mode === "house_book_usdc") {
      await assertHouseBookSettlementFinality(client, input, leg);
    }

    if (leg.status === input.result) {
      await recordSettlementProof(client, {
        ticketLegId: input.ticketLegId,
        source: input.source || "manual_ops",
        proofKind: input.proof?.proofKind || "manual_replay",
        result: input.result,
        confidence: input.proof?.confidence || "manual_override",
        chainId: input.proof?.chainId,
        contractAddress: input.proof?.contractAddress,
        collateralAddress: input.proof?.collateralAddress,
        conditionId: input.proof?.conditionId,
        tokenId: input.proof?.tokenId,
        outcomeIndex: input.proof?.outcomeIndex,
        winningTokenId: input.proof?.winningTokenId,
        payoutNumerator: input.proof?.payoutNumerator,
        payoutDenominator: input.proof?.payoutDenominator,
        payoutVector: input.proof?.payoutVector,
        blockNumber: input.proof?.blockNumber,
        blockHash: input.proof?.blockHash,
        txHash: input.proof?.txHash,
        resolvedAt: input.proof?.resolvedAt,
        providerEvidence: input.proof?.providerEvidence,
        raw: input.raw ?? input.proof?.raw ?? {}
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
      `,
      [input.ticketLegId, input.source || "manual_ops", input.result, input.proofReference || null, jsonSafe(input.raw ?? {})]
    );

    await client.query(
      `
        UPDATE ticket_legs
        SET
          status = $2,
          resolution_state = $3,
          resolution_updated_at = now(),
          last_resolution_error = NULL,
          settled_at = CASE WHEN $2 = 'disputed' THEN settled_at ELSE COALESCE(settled_at, now()) END
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
      chainId: input.proof?.chainId,
      contractAddress: input.proof?.contractAddress,
      collateralAddress: input.proof?.collateralAddress,
      conditionId: input.proof?.conditionId,
      tokenId: input.proof?.tokenId,
      outcomeIndex: input.proof?.outcomeIndex,
      winningTokenId: input.proof?.winningTokenId,
      payoutNumerator: input.proof?.payoutNumerator,
      payoutDenominator: input.proof?.payoutDenominator,
      payoutVector: input.proof?.payoutVector,
      blockNumber: input.proof?.blockNumber,
      blockHash: input.proof?.blockHash,
      txHash: input.proof?.txHash,
      resolvedAt: input.proof?.resolvedAt,
      providerEvidence: input.proof?.providerEvidence,
      raw: input.raw ?? input.proof?.raw ?? {}
    });

    const policyVoidedLegs = input.result === "voided" ? await applyWholeTicketVoidPolicy(client, leg.ticket_id, input.ticketLegId, input.source || "manual_ops") : 0;

    const derivedTicketStatus = await updateTicketStatus(client, leg.ticket_id);
    const ticketStatus = await makeFinalTicketClaimableIfNeeded(client, leg.ticket_id, derivedTicketStatus);

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
          policyVoidedLegs,
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
