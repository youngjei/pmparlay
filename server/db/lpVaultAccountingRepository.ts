import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  allocatePositionCostBasisMicroUsdc,
  calculatePositionValueMicroUsdc,
  estimatePositionPnl,
  finalizeRedemptionsAtEndPeriodPrice,
  mintSharesAtCommonPreDepositPrice
} from "../lpVaultAccounting";
import { lockFinancialControlGateForMutation } from "../financialGate";
import { getPool } from "./client";

export type LpVaultAccountingQueryable = Pick<pg.Pool | pg.PoolClient | pg.Client, "query">;
export type LpVaultAccountingClient = pg.PoolClient;

export type LpVaultAccountingEventType =
  | "accounting_incepted"
  | "cycle_opened"
  | "liability_marked"
  | "ticket_liability_marked"
  | "settlement_recognized"
  | "nav_checkpointed"
  | "liquidity_marked"
  | "protocol_fee_accrued"
  | "protocol_fee_released"
  | "expense_accrued"
  | "deposit_pending"
  | "deposit_activated"
  | "deposit_rejected"
  | "redemption_requested"
  | "redemption_waiting"
  | "redemption_admitted"
  | "redemption_redeeming"
  | "redemption_reserve_marked"
  | "redemption_payable_matured"
  | "redemption_reserved"
  | "redemption_finalized"
  | "redemption_claimable"
  | "redemption_canceled"
  | "cycle_closed";

export type LpVaultAccountingEvent = {
  id: string;
  vaultId: string;
  bookVersion: bigint;
  eventType: LpVaultAccountingEventType;
  entityId: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  previousEventHash?: string;
  eventHash: string;
  recordedAt: Date;
};

export type VerifiedLpVaultAccounting = {
  vaultId: string;
  cycleId: string;
  cutoffDate: string;
  asOf: Date;
  processedAt: Date;
  reconciliationId: string;
  bookVersion: bigint;
  canonicalBlockNumber: bigint;
  canonicalBlockHash: string;
  grossAssetsMicroUnits: bigint;
  economicNavMicroUnits: bigint;
  activeShareUnits: bigint;
  sharePriceNumeratorMicroUnits: bigint;
  sharePriceDenominatorUnits: bigint;
  pendingActivationMicroUnits: bigint;
  estimatedPnlMicroUnits: bigint;
  finalizedPnlMicroUnits: bigint;
  markedUnresolvedLiabilityMicroUnits: bigint;
  grossUnresolvedPayoutsMicroUnits: bigint;
  fullLiabilityFallbackMicroUnits: bigint;
  liabilityMarkCoverageBps: number;
  activeRedemptionReserveMicroUnits: bigint;
  collateralRequirementsMicroUnits: bigint;
  freeLiquidityMicroUnits: bigint;
};

export type LpVaultAccountingReplay = {
  vaultId: string;
  eventCount: number;
  firstBookVersion: bigint;
  lastBookVersion: bigint;
  lastEventHash: string;
  lastClosedBookVersion: bigint;
  pendingTailEventCount: number;
  checkpointCount: number;
  shareEventCount: number;
  totalMintedShareUnits: bigint;
  totalBurnedShareUnits: bigint;
  replayedShareSupplyUnits: bigint;
  checkpointShareSupplyUnits: bigint;
  economicNavMicroUnits: bigint;
  grossAssetsMicroUnits: bigint;
  navDeductionsMicroUnits: bigint;
};

const NON_VALUING_POST_CLOSE_EVENT_TYPES = new Set<LpVaultAccountingEventType>([
  "deposit_pending",
  "deposit_rejected",
  "redemption_requested",
  "redemption_waiting",
  "redemption_admitted",
  "redemption_redeeming",
  "redemption_reserved",
  "redemption_canceled"
]);

export type LpVaultOwnerPendingDeposit = {
  depositId: string;
  amountMicroUnits: bigint;
  eligibleAfterCutoff: string;
  createdAt: Date;
};

export type LpVaultOwnerWithdrawal = {
  requestId: string;
  status: "queued" | "waiting_liquidity" | "admitted" | "redeeming" | "finalized" | "claimable" | "canceled";
  requestedShareUnits: bigint;
  currentValueMicroUnits?: bigint;
  finalizedPnlMicroUnits?: bigint;
  requestedAt: Date;
  redemptionStartsAt?: Date;
  redemptionEndsAt?: Date;
  finalizedAt?: Date;
  claimableAt?: Date;
};

export type VerifiedLpVaultOwnerAccounting =
  | {
      status: "unavailable";
      reason: "accounting_missing" | "accounting_stale";
      vaultId: string;
      userId: string;
      asOf?: Date;
    }
  | {
      status: "available";
      vaultId: string;
      userId: string;
      asOf: Date;
      bookVersion: bigint;
      positionId?: string;
      pendingDeposits: LpVaultOwnerPendingDeposit[];
      activeShareUnits: bigint;
      remainingCostBasisMicroUnits: bigint;
      currentPositionValueMicroUnits: bigint;
      estimatedPnlMicroUnits: bigint;
      finalizedRedemptionPnlMicroUnits: bigint;
      withdrawals: LpVaultOwnerWithdrawal[];
    };

export type OpenLpVaultCycle = {
  id: string;
  vaultId: string;
  cutoffDate: string;
  status: "open" | "marked" | "checkpointed" | "closed";
  openedAt: Date;
};

export type TicketLiabilityMarkWrite = {
  ticketId: string;
  markedLiabilityMicroUnits: bigint;
  markSource: "gross_payout_fallback";
  fallbackReason?: string;
  evidenceTime: Date;
};

export function assertSupportedLpVaultLiabilityMarkSource(value:unknown):asserts value is "gross_payout_fallback"{
  if(value!=="gross_payout_fallback") throw new Error("lp_vault_reliable_mark_provenance_unavailable");
}

export type UnresolvedLpVaultTicket = {
  ticket_id: string;
  stake_micro_units: string;
  offered_payout_micro_units: string;
};

export type CloseLpVaultCycleInput = {
  vaultId: string;
  cycleId: string;
  reconciliationId: string;
  sourceMaxAgeMs: number;
  ticketMarks: readonly TicketLiabilityMarkWrite[];
};

export const INTERNAL_FOUNDER_LP_USER_ID = "00000000-0000-4000-8000-000000000002";
export const INTERNAL_FOUNDER_DEPOSIT_SOURCE = "internal:founder-seed:v1";
const ACCOUNTING_SOURCE_MAX_AGE_MS = 5 * 60_000;
export const LP_VAULT_OWNER_ACCOUNTING_MAX_AGE_MS = 26 * 60 * 60_000;

type EventRow = {
  id: string;
  vault_id: string;
  book_version: string;
  event_type: LpVaultAccountingEventType;
  entity_id: string;
  payload: Record<string, unknown>;
  payload_text: string;
  payload_hash: string;
  previous_event_hash: string | null;
  event_hash: string;
  recorded_at: Date;
};

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deterministicUuid(value:string){
  const hex=createHash("sha256").update(value).digest("hex").slice(0,32).split("");
  hex[12]="4"; hex[16]=((Number.parseInt(hex[16],16)&3)|8).toString(16);
  return `${hex.slice(0,8).join("")}-${hex.slice(8,12).join("")}-${hex.slice(12,16).join("")}-${hex.slice(16,20).join("")}-${hex.slice(20).join("")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function allocateOwnerMintAcrossDeposits(
  ownerMintedShareUnits:bigint,
  deposits:readonly {id:string;amountMicroUnits:bigint}[]
){
  if(ownerMintedShareUnits<=0n||deposits.length===0||deposits.some(deposit=>deposit.amountMicroUnits<=0n))
    throw new Error("invalid_lp_vault_owner_deposit_allocation");
  const total=deposits.reduce((sum,deposit)=>sum+deposit.amountMicroUnits,0n);
  const split=deposits.map(deposit=>{const numerator=ownerMintedShareUnits*deposit.amountMicroUnits;
    return {id:deposit.id,shareUnits:numerator/total,remainder:numerator%total};});
  let unassigned=ownerMintedShareUnits-split.reduce((sum,part)=>sum+part.shareUnits,0n);
  split.sort((left,right)=>left.remainder===right.remainder?left.id.localeCompare(right.id):left.remainder>right.remainder?-1:1);
  const result=new Map<string,bigint>();
  for(const part of split){const extra=unassigned>0n?1n:0n;result.set(part.id,part.shareUnits+extra);unassigned-=extra;}
  if(unassigned!==0n) throw new Error("lp_vault_deposit_split_conservation_failure");
  return result;
}

function asDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("invalid_lp_vault_cutoff_date");
  return value;
}

function asCanonicalTime(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid_lp_vault_canonical_time");
  }
  return value;
}

export async function loadUnresolvedLpVaultTicketsAsOf(
  client: LpVaultAccountingQueryable,
  canonicalTime: Date
): Promise<UnresolvedLpVaultTicket[]> {
  const asOf = asCanonicalTime(canonicalTime);
  const result = await client.query<UnresolvedLpVaultTicket>(
    `SELECT reserves.ticket_id, reserves.stake_micro_units::text, reserves.offered_payout_micro_units::text
     FROM ticket_reserves reserves
     WHERE reserves.accounting_mode='house_book_usdc' AND reserves.currency='USDC'
       AND reserves.created_at <= $1
       AND NOT EXISTS (
         SELECT 1 FROM ticket_settlement_summaries summaries
         WHERE summaries.ticket_id=reserves.ticket_id AND summaries.created_at <= $1
       )
     ORDER BY reserves.ticket_id
     FOR UPDATE OF reserves`,
    [asOf]
  );
  return result.rows;
}

function requireUuid(value: string, field: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`invalid_lp_vault_${field}`);
  }
  return value;
}

function eventFromRow(row: EventRow): LpVaultAccountingEvent {
  return {
    id: row.id,
    vaultId: row.vault_id,
    bookVersion: BigInt(row.book_version),
    eventType: row.event_type,
    entityId: row.entity_id,
    payload: row.payload,
    payloadHash: row.payload_hash,
    ...(row.previous_event_hash ? { previousEventHash: row.previous_event_hash } : {}),
    eventHash: row.event_hash,
    recordedAt: row.recorded_at
  };
}

export async function acquireLpVaultAccountingAdvisoryLock(
  client: LpVaultAccountingQueryable,
  vaultId: string
) {
  requireUuid(vaultId, "vault_id");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`lp-vault-accounting:${vaultId}`]);
}

export async function runLpVaultAccountingTransaction<T>(
  vaultId: string,
  run: (client: pg.PoolClient) => Promise<T>,
  pool: pg.Pool = getPool()
): Promise<T> {
  const client = await pool.connect();
  try {
    // The transaction lock is the serialization boundary. READ COMMITTED takes
    // a fresh snapshot after a waiter acquires the lock and observes its predecessor's commit.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await acquireLpVaultAccountingAdvisoryLock(client, vaultId);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function appendLpVaultAccountingEvent(
  client: LpVaultAccountingQueryable,
  input: {
    vaultId: string;
    eventType: LpVaultAccountingEventType;
    entityId: string;
    payload: Record<string, unknown>;
    eventId?: string;
  }
): Promise<LpVaultAccountingEvent> {
  requireUuid(input.vaultId, "vault_id");
  requireUuid(input.entityId, "event_entity_id");
  if (!input.payload || Array.isArray(input.payload)) throw new Error("invalid_lp_vault_event_payload");
  await acquireLpVaultAccountingAdvisoryLock(client,input.vaultId);
  const eventId = input.eventId ?? randomUUID();
  const result = await client.query<EventRow>(
    `WITH prior AS (
       SELECT book_version,event_hash FROM lp_vault_accounting_events
       WHERE vault_id=$2 ORDER BY book_version DESC LIMIT 1 FOR UPDATE
     ), next_event AS (
       SELECT COALESCE((SELECT book_version+1 FROM prior),1) AS book_version,
         (SELECT event_hash FROM prior) AS previous_event_hash
     )
     INSERT INTO lp_vault_accounting_events (
       id, vault_id, book_version, event_type, entity_id, payload,
       payload_hash, previous_event_hash, event_hash
     ) SELECT $1,$2,next_event.book_version,$3,$4,$5::jsonb,$6,next_event.previous_event_hash,$7
       FROM next_event
     RETURNING *, payload::text AS payload_text`,
    [
      eventId,
      input.vaultId,
      input.eventType,
      input.entityId,
      stableJson(input.payload),
      sha256("repository-placeholder"),
      sha256(`repository-placeholder:${eventId}`)
    ]
  );
  return eventFromRow(result.rows[0]);
}

async function assertIdempotency(
  client: LpVaultAccountingQueryable,
  input: {
    vaultId: string;
    scope: string;
    key: string;
    payload: unknown;
    resultEntityType: string;
    resultEntityId: string;
  }
): Promise<{ idempotentReplay: boolean; resultEntityId: string }> {
  const payloadHash = sha256(stableJson(input.payload));
  const inserted = await client.query<{ payload_hash: string; result_entity_id: string }>(
    `INSERT INTO lp_vault_accounting_idempotency (
       vault_id, operation_scope, idempotency_key, payload_hash, result_entity_type, result_entity_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (vault_id, operation_scope, idempotency_key) DO NOTHING
     RETURNING payload_hash, result_entity_id`,
    [input.vaultId, input.scope, input.key, payloadHash, input.resultEntityType, input.resultEntityId]
  );
  if (inserted.rows[0]) return { idempotentReplay: false, resultEntityId: input.resultEntityId };
  const existing = await client.query<{ payload_hash: string; result_entity_id: string }>(
    `SELECT payload_hash, result_entity_id FROM lp_vault_accounting_idempotency
     WHERE vault_id = $1 AND operation_scope = $2 AND idempotency_key = $3`,
    [input.vaultId, input.scope, input.key]
  );
  if (!existing.rows[0] || existing.rows[0].payload_hash !== payloadHash) {
    throw new Error("lp_vault_accounting_idempotency_conflict");
  }
  return { idempotentReplay: true, resultEntityId: existing.rows[0].result_entity_id };
}

export async function recordPendingLpVaultDeposit(
  client: LpVaultAccountingQueryable,
  input: { vaultId: string; userId: string; amountMicroUnits: bigint; sourceReference: string; idempotencyKey: string }
) {
  await acquireLpVaultAccountingAdvisoryLock(client,input.vaultId);
  requireUuid(input.userId,"deposit_user_id");
  if(input.amountMicroUnits<=0n) throw new Error("invalid_lp_vault_deposit_amount");
  if(input.sourceReference.length<1||input.sourceReference.length>300) throw new Error("invalid_lp_vault_deposit_source");
  const depositId=randomUUID();
  const payload={userId:input.userId,amountMicroUnits:input.amountMicroUnits.toString(),sourceReference:input.sourceReference};
  const idempotency=await assertIdempotency(client,{vaultId:input.vaultId,scope:"pending_deposit",key:input.idempotencyKey,
    payload,resultEntityType:"pending_deposit",resultEntityId:depositId});
  if(idempotency.idempotentReplay){
    const existing=await client.query<{id:string;eligible_after_cutoff:string}>(`SELECT id,eligible_after_cutoff::text
      FROM lp_vault_pending_deposits WHERE id=$1`,[idempotency.resultEntityId]);
    if(!existing.rows[0]) throw new Error("lp_vault_idempotent_deposit_missing");
    return {...existing.rows[0],idempotentReplay:true};
  }
  const event=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"deposit_pending",entityId:depositId,payload});
  const inserted=await client.query<{id:string;eligible_after_cutoff:string}>(`INSERT INTO lp_vault_pending_deposits (
    id,vault_id,user_id,amount_micro_units,eligible_after_cutoff,source_reference,request_payload_hash,accounting_event_id)
    VALUES ($1,$2,$3,$4,((now() AT TIME ZONE 'UTC')::date+1),$5,$6,$7)
    RETURNING id,eligible_after_cutoff::text`,[depositId,input.vaultId,input.userId,input.amountMicroUnits.toString(),
      input.sourceReference,sha256(stableJson(payload)),event.id]);
  return {...inserted.rows[0],idempotentReplay:false};
}

export const recordLpVaultPendingDeposit = recordPendingLpVaultDeposit;

export async function requestLpVaultRedemption(
  client:LpVaultAccountingQueryable,
  input:{vaultId:string;userId:string;requestedShareUnits:bigint;idempotencyKey:string}
){
  await acquireLpVaultAccountingAdvisoryLock(client,input.vaultId);
  requireUuid(input.userId,"redemption_user_id");
  if(input.requestedShareUnits<=0n) throw new Error("invalid_lp_vault_redemption_shares");
  if(input.idempotencyKey.length<1||input.idempotencyKey.length>200) throw new Error("invalid_lp_vault_redemption_idempotency_key");
  const requestId=deterministicUuid(`lp-redemption:${input.vaultId}:${input.userId}:${input.idempotencyKey}`);
  const payload={userId:input.userId,requestedShareUnits:input.requestedShareUnits.toString()};
  const payloadHash=sha256(stableJson(payload));
  const existing=await client.query<{id:string;request_payload_hash:string;status:string}>(`SELECT id,request_payload_hash,status
    FROM lp_vault_redemption_requests WHERE id=$1 FOR UPDATE`,[requestId]);
  if(existing.rows[0]){
    if(existing.rows[0].request_payload_hash!==payloadHash) throw new Error("lp_vault_redemption_idempotency_conflict");
    return {id:requestId,status:existing.rows[0].status,idempotentReplay:true};
  }
  const position=await client.query<{id:string;available:string}>(`SELECT positions.id,
    (COALESCE((SELECT sum(CASE WHEN event_type='mint' THEN share_units ELSE -share_units END)
      FROM lp_vault_share_events WHERE position_id=positions.id),0)-
     COALESCE((SELECT sum(reserves.reserved_share_units) FROM lp_vault_redemption_reserves reserves
      JOIN lp_vault_redemption_requests requests ON requests.id=reserves.redemption_request_id
      WHERE requests.position_id=positions.id AND requests.status IN ('admitted','redeeming')),0))::text AS available
    FROM lp_vault_share_positions positions WHERE positions.vault_id=$1 AND positions.user_id=$2 FOR UPDATE`,
    [input.vaultId,input.userId]);
  if(!position.rows[0]) throw new Error("lp_vault_share_position_missing");
  if(input.requestedShareUnits>BigInt(position.rows[0].available)) throw new Error("lp_vault_redemption_exceeds_unreserved_holding");
  const event=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"redemption_requested",entityId:requestId,payload});
  await client.query(`INSERT INTO lp_vault_redemption_requests (
    id,vault_id,position_id,requested_share_units,request_payload_hash,status,accounting_event_id)
    VALUES ($1,$2,$3,$4,$5,'queued',$6)`,[requestId,input.vaultId,position.rows[0].id,input.requestedShareUnits.toString(),payloadHash,event.id]);
  return {id:requestId,status:"queued" as const,idempotentReplay:false};
}

export type LpVaultRedemptionAdmissionResult =
  | { status:"none"; vaultId:string }
  | { status:"waiting_liquidity"; vaultId:string; requestId:string; requiredLiquidityMicroUnits:bigint;
      availableLiquidityBeforeMicroUnits:bigint }
  | { status:"redeeming"; vaultId:string; requestId:string; reserveId:string; requiredLiquidityMicroUnits:bigint;
      availableLiquidityBeforeMicroUnits:bigint; redemptionStartsAt:Date; redemptionEndsAt:Date };

export async function admitNextLpVaultRedemption(
  client:LpVaultAccountingQueryable,
  input:{vaultId:string;reconciliationSnapshotId:string}
):Promise<LpVaultRedemptionAdmissionResult>{
  const admissionContext=await client.query<{lock_context:string|null}>(
    "SELECT current_setting('legwork.financial_global_exclusive_lock', true) AS lock_context"
  );
  if(admissionContext.rows[0]?.lock_context!=="held")
    throw new Error("lp_vault_redemption_admission_lock_order_invalid");
  await lockFinancialControlGateForMutation(client as pg.PoolClient);
  await acquireLpVaultAccountingAdvisoryLock(client,input.vaultId);
  const target=await client.query<{request_id:string;status:"queued"|"waiting_liquidity";requested_share_units:string;
    cycle_id:string;checkpoint_id:string}>(`SELECT requests.id AS request_id,requests.status,
      requests.requested_share_units::text,cycles.id AS cycle_id,checkpoints.id AS checkpoint_id
    FROM lp_vault_daily_cycles cycles
    JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.cycle_id=cycles.id
    JOIN lp_vault_cycle_closing_states closing ON closing.cycle_id=cycles.id
    JOIN LATERAL (
      SELECT id,status,requested_share_units FROM lp_vault_redemption_requests
      WHERE vault_id=$1 AND status IN ('queued','waiting_liquidity')
      ORDER BY queue_sequence LIMIT 1 FOR UPDATE
    ) requests ON true
    WHERE cycles.vault_id=$1 AND cycles.status='closed'
    ORDER BY cycles.cutoff_date DESC LIMIT 1`,[input.vaultId]);
  if(!target.rows[0]) return {status:"none",vaultId:input.vaultId};
  const request=target.rows[0];
  const capacity=await client.query<{required_liquidity_micro_units:string;available_liquidity_before_micro_units:string}>(
    `SELECT required_liquidity_micro_units::text,available_liquidity_before_micro_units::text
     FROM calculate_lp_vault_redemption_admission_capacity($1,$2,$3,$4,$5)`,[
      input.vaultId,input.reconciliationSnapshotId,request.cycle_id,request.checkpoint_id,request.request_id
    ]);
  if(!capacity.rows[0]) throw new Error("lp_vault_redemption_admission_evidence_unavailable");
  const requiredLiquidityMicroUnits=BigInt(capacity.rows[0].required_liquidity_micro_units);
  const availableLiquidityBeforeMicroUnits=BigInt(capacity.rows[0].available_liquidity_before_micro_units);
  if(requiredLiquidityMicroUnits>availableLiquidityBeforeMicroUnits){
    if(request.status==="queued"){
      const eventId=randomUUID();
      await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"redemption_waiting",entityId:eventId,
        payload:{requestId:request.request_id,reconciliationSnapshotId:input.reconciliationSnapshotId,
          requiredLiquidityMicroUnits:requiredLiquidityMicroUnits.toString(),
          availableLiquidityBeforeMicroUnits:availableLiquidityBeforeMicroUnits.toString()}});
      await client.query(`UPDATE lp_vault_redemption_requests SET status='waiting_liquidity' WHERE id=$1`,[request.request_id]);
    }
    return {status:"waiting_liquidity",vaultId:input.vaultId,requestId:request.request_id,
      requiredLiquidityMicroUnits,availableLiquidityBeforeMicroUnits};
  }

  const reserveId=randomUUID();
  const admittedEvent=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"redemption_admitted",entityId:reserveId,
    payload:{requestId:request.request_id,reservedShareUnits:request.requested_share_units,
      reconciliationSnapshotId:input.reconciliationSnapshotId,accountingCycleId:request.cycle_id,
      accountingCheckpointId:request.checkpoint_id,requiredLiquidityMicroUnits:requiredLiquidityMicroUnits.toString(),
      availableLiquidityBeforeMicroUnits:availableLiquidityBeforeMicroUnits.toString()}});
  await client.query(`INSERT INTO lp_vault_redemption_reserves (
    id,vault_id,redemption_request_id,reserved_share_units,admission_reconciliation_snapshot_id,
    admission_accounting_cycle_id,admission_checkpoint_id,required_liquidity_micro_units,
    available_liquidity_before_micro_units,accounting_event_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[reserveId,input.vaultId,request.request_id,request.requested_share_units,
      input.reconciliationSnapshotId,request.cycle_id,request.checkpoint_id,requiredLiquidityMicroUnits.toString(),
      availableLiquidityBeforeMicroUnits.toString(),admittedEvent.id]);
  const admitted=await client.query<{redemption_starts_at:Date;redemption_ends_at:Date}>(
    `UPDATE lp_vault_redemption_requests SET status='admitted' WHERE id=$1
     RETURNING redemption_starts_at,redemption_ends_at`,[request.request_id]);
  const redeemingEventId=randomUUID();
  await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"redemption_redeeming",
    entityId:redeemingEventId,payload:{requestId:request.request_id,reserveId}});
  await client.query(`UPDATE lp_vault_redemption_requests SET status='redeeming' WHERE id=$1`,[request.request_id]);
  return {status:"redeeming",vaultId:input.vaultId,requestId:request.request_id,reserveId,
    requiredLiquidityMicroUnits,availableLiquidityBeforeMicroUnits,
    redemptionStartsAt:admitted.rows[0].redemption_starts_at,redemptionEndsAt:admitted.rows[0].redemption_ends_at};
}

export async function inceptLpVaultAccounting(
  client: LpVaultAccountingQueryable,
  input: { vaultId: string; reconciliationId: string }
) {
  await acquireLpVaultAccountingAdvisoryLock(client, input.vaultId);
  const existing = await client.query<{ vault_id: string; founder_seed_residual_micro_units: string; source_reconciliation_snapshot_id: string }>(
    `SELECT vault_id, founder_seed_residual_micro_units::text, source_reconciliation_snapshot_id
     FROM lp_vault_accounting_inceptions WHERE vault_id = $1`,
    [input.vaultId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].source_reconciliation_snapshot_id !== input.reconciliationId) {
      throw new Error("lp_vault_accounting_inception_conflict");
    }
    return { ...existing.rows[0], idempotentReplay: true };
  }
  const reconciliation = await client.query<{
    created_at: Date;
    treasury_assets_micro_units: string;
    user_available_micro_units: string;
    user_claimable_micro_units: string;
    user_checkout_micro_units: string;
    pending_withdrawal_micro_units: string;
    open_stake_micro_units: string;
    open_reserve_micro_units: string;
  }>(
    `SELECT created_at, treasury_assets_micro_units::text, user_available_micro_units::text,
       user_claimable_micro_units::text, user_checkout_micro_units::text,
       pending_withdrawal_micro_units::text, open_stake_micro_units::text, open_reserve_micro_units::text
     FROM financial_reconciliation_snapshots WHERE id = $1`,
    [input.reconciliationId]
  );
  const row = reconciliation.rows[0];
  if (!row) throw new Error("lp_vault_reconciliation_missing");
  const seed = BigInt(row.treasury_assets_micro_units) - BigInt(row.user_available_micro_units)
    - BigInt(row.user_claimable_micro_units) - BigInt(row.user_checkout_micro_units)
    - BigInt(row.pending_withdrawal_micro_units) - BigInt(row.open_stake_micro_units)
    - BigInt(row.open_reserve_micro_units);
  if (seed < 0n) throw new Error("lp_vault_inception_seed_negative");
  const event = await appendLpVaultAccountingEvent(client, {
    vaultId: input.vaultId,
    eventType: "accounting_incepted",
    entityId: input.vaultId,
    payload: { reconciliationId: input.reconciliationId, founderSeedResidualMicroUnits: seed.toString() }
  });
  await client.query(
    `INSERT INTO lp_vault_accounting_inceptions (
       vault_id, inception_at, source_reconciliation_snapshot_id,
       founder_seed_residual_micro_units, accounting_event_id
     ) VALUES ($1, $2, $3, $4, $5)`,
    [input.vaultId, row.created_at, input.reconciliationId, seed.toString(), event.id]
  );
  await client.query(
    `INSERT INTO users (id, display_name) VALUES ($1, 'LEGWORK internal founder capital')
     ON CONFLICT (id) DO NOTHING`,
    [INTERNAL_FOUNDER_LP_USER_ID]
  );
  if (seed > 0n) {
    const depositId = randomUUID();
    const pendingEvent = await appendLpVaultAccountingEvent(client, {
      vaultId: input.vaultId,
      eventType: "deposit_pending",
      entityId: depositId,
      payload: {
        amountMicroUnits: seed.toString(),
        ownerId: INTERNAL_FOUNDER_LP_USER_ID,
        sourceReference: INTERNAL_FOUNDER_DEPOSIT_SOURCE
      }
    });
    await client.query(
      `INSERT INTO lp_vault_pending_deposits (
         id, vault_id, user_id, amount_micro_units, eligible_after_cutoff,
         source_reference, request_payload_hash, accounting_event_id
       ) VALUES ($1,$2,$3,$4,(($5::timestamptz AT TIME ZONE 'UTC')::date),$6,$7,$8)`,
      [depositId, input.vaultId, INTERNAL_FOUNDER_LP_USER_ID, seed.toString(), row.created_at,
        INTERNAL_FOUNDER_DEPOSIT_SOURCE,
        sha256(stableJson({ amountMicroUnits: seed.toString(), reconciliationId: input.reconciliationId })),
        pendingEvent.id]
    );
  }
  return { vault_id: input.vaultId, founder_seed_residual_micro_units: seed.toString(), idempotentReplay: false };
}

export async function openOrGetLpVaultCycle(
  client: LpVaultAccountingQueryable,
  input: { vaultId: string; cutoffDate: string }
): Promise<OpenLpVaultCycle> {
  await acquireLpVaultAccountingAdvisoryLock(client, input.vaultId);
  const cutoffDate = asDateOnly(input.cutoffDate);
  const existing = await client.query<{
    id: string; vault_id: string; cutoff_date: string; status: OpenLpVaultCycle["status"]; opened_at: Date
  }>(
    `SELECT id, vault_id, cutoff_date::text, status, opened_at FROM lp_vault_daily_cycles
     WHERE vault_id = $1 AND cutoff_date = $2::date FOR UPDATE`,
    [input.vaultId, cutoffDate]
  );
  if (existing.rows[0]) return {
    id: existing.rows[0].id,
    vaultId: existing.rows[0].vault_id,
    cutoffDate: existing.rows[0].cutoff_date,
    status: existing.rows[0].status,
    openedAt: existing.rows[0].opened_at
  };
  const cycleId = randomUUID();
  const event = await appendLpVaultAccountingEvent(client, {
    vaultId: input.vaultId,
    eventType: "cycle_opened",
    entityId: cycleId,
    payload: { cutoffDate }
  });
  const result = await client.query<{
    id: string; vault_id: string; cutoff_date: string; status: OpenLpVaultCycle["status"]; opened_at: Date
  }>(
    `INSERT INTO lp_vault_daily_cycles (id, vault_id, cutoff_date, opened_event_id)
     VALUES ($1, $2, $3::date, $4)
     RETURNING id, vault_id, cutoff_date::text, status, opened_at`,
    [cycleId, input.vaultId, cutoffDate, event.id]
  );
  return {
    id: result.rows[0].id,
    vaultId: result.rows[0].vault_id,
    cutoffDate: result.rows[0].cutoff_date,
    status: result.rows[0].status,
    openedAt: result.rows[0].opened_at
  };
}

export async function activateEligibleLpVaultPendingDeposits(
  client: LpVaultAccountingQueryable,
  input: { vaultId: string; cutoffDate: string; pricingCheckpointId: string }
) {
  await acquireLpVaultAccountingAdvisoryLock(client, input.vaultId);
  const checkpoint = await client.query<{ net_asset_value_micro_units: string; share_supply_units: string }>(
    `SELECT net_asset_value_micro_units::text, share_supply_units::text
     FROM lp_vault_nav_checkpoints WHERE id = $1 AND vault_id = $2`,
    [input.pricingCheckpointId, input.vaultId]
  );
  if (!checkpoint.rows[0]) throw new Error("lp_vault_pricing_checkpoint_missing");
  const deposits = await client.query<{ id: string; user_id: string; amount_micro_units: string }>(
    `SELECT id, user_id, amount_micro_units::text FROM lp_vault_pending_deposits
     WHERE vault_id = $1 AND status = 'pending' AND eligible_after_cutoff <= $2::date
     ORDER BY created_at, id FOR UPDATE`,
    [input.vaultId, asDateOnly(input.cutoffDate)]
  );
  if (deposits.rows.length === 0) return [];
  const allocations = mintSharesAtCommonPreDepositPrice({
    preDepositEconomicNavMicroUsdc: BigInt(checkpoint.rows[0].net_asset_value_micro_units),
    preDepositTotalShareUnits: BigInt(checkpoint.rows[0].share_supply_units),
    deposits: deposits.rows.map((deposit) => ({ ownerId: deposit.user_id, depositMicroUsdc: BigInt(deposit.amount_micro_units) }))
  });
  const byUser = new Map(allocations.allocations.map((allocation) => [allocation.ownerId, allocation]));
  const depositsByUser = new Map<string, typeof deposits.rows>();
  for (const deposit of deposits.rows) {
    depositsByUser.set(deposit.user_id, [...(depositsByUser.get(deposit.user_id) ?? []), deposit]);
  }
  const sharesByDeposit = new Map<string, bigint>();
  for (const [userId, ownerDeposits] of depositsByUser) {
    const ownerAllocation = byUser.get(userId);
    if (!ownerAllocation) throw new Error("lp_vault_deposit_allocation_missing");
    const ownerSplit=allocateOwnerMintAcrossDeposits(ownerAllocation.mintedShareUnits,
      ownerDeposits.map(deposit=>({id:deposit.id,amountMicroUnits:BigInt(deposit.amount_micro_units)})));
    for(const [depositId,shareUnits] of ownerSplit) sharesByDeposit.set(depositId,shareUnits);
  }
  const results: Array<{ depositId: string; positionId: string; shareEventId: string; shareUnits: bigint }> = [];
  for (const deposit of deposits.rows) {
    const shareUnits = sharesByDeposit.get(deposit.id);
    if (!shareUnits || shareUnits <= 0n) throw new Error("lp_vault_deposit_mints_zero_shares");
    await client.query(
      `INSERT INTO lp_vault_share_positions (vault_id, user_id) VALUES ($1, $2)
       ON CONFLICT (vault_id, user_id) DO NOTHING`,
      [input.vaultId, deposit.user_id]
    );
    const position = await client.query<{ id: string }>(
      `SELECT id FROM lp_vault_share_positions WHERE vault_id=$1 AND user_id=$2`,
      [input.vaultId, deposit.user_id]
    );
    if (!position.rows[0]) throw new Error("lp_vault_share_position_missing");
    const shareEventId = randomUUID();
    const lotId = randomUUID();
    const accountingEvent = await appendLpVaultAccountingEvent(client, {
      vaultId: input.vaultId,
      eventType: "deposit_activated",
      entityId: shareEventId,
      payload: {
        depositId: deposit.id,
        userId: deposit.user_id,
        positionId: position.rows[0].id,
        checkpointId: input.pricingCheckpointId,
        lotId,
        amountMicroUnits: deposit.amount_micro_units,
        shareUnits: shareUnits.toString()
      }
    });
    await client.query(
      `INSERT INTO lp_vault_share_events (
         id, vault_id, position_id, event_type, share_units, cost_basis_micro_units,
         pending_deposit_id, checkpoint_id, accounting_event_id
       ) VALUES ($1, $2, $3, 'mint', $4, $5, $6, $7, $8)`,
      [shareEventId, input.vaultId, position.rows[0].id, shareUnits.toString(),
        deposit.amount_micro_units, deposit.id, input.pricingCheckpointId, accountingEvent.id]
    );
    await client.query(
      `INSERT INTO lp_vault_share_lots (
         id, vault_id, position_id, mint_share_event_id, original_share_units, original_cost_basis_micro_units
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [lotId, input.vaultId, position.rows[0].id, shareEventId, shareUnits.toString(), deposit.amount_micro_units]
    );
    await client.query(
      `UPDATE lp_vault_pending_deposits SET status = 'active', activation_checkpoint_id = $2, activated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [deposit.id, input.pricingCheckpointId]
    );
    results.push({ depositId: deposit.id, positionId: position.rows[0].id, shareEventId, shareUnits });
  }
  return results;
}

export async function markActiveLpVaultRedemptionReserves(
  client: LpVaultAccountingQueryable,
  input: { vaultId: string; cycleId: string; checkpointId: string; canonicalTime: Date }
) {
  await acquireLpVaultAccountingAdvisoryLock(client, input.vaultId);
  const canonicalTime = asCanonicalTime(input.canonicalTime);
  const checkpoint = await client.query<{ net_asset_value_micro_units: string; share_supply_units: string }>(
    `SELECT net_asset_value_micro_units::text, share_supply_units::text FROM lp_vault_nav_checkpoints
     WHERE id = $1 AND vault_id = $2 AND cycle_id = $3`,
    [input.checkpointId, input.vaultId, input.cycleId]
  );
  if (!checkpoint.rows[0]) throw new Error("lp_vault_checkpoint_missing");
  const supply = BigInt(checkpoint.rows[0].share_supply_units);
  const nav = BigInt(checkpoint.rows[0].net_asset_value_micro_units);
  const requests = await client.query<{ id: string; reserved_share_units: string }>(
    `SELECT requests.id, reserves.reserved_share_units::text
     FROM lp_vault_redemption_requests requests
     JOIN lp_vault_redemption_reserves reserves ON reserves.redemption_request_id = requests.id
     JOIN LATERAL (
       SELECT history.to_status
       FROM lp_vault_redemption_request_history history
       WHERE history.redemption_request_id=requests.id AND history.recorded_at <= $2
       ORDER BY history.recorded_at DESC, history.id DESC
       LIMIT 1
     ) state_at_cutoff ON state_at_cutoff.to_status IN ('admitted', 'redeeming')
     WHERE requests.vault_id = $1
     ORDER BY requests.queue_sequence FOR UPDATE OF requests`,
    [input.vaultId, canonicalTime]
  );
  if (requests.rows.length > 0 && supply <= 0n) throw new Error("lp_vault_redemption_supply_missing");
  const marks = [];
  for (const request of requests.rows) {
    const existing = await client.query<{ id: string; reserved_amount_micro_units: string }>(
      `SELECT id, reserved_amount_micro_units::text FROM lp_vault_redemption_reserve_marks
       WHERE cycle_id = $1 AND redemption_request_id = $2`, [input.cycleId, request.id]
    );
    if (existing.rows[0]) { marks.push(existing.rows[0]); continue; }
    const markId = randomUUID();
    const amount = BigInt(request.reserved_share_units) * nav / supply;
    const event = await appendLpVaultAccountingEvent(client, {
      vaultId: input.vaultId, eventType: "redemption_reserve_marked", entityId: markId,
      payload: { requestId: request.id, reservedAmountMicroUnits: amount.toString() }
    });
    const inserted = await client.query<{ id: string; reserved_amount_micro_units: string }>(
      `INSERT INTO lp_vault_redemption_reserve_marks (
         id, vault_id, cycle_id, redemption_request_id, checkpoint_id, reserved_share_units,
         reserved_amount_micro_units, calculation_version, accounting_event_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'dynamic-pro-rata-floor-v1', $8)
       RETURNING id, reserved_amount_micro_units::text`,
      [markId, input.vaultId, input.cycleId, request.id, input.checkpointId,
        request.reserved_share_units, amount.toString(), event.id]
    );
    marks.push(inserted.rows[0]);
  }
  return marks;
}

export async function finalizeEligibleLpVaultRedemptions(
  client: LpVaultAccountingQueryable,
  input: { vaultId: string; cycleId: string; checkpointId: string; canonicalTime: Date }
) {
  await acquireLpVaultAccountingAdvisoryLock(client, input.vaultId);
  const canonicalTime = asCanonicalTime(input.canonicalTime);
  const admitted = await client.query<{ id: string }>(
    `SELECT id FROM lp_vault_redemption_requests
     WHERE vault_id=$1 AND status='admitted' AND redemption_starts_at <= $2
     ORDER BY queue_sequence FOR UPDATE`, [input.vaultId, canonicalTime]
  );
  for (const request of admitted.rows) {
    const eventId = randomUUID();
    await appendLpVaultAccountingEvent(client, {
      vaultId: input.vaultId,
      eventType: "redemption_redeeming",
      entityId: eventId,
      payload: { requestId: request.id }
    });
    await client.query(
      `UPDATE lp_vault_redemption_requests SET status='redeeming',redeeming_at=now() WHERE id=$1 AND status='admitted'`,
      [request.id]
    );
  }
  const requests = await client.query<{
    id: string; position_id: string; user_id: string; requested_share_units: string; reserve_mark_id: string;
    reserved_amount_micro_units: string; checkpoint_id: string; net_asset_value_micro_units: string;
    share_supply_units: string
  }>(
    `SELECT requests.id, requests.position_id, positions.user_id, requests.requested_share_units::text,
       marks.id AS reserve_mark_id, marks.reserved_amount_micro_units::text, marks.checkpoint_id,
       checkpoints.net_asset_value_micro_units::text, checkpoints.share_supply_units::text
     FROM lp_vault_redemption_requests requests
     JOIN lp_vault_share_positions positions ON positions.id=requests.position_id AND positions.vault_id=requests.vault_id
     JOIN lp_vault_redemption_reserve_marks marks
       ON marks.redemption_request_id=requests.id AND marks.cycle_id=$2 AND marks.checkpoint_id=$3
     JOIN lp_vault_nav_checkpoints checkpoints
       ON checkpoints.id=$3 AND checkpoints.cycle_id=$2 AND checkpoints.vault_id=$1
     WHERE requests.vault_id = $1 AND requests.status = 'redeeming'
       AND requests.redemption_ends_at <= $4
     ORDER BY requests.queue_sequence FOR UPDATE OF requests`,
    [input.vaultId, input.cycleId, input.checkpointId, canonicalTime]
  );
  const results = [];
  for (const request of requests.rows) {
    const existing = await client.query<{ id: string; matured_amount_micro_units: string }>(
      `SELECT id, matured_amount_micro_units::text FROM lp_vault_redemption_payables
       WHERE redemption_request_id = $1`, [request.id]
    );
    if (existing.rows[0]) { results.push(existing.rows[0]); continue; }
    const positionBalance = await client.query<{ balance: string }>(
      `SELECT COALESCE(sum(CASE WHEN event_type = 'mint' THEN share_units ELSE -share_units END), 0)::text AS balance
       FROM lp_vault_share_events WHERE position_id = $1`, [request.position_id]
    );
    const finalized = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: BigInt(request.net_asset_value_micro_units),
      totalShareUnits: BigInt(request.share_supply_units),
      redemptions: [{ ownerId: request.position_id, shareUnits: BigInt(request.requested_share_units),
        availableShareUnits: BigInt(positionBalance.rows[0].balance) }]
    });
    const allocation = finalized.allocations[0];
    if (allocation.payableMicroUsdc !== BigInt(request.reserved_amount_micro_units)) {
      throw new Error("lp_vault_redemption_binding_mark_mismatch");
    }
    let remaining = BigInt(request.requested_share_units);
    let totalBasis = 0n;
    const lots = await client.query<{
      id: string; original_share_units: string; original_cost_basis_micro_units: string;
      burned_share_units: string; allocated_basis: string
    }>(
      `SELECT lots.id, lots.original_share_units::text, lots.original_cost_basis_micro_units::text,
         COALESCE(allocations.cumulative_burned_share_units, 0)::text AS burned_share_units,
         COALESCE(allocations.cumulative_allocated_basis_micro_units, 0)::text AS allocated_basis
      FROM lp_vault_share_lots lots
       LEFT JOIN LATERAL (
         SELECT cumulative_burned_share_units, cumulative_allocated_basis_micro_units
         FROM lp_vault_share_lot_burn_allocations WHERE lot_id=lots.id
         ORDER BY created_at DESC, id DESC LIMIT 1
       ) allocations ON true
       WHERE lots.position_id = $1 ORDER BY lots.opened_at, lots.id FOR UPDATE OF lots`,
      [request.position_id]
    );
    const plannedAllocations: Array<{
      lotId: string; burned: bigint; priorBurned: bigint; cumulativeBurned: bigint;
      allocatedBasis: bigint; priorBasis: bigint; cumulativeBasis: bigint;
    }> = [];
    for (const lot of lots.rows) {
      if (remaining === 0n) break;
      const available = BigInt(lot.original_share_units) - BigInt(lot.burned_share_units);
      const used = remaining < available ? remaining : available;
      if (used === 0n) continue;
      const basis = allocatePositionCostBasisMicroUsdc({
        originalShareUnits: BigInt(lot.original_share_units),
        originalCostBasisMicroUsdc: BigInt(lot.original_cost_basis_micro_units),
        burnedShareUnits: BigInt(lot.burned_share_units)
      }, used);
      plannedAllocations.push({ lotId: lot.id, burned: used, priorBurned: BigInt(lot.burned_share_units),
        cumulativeBurned: basis.nextLot.burnedShareUnits, allocatedBasis: basis.allocatedCostBasisMicroUsdc,
        priorBasis: BigInt(lot.allocated_basis), cumulativeBasis: basis.cumulativeAllocatedCostBasisMicroUsdc });
      totalBasis += basis.allocatedCostBasisMicroUsdc;
      remaining -= used;
    }
    if (remaining !== 0n) throw new Error("lp_vault_redemption_cost_basis_missing");
    const burnId = randomUUID();
    const payableId = randomUUID();
    const burnEvent = await appendLpVaultAccountingEvent(client, {
      vaultId: input.vaultId, eventType: "redemption_payable_matured", entityId: burnId,
      payload: { requestId: request.id, userId:request.user_id, positionId:request.position_id,
        checkpointId: request.checkpoint_id, payableId, shareUnits: request.requested_share_units,
        payableMicroUnits: allocation.payableMicroUsdc.toString(), costBasisMicroUnits: totalBasis.toString(),
        allocations:plannedAllocations.map(item=>({lotId:item.lotId,burnedShareUnits:item.burned.toString(),
          allocatedCostBasisMicroUnits:item.allocatedBasis.toString(),priorCumulativeBurnedShareUnits:item.priorBurned.toString(),
          cumulativeBurnedShareUnits:item.cumulativeBurned.toString(),
          priorCumulativeAllocatedBasisMicroUnits:item.priorBasis.toString(),
          cumulativeAllocatedBasisMicroUnits:item.cumulativeBasis.toString()})) }
    });
    await client.query(
      `INSERT INTO lp_vault_share_events (
         id, vault_id, position_id, event_type, share_units, cost_basis_micro_units,
         redemption_request_id, checkpoint_id, accounting_event_id
       ) VALUES ($1, $2, $3, 'burn', $4, $5, $6, $7, $8)`,
      [burnId, input.vaultId, request.position_id, request.requested_share_units, totalBasis.toString(),
        request.id, request.checkpoint_id, burnEvent.id]
    );
    for (const planned of plannedAllocations) {
      await client.query(
        `INSERT INTO lp_vault_share_lot_burn_allocations (
           vault_id, lot_id, burn_share_event_id, burned_share_units, allocated_cost_basis_micro_units,
           prior_cumulative_burned_share_units, cumulative_burned_share_units,
           prior_cumulative_allocated_basis_micro_units, cumulative_allocated_basis_micro_units
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.vaultId, planned.lotId, burnId, planned.burned.toString(), planned.allocatedBasis.toString(),
          planned.priorBurned.toString(), planned.cumulativeBurned.toString(), planned.priorBasis.toString(),
          planned.cumulativeBasis.toString()]
      );
    }
    await client.query(
      `INSERT INTO lp_vault_redemption_payables (
         id, vault_id, redemption_request_id, reserve_mark_id, matured_share_units,
         matured_amount_micro_units, redeemed_cost_basis_micro_units,
         finalized_redemption_pnl_micro_units, accounting_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [payableId, input.vaultId, request.id, request.reserve_mark_id, request.requested_share_units,
        allocation.payableMicroUsdc.toString(), totalBasis.toString(),
        (allocation.payableMicroUsdc - totalBasis).toString(), burnEvent.id]
    );
    await client.query(`UPDATE lp_vault_redemption_requests SET status='finalized', finalized_at=now() WHERE id=$1`, [request.id]);
    await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"redemption_finalized",entityId:request.id,
      payload:{requestId:request.id,payableId,amountMicroUnits:allocation.payableMicroUsdc.toString()}});
    await client.query(`UPDATE lp_vault_redemption_requests SET status='claimable', claimable_at=now() WHERE id=$1`, [request.id]);
    await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"redemption_claimable",entityId:request.id,
      payload:{requestId:request.id,payableId}});
    results.push({ id: payableId, matured_amount_micro_units: allocation.payableMicroUsdc.toString() });
  }
  return results;
}

export async function recognizeLpVaultFeesAndSettlements(
  client: LpVaultAccountingQueryable,
  input: { vaultId: string; cycleId: string; sourceThrough: Date }
) {
  await acquireLpVaultAccountingAdvisoryLock(client, input.vaultId);
  const inception = await client.query<{ inception_at: Date }>(
    `SELECT inception_at FROM lp_vault_accounting_inceptions WHERE vault_id=$1`, [input.vaultId]
  );
  if (!inception.rows[0]) throw new Error("lp_vault_accounting_inception_missing");
  const fees = await client.query<{
    reserve_id: string; ticket_id: string; amount_micro_units: string; effective_at: Date
  }>(`SELECT reserves.id AS reserve_id,reserves.ticket_id,reserves.operation_fee_micro_units::text AS amount_micro_units,
      reserves.created_at AS effective_at FROM ticket_reserves reserves
      LEFT JOIN lp_vault_protocol_fee_events fees ON fees.vault_id=$1 AND fees.ticket_id=reserves.ticket_id AND fees.event_type='accrual'
      WHERE reserves.accounting_mode='house_book_usdc' AND reserves.currency='USDC'
        AND reserves.created_at >= $2 AND reserves.created_at <= $3
        AND reserves.operation_fee_micro_units > 0 AND fees.id IS NULL
      ORDER BY reserves.created_at,reserves.id FOR UPDATE OF reserves`,
    [input.vaultId, inception.rows[0].inception_at, input.sourceThrough]);
  for (const fee of fees.rows) {
    const feeId=randomUUID();
    const event=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"protocol_fee_accrued",entityId:feeId,
      payload:{ticketId:fee.ticket_id,reserveId:fee.reserve_id,amountMicroUnits:fee.amount_micro_units}});
    await client.query(`INSERT INTO lp_vault_protocol_fee_events (
      id,vault_id,ticket_id,ticket_reserve_id,event_type,amount_micro_units,source_reference,evidence,effective_at,accounting_event_id)
      VALUES ($1,$2,$3,$4,'accrual',$5,$6,$7::jsonb,$8,$9)`,[feeId,input.vaultId,fee.ticket_id,fee.reserve_id,
      fee.amount_micro_units,`ticket-reserve:${fee.reserve_id}`,stableJson({source:"ticket_reserve"}),fee.effective_at,event.id]);
  }
  const settlements=await client.query<{
    summary_id:string;ticket_id:string;stake_micro_units:string;final_payout_micro_units:string;operation_fee_micro_units:string
  }>(`SELECT summaries.id AS summary_id,summaries.ticket_id,summaries.stake_micro_units::text,
      summaries.final_payout_micro_units::text,summaries.operation_fee_micro_units::text
      FROM ticket_settlement_summaries summaries
      JOIN ticket_reserves reserves ON reserves.ticket_id=summaries.ticket_id
      LEFT JOIN lp_vault_settlement_recognitions recognized ON recognized.ticket_id=summaries.ticket_id
      WHERE reserves.accounting_mode='house_book_usdc' AND reserves.currency='USDC'
        AND summaries.created_at > $1 AND summaries.created_at <= $2 AND recognized.id IS NULL
      ORDER BY summaries.created_at,summaries.id FOR UPDATE OF summaries`,
    [inception.rows[0].inception_at, input.sourceThrough]);
  for(const settlement of settlements.rows){
    const recognitionId=randomUUID(); const pnl=BigInt(settlement.stake_micro_units)-BigInt(settlement.final_payout_micro_units);
    const event=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"settlement_recognized",entityId:recognitionId,
      payload:{ticketId:settlement.ticket_id,settlementSummaryId:settlement.summary_id,finalizedPnlMicroUnits:pnl.toString()}});
    await client.query(`INSERT INTO lp_vault_settlement_recognitions (
      id,vault_id,cycle_id,ticket_id,settlement_summary_id,frozen_stake_micro_units,final_payout_micro_units,
      protocol_fee_micro_units,finalized_pnl_micro_units,accounting_event_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[recognitionId,input.vaultId,input.cycleId,settlement.ticket_id,
      settlement.summary_id,settlement.stake_micro_units,settlement.final_payout_micro_units,
      settlement.operation_fee_micro_units,pnl.toString(),event.id]);
  }
  return { protocolFeesAccrued: fees.rows.length, settlementsRecognized: settlements.rows.length };
}

export async function closeLpVaultAccountingCycle(
  client: LpVaultAccountingQueryable,
  input: CloseLpVaultCycleInput
): Promise<VerifiedLpVaultAccounting> {
  await acquireLpVaultAccountingAdvisoryLock(client, input.vaultId);
  if (!Number.isSafeInteger(input.sourceMaxAgeMs) || input.sourceMaxAgeMs < 0 || input.sourceMaxAgeMs > 300_000) {
    throw new Error("invalid_lp_vault_source_max_age_ms");
  }
  const cycle = await client.query<{ cutoff_date: string; status: string }>(
    `SELECT cutoff_date::text, status FROM lp_vault_daily_cycles WHERE id=$1 AND vault_id=$2 FOR UPDATE`,
    [input.cycleId, input.vaultId]
  );
  if (!cycle.rows[0]) throw new Error("lp_vault_cycle_missing");
  if (cycle.rows[0].status === "closed") {
    const loaded = await loadLatestVerifiedLpVaultAccounting(input.vaultId, client);
    if (!loaded || loaded.cycleId !== input.cycleId) throw new Error("lp_vault_closed_cycle_not_latest");
    return loaded;
  }
  if (cycle.rows[0].status !== "open") throw new Error("lp_vault_cycle_partial_state");
  const reconciliation = await client.query<{
    created_at: Date; source_as_of: Date; treasury_assets_micro_units: string; user_available_micro_units: string;
    user_claimable_micro_units: string; user_checkout_micro_units: string; pending_withdrawal_micro_units: string;
    observed_block_number: string; observed_block_hash: string
  }>(
    `SELECT created_at,
       to_timestamp((metrics->>'observedBlockTimestamp')::double precision) AS source_as_of,
       treasury_assets_micro_units::text, user_available_micro_units::text,
       user_claimable_micro_units::text, user_checkout_micro_units::text, pending_withdrawal_micro_units::text,
       observed_block_number::text, observed_block_hash
     FROM financial_reconciliation_snapshots
     WHERE id=$1 AND source='worker' AND unexplained_delta_micro_units=0
       AND COALESCE(metrics->>'observedBlockTimestamp','') ~ '^[0-9]+$'
       AND to_timestamp((metrics->>'observedBlockTimestamp')::double precision)
         >= ($2::date::timestamp AT TIME ZONE 'UTC')
       AND to_timestamp((metrics->>'observedBlockTimestamp')::double precision)
         <= ($2::date::timestamp AT TIME ZONE 'UTC') + ($3::bigint * interval '1 millisecond')
       AND to_timestamp((metrics->>'observedBlockTimestamp')::double precision) <= created_at
       AND created_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
       AND created_at <= ($2::date::timestamp AT TIME ZONE 'UTC') + ($3::bigint * interval '1 millisecond')`,
    [input.reconciliationId, cycle.rows[0].cutoff_date, input.sourceMaxAgeMs]
  );
  if (!reconciliation.rows[0]?.observed_block_hash || reconciliation.rows[0].observed_block_number === null) {
    throw new Error("lp_vault_reconciliation_stale_or_untrusted");
  }
  await recognizeLpVaultFeesAndSettlements(client, {
    vaultId: input.vaultId,
    cycleId: input.cycleId,
    sourceThrough: reconciliation.rows[0].created_at
  });
  const openTickets = await loadUnresolvedLpVaultTicketsAsOf(client, reconciliation.rows[0].created_at);
  const supplied = new Map(input.ticketMarks.map((mark) => [mark.ticketId, mark]));
  if (supplied.size !== input.ticketMarks.length || openTickets.some((ticket) => !supplied.has(ticket.ticket_id))
    || input.ticketMarks.some((mark) => !openTickets.some((ticket) => ticket.ticket_id === mark.ticketId))) {
    throw new Error("lp_vault_ticket_mark_coverage_mismatch");
  }
  let gross = 0n;
  let marked = 0n;
  let fallback = 0n;
  for (const ticket of openTickets) {
    const write = supplied.get(ticket.ticket_id)!;
    const grossPayout = BigInt(ticket.offered_payout_micro_units);
    assertSupportedLpVaultLiabilityMarkSource((write as {markSource:unknown}).markSource);
    if (write.evidenceTime > reconciliation.rows[0].created_at || write.markedLiabilityMicroUnits < 0n
      || write.markedLiabilityMicroUnits > grossPayout
      || write.markedLiabilityMicroUnits !== grossPayout) {
      throw new Error("lp_vault_ticket_mark_invalid");
    }
    const markId = randomUUID();
    const event = await appendLpVaultAccountingEvent(client, {
      vaultId: input.vaultId, eventType: "ticket_liability_marked", entityId: markId,
      payload: { ticketId: ticket.ticket_id, markedLiabilityMicroUnits: write.markedLiabilityMicroUnits.toString() }
    });
    await client.query(
      `INSERT INTO lp_vault_ticket_liability_marks (
         id,vault_id,cycle_id,ticket_id,stake_micro_units,gross_payout_micro_units,
         marked_liability_micro_units,mark_source,fallback_reason,evidence_time,accounting_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [markId,input.vaultId,input.cycleId,ticket.ticket_id,ticket.stake_micro_units,ticket.offered_payout_micro_units,
        write.markedLiabilityMicroUnits.toString(),write.markSource,write.fallbackReason ?? null,write.evidenceTime,event.id]
    );
    gross += grossPayout;
    marked += write.markedLiabilityMicroUnits;
    if (write.markSource === "gross_payout_fallback") fallback += grossPayout;
  }
  const sums = await client.query<{
    protocol_fee: string; expenses: string; pending: string; matured: string; finalized: string; supply: string
  }>(`SELECT
      (SELECT COALESCE(sum(CASE WHEN event_type='accrual' THEN amount_micro_units ELSE -amount_micro_units END),0)::text
       FROM lp_vault_protocol_fee_events WHERE vault_id=$1 AND effective_at <= $2) AS protocol_fee,
      (SELECT COALESCE(sum(amount_micro_units),0)::text FROM lp_vault_approved_expense_accruals
       WHERE vault_id=$1 AND accrued_on <= $3::date) AS expenses,
      (SELECT COALESCE(sum(amount_micro_units),0)::text FROM lp_vault_pending_deposits WHERE vault_id=$1 AND status='pending') AS pending,
      (SELECT COALESCE(sum(matured_amount_micro_units),0)::text FROM lp_vault_redemption_payables WHERE vault_id=$1) AS matured,
      (SELECT COALESCE(sum(finalized_pnl_micro_units),0)::text FROM lp_vault_settlement_recognitions WHERE vault_id=$1) AS finalized,
      (SELECT COALESCE(sum(CASE WHEN event_type='mint' THEN share_units ELSE -share_units END),0)::text
       FROM lp_vault_share_events WHERE vault_id=$1) AS supply`,
    [input.vaultId,reconciliation.rows[0].created_at,cycle.rows[0].cutoff_date]
  );
  const senior = BigInt(reconciliation.rows[0].user_available_micro_units)+BigInt(reconciliation.rows[0].user_claimable_micro_units)
    +BigInt(reconciliation.rows[0].user_checkout_micro_units)+BigInt(reconciliation.rows[0].pending_withdrawal_micro_units);
  const deductions = senior+marked+BigInt(sums.rows[0].protocol_fee)+BigInt(sums.rows[0].expenses)
    +BigInt(sums.rows[0].pending)+BigInt(sums.rows[0].matured);
  const assets = BigInt(reconciliation.rows[0].treasury_assets_micro_units);
  if (assets < deductions) throw new Error("lp_vault_economic_nav_negative");
  if (BigInt(sums.rows[0].supply) === 0n && assets !== deductions) {
    throw new Error("lp_vault_positive_nav_without_shares");
  }
  const liabilityId=randomUUID();
  const liabilityEvent=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"liability_marked",entityId:liabilityId,
    payload:{cycleId:input.cycleId,reconciliationId:input.reconciliationId,grossAssetsMicroUnits:assets.toString(),
      navDeductionsMicroUnits:deductions.toString()}});
  await client.query(`INSERT INTO lp_vault_liability_marks (
    id,vault_id,cycle_id,source_reconciliation_snapshot_id,canonical_block_number,canonical_block_hash,
    senior_user_obligations_micro_units,gross_unresolved_payouts_micro_units,marked_unresolved_liability_micro_units,
    protocol_fee_payable_micro_units,approved_expense_payable_micro_units,pending_deposit_liability_micro_units,
    matured_redemption_payable_micro_units,nav_deductions_micro_units,accounting_event_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [liabilityId,input.vaultId,input.cycleId,input.reconciliationId,reconciliation.rows[0].observed_block_number,
      reconciliation.rows[0].observed_block_hash,senior.toString(),gross.toString(),marked.toString(),sums.rows[0].protocol_fee,
      sums.rows[0].expenses,sums.rows[0].pending,sums.rows[0].matured,deductions.toString(),liabilityEvent.id]);
  await client.query(`UPDATE lp_vault_daily_cycles SET status='marked',marked_at=now() WHERE id=$1`,[input.cycleId]);
  const prior=await client.query<{id:string}>(`SELECT id FROM lp_vault_nav_checkpoints WHERE vault_id=$1 ORDER BY accounting_version DESC LIMIT 1`,[input.vaultId]);
  const checkpointId=randomUUID();
  const checkpointEvent=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"nav_checkpointed",entityId:checkpointId,
    payload:{cycleId:input.cycleId,liabilityMarkId:liabilityId,reconciliationId:input.reconciliationId,
      grossAssetsMicroUnits:assets.toString(),navDeductionsMicroUnits:deductions.toString(),
      economicNavMicroUnits:(assets-deductions).toString(),shareSupplyUnits:sums.rows[0].supply}});
  const estimated=openTickets.reduce((total,ticket)=>total+BigInt(ticket.stake_micro_units)-supplied.get(ticket.ticket_id)!.markedLiabilityMicroUnits,0n);
  await client.query(`INSERT INTO lp_vault_nav_checkpoints (
    id,vault_id,cycle_id,liability_mark_id,source_reconciliation_snapshot_id,prior_checkpoint_id,accounting_event_id,
    accounting_version,gross_assets_micro_units,net_asset_value_micro_units,share_supply_units,
    share_price_numerator_micro_units,share_price_denominator_units,estimated_pnl_micro_units,finalized_pnl_micro_units,calculation_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$11,$12,$13,'rolling-nav-v1')`,
    [checkpointId,input.vaultId,input.cycleId,liabilityId,input.reconciliationId,prior.rows[0]?.id??null,checkpointEvent.id,
      checkpointEvent.bookVersion.toString(),assets.toString(),(assets-deductions).toString(),sums.rows[0].supply,
      estimated.toString(),sums.rows[0].finalized]);
  await markActiveLpVaultRedemptionReserves(client,{
    vaultId:input.vaultId,cycleId:input.cycleId,checkpointId,canonicalTime:reconciliation.rows[0].created_at
  });
  const activeReserve=await client.query<{value:string}>(`SELECT COALESCE(sum(reserved_amount_micro_units),0)::text AS value
    FROM lp_vault_redemption_reserve_marks WHERE cycle_id=$1`,[input.cycleId]);
  const collateral=deductions-marked+gross+BigInt(activeReserve.rows[0].value);
  if(assets<collateral) throw new Error("lp_vault_collateral_shortfall");
  const liquidityId=randomUUID();
  const liquidityEvent=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"liquidity_marked",entityId:liquidityId,
    payload:{freeLiquidityMicroUnits:(assets-collateral).toString()}});
  await client.query(`INSERT INTO lp_vault_liquidity_marks (
    id,vault_id,cycle_id,checkpoint_id,nav_deductions_micro_units,active_redemption_reserve_micro_units,
    collateral_requirements_micro_units,free_liquidity_micro_units,accounting_event_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[liquidityId,input.vaultId,input.cycleId,checkpointId,deductions.toString(),
      activeReserve.rows[0].value,collateral.toString(),(assets-collateral).toString(),liquidityEvent.id]);
  await client.query(`UPDATE lp_vault_daily_cycles SET status='checkpointed',checkpointed_at=now() WHERE id=$1`,[input.cycleId]);
  await finalizeEligibleLpVaultRedemptions(client, {
    vaultId: input.vaultId,
    cycleId: input.cycleId,
    checkpointId,
    canonicalTime: reconciliation.rows[0].created_at
  });
  await activateEligibleLpVaultPendingDeposits(client, {
    vaultId: input.vaultId,
    cutoffDate: cycle.rows[0].cutoff_date,
    pricingCheckpointId: checkpointId
  });
  const closing = await client.query<{
    activated: string; matured: string; burned: string; supply: string
  }>(`SELECT
      COALESCE((SELECT sum(amount_micro_units) FROM lp_vault_pending_deposits
        WHERE vault_id=$1 AND status='active' AND activation_checkpoint_id=$2),0)::text AS activated,
      COALESCE((SELECT sum(payables.matured_amount_micro_units) FROM lp_vault_redemption_payables payables
        JOIN lp_vault_redemption_reserve_marks marks ON marks.id=payables.reserve_mark_id
        WHERE payables.vault_id=$1 AND marks.checkpoint_id=$2),0)::text AS matured,
      COALESCE((SELECT sum(payables.matured_share_units) FROM lp_vault_redemption_payables payables
        JOIN lp_vault_redemption_reserve_marks marks ON marks.id=payables.reserve_mark_id
        WHERE payables.vault_id=$1 AND marks.checkpoint_id=$2),0)::text AS burned,
      COALESCE((SELECT sum(CASE WHEN event_type='mint' THEN share_units ELSE -share_units END)
        FROM lp_vault_share_events WHERE vault_id=$1),0)::text AS supply`, [input.vaultId,checkpointId]);
  const checkpointNav=assets-deductions;
  const burned=BigInt(closing.rows[0].burned);
  const checkpointSupply=BigInt(sums.rows[0].supply);
  const matured=BigInt(closing.rows[0].matured);
  const protocolDust=checkpointSupply>0n&&burned===checkpointSupply?checkpointNav-matured:0n;
  const closingNav=checkpointNav+BigInt(closing.rows[0].activated)-matured-protocolDust;
  if(closingNav<0n||(BigInt(closing.rows[0].supply)===0n&&closingNav>0n))
    throw new Error("lp_vault_invalid_cycle_closing_state");
  const closingId=randomUUID();
  const closingEvent=await appendLpVaultAccountingEvent(client,{vaultId:input.vaultId,eventType:"cycle_closed",entityId:closingId,
    payload:{cycleId:input.cycleId,checkpointId,activatedDepositMicroUnits:closing.rows[0].activated,
      maturedRedemptionMicroUnits:closing.rows[0].matured,
      protocolRoundingDustMicroUnits:protocolDust.toString(),closingEconomicNavMicroUnits:closingNav.toString(),
      closingShareSupplyUnits:closing.rows[0].supply}});
  await client.query(`INSERT INTO lp_vault_cycle_closing_states (
    id,vault_id,cycle_id,checkpoint_id,activated_deposit_micro_units,matured_redemption_micro_units,
    protocol_rounding_dust_micro_units,closing_economic_nav_micro_units,closing_share_supply_units,accounting_event_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[closingId,input.vaultId,input.cycleId,checkpointId,
      closing.rows[0].activated,closing.rows[0].matured,protocolDust.toString(),closingNav.toString(),closing.rows[0].supply,closingEvent.id]);
  await client.query(`UPDATE lp_vault_daily_cycles SET status='closed',closed_at=now() WHERE id=$1`,[input.cycleId]);
  const loaded=await loadLatestVerifiedLpVaultAccounting(input.vaultId,client);
  if(!loaded) throw new Error("lp_vault_closed_cycle_unavailable");
  return loaded;
}

export async function loadLatestVerifiedLpVaultAccounting(
  vaultId: string,
  queryable: LpVaultAccountingQueryable = getPool()
): Promise<VerifiedLpVaultAccounting | undefined> {
  const result=await queryable.query<{
    vault_id:string;cycle_id:string;cutoff_date:string;as_of:Date|null;processed_at:Date;reconciliation_id:string;book_version:string;
    canonical_block_number:string;canonical_block_hash:string;gross_assets:string;nav:string;supply:string;
    price_numerator:string;price_denominator:string;pending:string;estimated:string;finalized:string;marked:string;gross:string;
    fallback:string;ticket_count:string;reliable_count:string;active_reserve:string;collateral:string;free:string
  }>(`SELECT checkpoints.vault_id,cycles.id AS cycle_id,cycles.cutoff_date::text,
      CASE WHEN COALESCE(source_reconciliation.metrics->>'observedBlockTimestamp','') ~ '^[0-9]+$'
        THEN to_timestamp((source_reconciliation.metrics->>'observedBlockTimestamp')::double precision)
        ELSE NULL END AS as_of,
      closing_state.closed_at AS processed_at,
      checkpoints.source_reconciliation_snapshot_id AS reconciliation_id,closing_event.book_version::text AS book_version,
      liabilities.canonical_block_number::text,liabilities.canonical_block_hash,
      checkpoints.gross_assets_micro_units::text AS gross_assets,
      closing_state.closing_economic_nav_micro_units::text AS nav,
      closing_state.closing_share_supply_units::text AS supply,
      closing_state.closing_economic_nav_micro_units::text AS price_numerator,
      closing_state.closing_share_supply_units::text AS price_denominator,
      (liabilities.pending_deposit_liability_micro_units-closing_state.activated_deposit_micro_units)::text AS pending,
      checkpoints.estimated_pnl_micro_units::text AS estimated,
      checkpoints.finalized_pnl_micro_units::text AS finalized,liabilities.marked_unresolved_liability_micro_units::text AS marked,
      liabilities.gross_unresolved_payouts_micro_units::text AS gross,
      COALESCE(ticket_marks.fallback,0)::text AS fallback,COALESCE(ticket_marks.ticket_count,0)::text AS ticket_count,
      COALESCE(ticket_marks.reliable_count,0)::text AS reliable_count,
      (liquidity.active_redemption_reserve_micro_units-closing_state.matured_redemption_micro_units)::text AS active_reserve,
      (liabilities.senior_user_obligations_micro_units + liabilities.protocol_fee_payable_micro_units
        + liabilities.approved_expense_payable_micro_units
        + liabilities.pending_deposit_liability_micro_units-closing_state.activated_deposit_micro_units
        + liabilities.matured_redemption_payable_micro_units+closing_state.matured_redemption_micro_units
        + closing_state.protocol_rounding_dust_micro_units + liabilities.gross_unresolved_payouts_micro_units
        + liquidity.active_redemption_reserve_micro_units-closing_state.matured_redemption_micro_units)::text AS collateral,
      (checkpoints.gross_assets_micro_units - liabilities.senior_user_obligations_micro_units
        - liabilities.protocol_fee_payable_micro_units - liabilities.approved_expense_payable_micro_units
        - liabilities.pending_deposit_liability_micro_units+closing_state.activated_deposit_micro_units
        - liabilities.matured_redemption_payable_micro_units-closing_state.matured_redemption_micro_units
        - closing_state.protocol_rounding_dust_micro_units - liabilities.gross_unresolved_payouts_micro_units
        - liquidity.active_redemption_reserve_micro_units+closing_state.matured_redemption_micro_units)::text AS free
    FROM lp_vault_daily_cycles cycles
    JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.cycle_id=cycles.id
    JOIN lp_vault_liability_marks liabilities ON liabilities.id=checkpoints.liability_mark_id
    JOIN lp_vault_liquidity_marks liquidity ON liquidity.checkpoint_id=checkpoints.id
    JOIN lp_vault_cycle_closing_states closing_state ON closing_state.checkpoint_id=checkpoints.id
    JOIN lp_vault_accounting_events closing_event ON closing_event.id=closing_state.accounting_event_id
    JOIN financial_reconciliation_snapshots source_reconciliation
      ON source_reconciliation.id=checkpoints.source_reconciliation_snapshot_id
    LEFT JOIN LATERAL (SELECT sum(gross_payout_micro_units) FILTER (WHERE mark_source='gross_payout_fallback') AS fallback,
      count(*) AS ticket_count,count(*) FILTER (WHERE mark_source='reliable_mark') AS reliable_count
      FROM lp_vault_ticket_liability_marks WHERE cycle_id=cycles.id) ticket_marks ON true
    WHERE cycles.vault_id=$1 AND cycles.status='closed' ORDER BY cycles.cutoff_date DESC LIMIT 1`,[vaultId]);
  const row=result.rows[0]; if(!row)return undefined;
  if(!row.as_of||row.processed_at<row.as_of) throw new Error("lp_vault_accounting_source_time_invalid");
  const ticketCount=BigInt(row.ticket_count); const reliableCount=BigInt(row.reliable_count);
  if(ticketCount<0n||reliableCount<0n||reliableCount>ticketCount)
    throw new Error("lp_vault_liability_mark_coverage_invalid");
  return {vaultId:row.vault_id,cycleId:row.cycle_id,cutoffDate:row.cutoff_date,asOf:row.as_of,processedAt:row.processed_at,
    reconciliationId:row.reconciliation_id,bookVersion:BigInt(row.book_version),canonicalBlockNumber:BigInt(row.canonical_block_number),
    canonicalBlockHash:row.canonical_block_hash,grossAssetsMicroUnits:BigInt(row.gross_assets),economicNavMicroUnits:BigInt(row.nav),
    activeShareUnits:BigInt(row.supply),sharePriceNumeratorMicroUnits:BigInt(row.price_numerator),
    sharePriceDenominatorUnits:BigInt(row.price_denominator),pendingActivationMicroUnits:BigInt(row.pending),
    estimatedPnlMicroUnits:BigInt(row.estimated),finalizedPnlMicroUnits:BigInt(row.finalized),
    markedUnresolvedLiabilityMicroUnits:BigInt(row.marked),grossUnresolvedPayoutsMicroUnits:BigInt(row.gross),
    fullLiabilityFallbackMicroUnits:BigInt(row.fallback),
    liabilityMarkCoverageBps:ticketCount===0n?10000:Number(reliableCount*10000n/ticketCount),
    activeRedemptionReserveMicroUnits:BigInt(row.active_reserve),collateralRequirementsMicroUnits:BigInt(row.collateral),
    freeLiquidityMicroUnits:BigInt(row.free)};
}

export async function replayLpVaultAccounting(
  vaultId: string,
  queryable: LpVaultAccountingQueryable = getPool()
): Promise<LpVaultAccountingReplay> {
  requireUuid(vaultId, "vault_id");
  const events=await queryable.query<EventRow>(`SELECT *,payload::text AS payload_text FROM lp_vault_accounting_events
    WHERE vault_id=$1 ORDER BY book_version`,[vaultId]);
  if(events.rows.length===0) throw new Error("lp_vault_accounting_events_missing");
  let previousHash:string|undefined;
  let checkpointCount=0;
  let shareEventCount=0;
  let totalMintedShareUnits=0n;
  let totalBurnedShareUnits=0n;
  let replayedShareSupplyUnits=0n;
  let latestLiability:{grossAssetsMicroUnits:bigint;navDeductionsMicroUnits:bigint}|undefined;
  const checkpoints=new Map<string,{
    grossAssetsMicroUnits:bigint;navDeductionsMicroUnits:bigint;economicNavMicroUnits:bigint;shareSupplyUnits:bigint;
  }>();
  type ReplayedClosedState={
    entityId:string;checkpointId:string;bookVersion:bigint;economicNavMicroUnits:bigint;shareSupplyUnits:bigint;
    grossAssetsMicroUnits:bigint;navDeductionsMicroUnits:bigint;
  };
  const closedStates:ReplayedClosedState[]=[];
  const payloadBigint=(row:EventRow,key:string)=>{
    const value=row.payload[key];
    if(typeof value!=="string"||!/^\d+$/.test(value)) throw new Error(`lp_vault_accounting_event_payload_invalid:${row.event_type}:${key}`);
    return BigInt(value);
  };
  const payloadUuid=(row:EventRow,key:string)=>{
    const value=row.payload[key];
    if(typeof value!=="string") throw new Error(`lp_vault_accounting_event_payload_invalid:${row.event_type}:${key}`);
    return requireUuid(value,`event_${key}`);
  };
  for(let index=0;index<events.rows.length;index+=1){const row=events.rows[index]; const version=BigInt(row.book_version);
    if(version!==BigInt(index+1)||row.previous_event_hash!==(previousHash??null)) throw new Error("lp_vault_accounting_book_version_gap");
    const payloadHash=sha256(row.payload_text);
    const eventHash=sha256(`${row.vault_id}:${row.book_version}:${previousHash??""}:${row.event_type}:${row.entity_id}:${payloadHash}`);
    if(payloadHash!==row.payload_hash||eventHash!==row.event_hash) throw new Error("lp_vault_accounting_hash_chain_mismatch");
    previousHash=row.event_hash;
    if(row.event_type==="liability_marked"){
      const navDeductionsMicroUnits=payloadBigint(row,"navDeductionsMicroUnits");
      const grossPayload=row.payload.grossAssetsMicroUnits;
      latestLiability={navDeductionsMicroUnits,grossAssetsMicroUnits:
        typeof grossPayload==="string"&&/^\d+$/.test(grossPayload)?BigInt(grossPayload):-1n};
    }else if(row.event_type==="nav_checkpointed"){
      checkpointCount+=1;
      const economicNavMicroUnits=payloadBigint(row,"economicNavMicroUnits");
      const shareSupplyUnits=payloadBigint(row,"shareSupplyUnits");
      const deductionsPayload=row.payload.navDeductionsMicroUnits;
      const grossPayload=row.payload.grossAssetsMicroUnits;
      const navDeductionsMicroUnits=typeof deductionsPayload==="string"&&/^\d+$/.test(deductionsPayload)
        ?BigInt(deductionsPayload):latestLiability?.navDeductionsMicroUnits;
      if(navDeductionsMicroUnits===undefined) throw new Error("lp_vault_accounting_checkpoint_liability_missing");
      const grossAssetsMicroUnits=typeof grossPayload==="string"&&/^\d+$/.test(grossPayload)
        ?BigInt(grossPayload):latestLiability?.grossAssetsMicroUnits===-1n
          ?economicNavMicroUnits+navDeductionsMicroUnits:latestLiability?.grossAssetsMicroUnits;
      if(grossAssetsMicroUnits===undefined||grossAssetsMicroUnits-economicNavMicroUnits!==navDeductionsMicroUnits)
        throw new Error("lp_vault_accounting_nav_mismatch");
      if(latestLiability&&(latestLiability.navDeductionsMicroUnits!==navDeductionsMicroUnits
        ||(latestLiability.grossAssetsMicroUnits>=0n&&latestLiability.grossAssetsMicroUnits!==grossAssetsMicroUnits)))
        throw new Error("lp_vault_accounting_checkpoint_liability_mismatch");
      if(shareSupplyUnits!==replayedShareSupplyUnits) throw new Error("lp_vault_accounting_checkpoint_share_supply_mismatch");
      checkpoints.set(row.entity_id,{grossAssetsMicroUnits,navDeductionsMicroUnits,economicNavMicroUnits,shareSupplyUnits});
    }else if(row.event_type==="deposit_activated"){
      const shareUnits=payloadBigint(row,"shareUnits");
      if(shareUnits<=0n) throw new Error("lp_vault_accounting_event_share_units_invalid");
      shareEventCount+=1; totalMintedShareUnits+=shareUnits; replayedShareSupplyUnits+=shareUnits;
    }else if(row.event_type==="redemption_payable_matured"){
      const shareUnits=payloadBigint(row,"shareUnits");
      if(shareUnits<=0n||shareUnits>replayedShareSupplyUnits) throw new Error("lp_vault_accounting_event_share_units_invalid");
      shareEventCount+=1; totalBurnedShareUnits+=shareUnits; replayedShareSupplyUnits-=shareUnits;
    }else if(row.event_type==="cycle_closed"){
      const checkpointId=payloadUuid(row,"checkpointId");
      const checkpoint=checkpoints.get(checkpointId);
      if(!checkpoint) throw new Error("lp_vault_accounting_closing_checkpoint_missing");
      const activated=payloadBigint(row,"activatedDepositMicroUnits");
      const matured=payloadBigint(row,"maturedRedemptionMicroUnits");
      const dust=payloadBigint(row,"protocolRoundingDustMicroUnits");
      const economicNavMicroUnits=payloadBigint(row,"closingEconomicNavMicroUnits");
      const shareSupplyUnits=payloadBigint(row,"closingShareSupplyUnits");
      if(economicNavMicroUnits!==checkpoint.economicNavMicroUnits+activated-matured-dust
        ||shareSupplyUnits!==replayedShareSupplyUnits) throw new Error("lp_vault_accounting_closing_state_mismatch");
      const navDeductionsMicroUnits=checkpoint.grossAssetsMicroUnits-economicNavMicroUnits;
      if(navDeductionsMicroUnits<0n) throw new Error("lp_vault_accounting_nav_mismatch");
      closedStates.push({entityId:row.entity_id,checkpointId,bookVersion:version,economicNavMicroUnits,shareSupplyUnits,
        grossAssetsMicroUnits:checkpoint.grossAssetsMicroUnits,navDeductionsMicroUnits});
    }
  }
  const latestClosed=closedStates.at(-1);
  if(!latestClosed) throw new Error("lp_vault_accounting_checkpoint_missing");
  const postCloseEvents=events.rows.slice(Number(latestClosed.bookVersion));
  if(postCloseEvents.some(event=>!NON_VALUING_POST_CLOSE_EVENT_TYPES.has(event.event_type)))
    throw new Error("lp_vault_accounting_valuing_event_after_close");
  if(replayedShareSupplyUnits!==latestClosed.shareSupplyUnits)
    throw new Error("lp_vault_accounting_post_close_share_supply_mismatch");
  const projection=await queryable.query<{
    checkpoint_count:string;share_event_count:string;minted:string;burned:string;supply:string;
    closed_cycle_count:string;closing_state_count:string;closing_id:string|null;closing_event_version:string|null;
    checkpoint_id:string|null;closing_nav:string|null;closing_supply:string|null;checkpoint_gross:string|null;
    checkpoint_nav:string|null;checkpoint_supply:string|null;checkpoint_deductions:string|null;
    activated:string|null;matured:string|null;dust:string|null;
  }>(`SELECT
      (SELECT count(*) FROM lp_vault_nav_checkpoints WHERE vault_id=$1)::text AS checkpoint_count,
      (SELECT count(*) FROM lp_vault_share_events WHERE vault_id=$1)::text AS share_event_count,
      COALESCE((SELECT sum(share_units) FROM lp_vault_share_events WHERE vault_id=$1 AND event_type='mint'),0)::text AS minted,
      COALESCE((SELECT sum(share_units) FROM lp_vault_share_events WHERE vault_id=$1 AND event_type='burn'),0)::text AS burned,
      COALESCE((SELECT sum(CASE WHEN event_type='mint' THEN share_units ELSE -share_units END)
        FROM lp_vault_share_events WHERE vault_id=$1),0)::text AS supply,
      (SELECT count(*) FROM lp_vault_daily_cycles WHERE vault_id=$1 AND status='closed')::text AS closed_cycle_count,
      (SELECT count(*) FROM lp_vault_cycle_closing_states WHERE vault_id=$1)::text AS closing_state_count,
      latest.closing_id,latest.closing_event_version,latest.checkpoint_id,latest.closing_nav,latest.closing_supply,
      latest.checkpoint_gross,latest.checkpoint_nav,latest.checkpoint_supply,latest.checkpoint_deductions,
      latest.activated,latest.matured,latest.dust
    FROM (SELECT 1) singleton
    LEFT JOIN LATERAL (
      SELECT closing.id AS closing_id,events.book_version::text AS closing_event_version,
        checkpoints.id AS checkpoint_id,closing.closing_economic_nav_micro_units::text AS closing_nav,
        closing.closing_share_supply_units::text AS closing_supply,
        checkpoints.gross_assets_micro_units::text AS checkpoint_gross,
        checkpoints.net_asset_value_micro_units::text AS checkpoint_nav,
        checkpoints.share_supply_units::text AS checkpoint_supply,
        liabilities.nav_deductions_micro_units::text AS checkpoint_deductions,
        closing.activated_deposit_micro_units::text AS activated,
        closing.matured_redemption_micro_units::text AS matured,
        closing.protocol_rounding_dust_micro_units::text AS dust
      FROM lp_vault_cycle_closing_states closing
      JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.id=closing.checkpoint_id
      JOIN lp_vault_liability_marks liabilities ON liabilities.id=checkpoints.liability_mark_id
      JOIN lp_vault_accounting_events events ON events.id=closing.accounting_event_id
      WHERE closing.vault_id=$1 ORDER BY events.book_version
    ) latest ON true`,[vaultId]);
  const row=projection.rows[0];
  if(!row||projection.rows.length!==closedStates.length||!row.closing_id||!row.closing_event_version||!row.checkpoint_id)
    throw new Error("lp_vault_accounting_projection_missing");
  const cycleCloseCount=closedStates.length;
  if(Number(row.checkpoint_count)!==checkpointCount||Number(row.share_event_count)!==shareEventCount
    ||BigInt(row.minted)!==totalMintedShareUnits||BigInt(row.burned)!==totalBurnedShareUnits
    ||BigInt(row.supply)!==replayedShareSupplyUnits||Number(row.closed_cycle_count)!==cycleCloseCount
    ||row.closed_cycle_count!==row.closing_state_count) throw new Error("lp_vault_accounting_projection_mismatch");
  for(const [index,projected] of projection.rows.entries()){
    const replayed=closedStates[index];
    if(!projected.closing_id||!projected.closing_event_version||!projected.checkpoint_id||projected.closing_nav===null
      ||projected.closing_supply===null||projected.checkpoint_gross===null||projected.checkpoint_nav===null
      ||projected.checkpoint_supply===null||projected.checkpoint_deductions===null||projected.activated===null
      ||projected.matured===null||projected.dust===null) throw new Error("lp_vault_accounting_projection_missing");
    const checkpoint=checkpoints.get(replayed.checkpointId);
    const projectedClosingNav=BigInt(projected.checkpoint_nav)+BigInt(projected.activated)
      -BigInt(projected.matured)-BigInt(projected.dust);
    if(projected.closing_id!==replayed.entityId||BigInt(projected.closing_event_version)!==replayed.bookVersion
      ||projected.checkpoint_id!==replayed.checkpointId||BigInt(projected.closing_nav)!==replayed.economicNavMicroUnits
      ||BigInt(projected.closing_supply)!==replayed.shareSupplyUnits
      ||BigInt(projected.checkpoint_gross)!==replayed.grossAssetsMicroUnits
      ||BigInt(projected.checkpoint_deductions)!==checkpoint?.navDeductionsMicroUnits
      ||BigInt(projected.checkpoint_nav)!==checkpoint?.economicNavMicroUnits
      ||BigInt(projected.checkpoint_supply)!==checkpoint?.shareSupplyUnits
      ||projectedClosingNav!==BigInt(projected.closing_nav)) throw new Error("lp_vault_accounting_projection_mismatch");
  }

  const shareEventProjection=await queryable.query<{
    accounting_event_id:string;projection_matches:boolean;
  }>(`SELECT accounting_events.id AS accounting_event_id,
      CASE WHEN share_events.event_type='mint' THEN
        accounting_events.event_type='deposit_activated'
        AND accounting_events.entity_id=share_events.id
        AND accounting_events.payload=jsonb_build_object(
          'depositId',share_events.pending_deposit_id::text,
          'userId',positions.user_id::text,
          'positionId',share_events.position_id::text,
          'checkpointId',share_events.checkpoint_id::text,
          'lotId',lots.id::text,
          'amountMicroUnits',share_events.cost_basis_micro_units::text,
          'shareUnits',share_events.share_units::text
        )
      ELSE
        accounting_events.event_type='redemption_payable_matured'
        AND accounting_events.entity_id=share_events.id
        AND accounting_events.payload=jsonb_build_object(
          'requestId',share_events.redemption_request_id::text,
          'userId',positions.user_id::text,
          'positionId',share_events.position_id::text,
          'checkpointId',share_events.checkpoint_id::text,
          'payableId',payables.id::text,
          'shareUnits',share_events.share_units::text,
          'payableMicroUnits',payables.matured_amount_micro_units::text,
          'costBasisMicroUnits',share_events.cost_basis_micro_units::text,
          'allocations',COALESCE(allocations.items,'[]'::jsonb)
        )
      END AS projection_matches
    FROM lp_vault_share_events share_events
    JOIN lp_vault_share_positions positions ON positions.id=share_events.position_id
    JOIN lp_vault_accounting_events accounting_events ON accounting_events.id=share_events.accounting_event_id
    LEFT JOIN lp_vault_share_lots lots ON lots.mint_share_event_id=share_events.id
    LEFT JOIN lp_vault_redemption_payables payables ON payables.accounting_event_id=share_events.accounting_event_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'lotId',burns.lot_id::text,
        'burnedShareUnits',burns.burned_share_units::text,
        'allocatedCostBasisMicroUnits',burns.allocated_cost_basis_micro_units::text,
        'priorCumulativeBurnedShareUnits',burns.prior_cumulative_burned_share_units::text,
        'cumulativeBurnedShareUnits',burns.cumulative_burned_share_units::text,
        'priorCumulativeAllocatedBasisMicroUnits',burns.prior_cumulative_allocated_basis_micro_units::text,
        'cumulativeAllocatedBasisMicroUnits',burns.cumulative_allocated_basis_micro_units::text
      ) ORDER BY burned_lots.opened_at,burned_lots.id) AS items
      FROM lp_vault_share_lot_burn_allocations burns
      JOIN lp_vault_share_lots burned_lots ON burned_lots.id=burns.lot_id
      WHERE burns.burn_share_event_id=share_events.id
    ) allocations ON true
    WHERE share_events.vault_id=$1
    ORDER BY accounting_events.book_version`,[vaultId]);
  if(shareEventProjection.rows.length!==shareEventCount
    ||shareEventProjection.rows.some(row=>!row.projection_matches))
    throw new Error("lp_vault_accounting_share_projection_mismatch");
  return {vaultId,eventCount:events.rows.length,firstBookVersion:1n,lastBookVersion:BigInt(events.rows.at(-1)!.book_version),
    lastEventHash:events.rows.at(-1)!.event_hash,lastClosedBookVersion:latestClosed.bookVersion,
    pendingTailEventCount:Number(BigInt(events.rows.length)-latestClosed.bookVersion),checkpointCount,shareEventCount,
    totalMintedShareUnits,totalBurnedShareUnits,replayedShareSupplyUnits,
    checkpointShareSupplyUnits:latestClosed.shareSupplyUnits,economicNavMicroUnits:latestClosed.economicNavMicroUnits,
    grossAssetsMicroUnits:latestClosed.grossAssetsMicroUnits,navDeductionsMicroUnits:latestClosed.navDeductionsMicroUnits};
}

async function loadVerifiedLpVaultOwnerAccountingFromSnapshot(
  vaultId:string,
  userId:string,
  queryable:LpVaultAccountingQueryable,
  options:{now?:Date;maxAgeMs?:number}={}
):Promise<VerifiedLpVaultOwnerAccounting>{
  requireUuid(vaultId,"vault_id");
  requireUuid(userId,"owner_user_id");
  const now=asCanonicalTime(options.now??new Date());
  const maxAgeMs=options.maxAgeMs??LP_VAULT_OWNER_ACCOUNTING_MAX_AGE_MS;
  if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0) throw new Error("invalid_lp_vault_owner_accounting_max_age");
  const accounting=await loadLatestVerifiedLpVaultAccounting(vaultId,queryable);
  if(!accounting) return {status:"unavailable",reason:"accounting_missing",vaultId,userId};
  const ageMs=now.getTime()-accounting.asOf.getTime();
  if(ageMs<0||ageMs>maxAgeMs){
    return {status:"unavailable",reason:"accounting_stale",vaultId,userId,asOf:accounting.asOf};
  }

  const replay=await replayLpVaultAccounting(vaultId,queryable);
  if(replay.lastClosedBookVersion!==accounting.bookVersion
    ||replay.replayedShareSupplyUnits!==accounting.activeShareUnits
    ||replay.economicNavMicroUnits!==accounting.economicNavMicroUnits
    ||replay.grossAssetsMicroUnits!==accounting.grossAssetsMicroUnits
    ||replay.navDeductionsMicroUnits!==accounting.grossAssetsMicroUnits-accounting.economicNavMicroUnits)
    throw new Error("lp_vault_owner_accounting_replay_mismatch");
  const pending=await queryable.query<{
    id:string;amount_micro_units:string;eligible_after_cutoff:string;created_at:Date;
  }>(`SELECT id,amount_micro_units::text,eligible_after_cutoff::text,created_at
    FROM lp_vault_pending_deposits
    WHERE vault_id=$1 AND user_id=$2 AND status='pending'
    ORDER BY created_at,id`,[vaultId,userId]);
  const position=await queryable.query<{
    id:string;active_share_units:string;remaining_cost_basis_micro_units:string;
  }>(`SELECT positions.id,
      COALESCE(shares.active_share_units,0)::text AS active_share_units,
      COALESCE(cost_basis.remaining_cost_basis_micro_units,0)::text AS remaining_cost_basis_micro_units
    FROM lp_vault_share_positions positions
    LEFT JOIN LATERAL (
      SELECT sum(CASE WHEN events.event_type='mint' THEN events.share_units ELSE -events.share_units END)
        AS active_share_units
      FROM lp_vault_share_events events WHERE events.position_id=positions.id
    ) shares ON true
    LEFT JOIN LATERAL (
      SELECT sum(lots.original_cost_basis_micro_units-COALESCE(latest.cumulative_allocated_basis_micro_units,0))
        AS remaining_cost_basis_micro_units
      FROM lp_vault_share_lots lots
      LEFT JOIN LATERAL (
        SELECT allocations.cumulative_allocated_basis_micro_units
        FROM lp_vault_share_lot_burn_allocations allocations WHERE allocations.lot_id=lots.id
        ORDER BY allocations.created_at DESC,allocations.id DESC LIMIT 1
      ) latest ON true
      WHERE lots.position_id=positions.id
    ) cost_basis ON true
    WHERE positions.vault_id=$1 AND positions.user_id=$2`,[vaultId,userId]);
  const withdrawals=await queryable.query<{
    id:string;status:LpVaultOwnerWithdrawal["status"];requested_share_units:string;requested_at:Date;
    redemption_starts_at:Date|null;redemption_ends_at:Date|null;finalized_at:Date|null;claimable_at:Date|null;
    matured_amount_micro_units:string|null;finalized_redemption_pnl_micro_units:string|null;
  }>(`SELECT requests.id,requests.status,requests.requested_share_units::text,requests.requested_at,
      requests.redemption_starts_at,requests.redemption_ends_at,requests.finalized_at,requests.claimable_at,
      payables.matured_amount_micro_units::text,payables.finalized_redemption_pnl_micro_units::text
    FROM lp_vault_redemption_requests requests
    JOIN lp_vault_share_positions positions ON positions.id=requests.position_id
    LEFT JOIN lp_vault_redemption_payables payables ON payables.redemption_request_id=requests.id
    WHERE requests.vault_id=$1 AND positions.user_id=$2
    ORDER BY requests.queue_sequence`,[vaultId,userId]);

  const positionRow=position.rows[0];
  const activeShareUnits=BigInt(positionRow?.active_share_units??"0");
  const remainingCostBasisMicroUnits=BigInt(positionRow?.remaining_cost_basis_micro_units??"0");
  if(activeShareUnits<0n||remainingCostBasisMicroUnits<0n||activeShareUnits>accounting.activeShareUnits)
    throw new Error("lp_vault_owner_projection_mismatch");
  const currentPositionValueMicroUnits=activeShareUnits===0n?0n:calculatePositionValueMicroUsdc(
    activeShareUnits,accounting.activeShareUnits,accounting.economicNavMicroUnits
  );
  const estimatedPnlMicroUnits=activeShareUnits===0n
    ?-remainingCostBasisMicroUnits
    :estimatePositionPnl({shareUnits:activeShareUnits,totalShareUnits:accounting.activeShareUnits,
      economicNavMicroUsdc:accounting.economicNavMicroUnits,costBasisMicroUsdc:remainingCostBasisMicroUnits}).estimatedPnlMicroUsdc;
  const ownerWithdrawals=withdrawals.rows.map((row):LpVaultOwnerWithdrawal=>{
    const requestedShareUnits=BigInt(row.requested_share_units);
    const finalizedValue=row.matured_amount_micro_units===null?undefined:BigInt(row.matured_amount_micro_units);
    const currentValueMicroUnits=row.status==="canceled"?undefined
      :finalizedValue??(requestedShareUnits===0n?0n:calculatePositionValueMicroUsdc(
        requestedShareUnits,accounting.activeShareUnits,accounting.economicNavMicroUnits
      ));
    return {requestId:row.id,status:row.status,requestedShareUnits,
      ...(currentValueMicroUnits===undefined?{}:{currentValueMicroUnits}),
      ...(row.finalized_redemption_pnl_micro_units===null?{}
        :{finalizedPnlMicroUnits:BigInt(row.finalized_redemption_pnl_micro_units)}),
      requestedAt:row.requested_at,...(row.redemption_starts_at?{redemptionStartsAt:row.redemption_starts_at}:{}),
      ...(row.redemption_ends_at?{redemptionEndsAt:row.redemption_ends_at}:{}),
      ...(row.finalized_at?{finalizedAt:row.finalized_at}:{}),...(row.claimable_at?{claimableAt:row.claimable_at}:{})};
  });
  return {status:"available",vaultId,userId,asOf:accounting.asOf,bookVersion:accounting.bookVersion,
    ...(positionRow?{positionId:positionRow.id}:{}),
    pendingDeposits:pending.rows.map(row=>({depositId:row.id,amountMicroUnits:BigInt(row.amount_micro_units),
      eligibleAfterCutoff:row.eligible_after_cutoff,createdAt:row.created_at})),activeShareUnits,
    remainingCostBasisMicroUnits,currentPositionValueMicroUnits,estimatedPnlMicroUnits,
    finalizedRedemptionPnlMicroUnits:ownerWithdrawals.reduce((sum,item)=>sum+(item.finalizedPnlMicroUnits??0n),0n),
    withdrawals:ownerWithdrawals};
}

export async function loadVerifiedLpVaultOwnerAccounting(
  vaultId:string,
  userId:string,
  queryable:pg.Pool=getPool(),
  options:{now?:Date;maxAgeMs?:number}={}
):Promise<VerifiedLpVaultOwnerAccounting>{
  const client=await queryable.connect();
  try{
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result=await loadVerifiedLpVaultOwnerAccountingFromSnapshot(vaultId,userId,client,options);
    await client.query("COMMIT");
    return result;
  }catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  }finally{
    client.release();
  }
}

export type RunDueLpVaultAccountingCycleResult = {
  status: "created" | "already_closed";
  vaultId: string;
  cycleId: string;
  cutoffDate: string;
  bookVersion: string;
};

export async function runDueLpVaultAccountingCycle(
  options: { queryable?: pg.Pool } = {}
): Promise<RunDueLpVaultAccountingCycleResult> {
  const pool = options.queryable ?? getPool();
  const target = await pool.query<{ vault_id: string; cutoff_date: string; reconciliation_id: string }>(
    `SELECT vaults.id AS vault_id,due.cutoff_date::text,
       CASE WHEN closed.cutoff_date=due.cutoff_date THEN closed.reconciliation_id ELSE reconciliation.id END AS reconciliation_id
     FROM lp_vaults vaults
     LEFT JOIN LATERAL (
       SELECT cycles.cutoff_date,checkpoints.source_reconciliation_snapshot_id AS reconciliation_id
       FROM lp_vault_daily_cycles cycles
       JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.cycle_id=cycles.id
       WHERE cycles.vault_id=vaults.id AND cycles.status='closed'
       ORDER BY cycles.cutoff_date DESC LIMIT 1
     ) closed ON true
     JOIN LATERAL (
       SELECT CASE
         WHEN closed.cutoff_date IS NULL THEN (now() AT TIME ZONE 'UTC')::date
         WHEN closed.cutoff_date < (now() AT TIME ZONE 'UTC')::date THEN closed.cutoff_date + 1
         ELSE closed.cutoff_date
       END AS cutoff_date
     ) due ON due.cutoff_date <= (now() AT TIME ZONE 'UTC')::date
     JOIN LATERAL (
       SELECT id FROM financial_reconciliation_snapshots snapshots
       WHERE snapshots.source='worker' AND snapshots.unexplained_delta_micro_units=0
         AND snapshots.chain_id=vaults.chain_id AND snapshots.currency=vaults.currency
         AND lower(snapshots.scope_treasury_address)=lower(vaults.treasury_address)
         AND lower(snapshots.scope_token_address)=lower(vaults.token_address)
         AND snapshots.observed_block_number IS NOT NULL AND snapshots.observed_block_hash IS NOT NULL
         AND COALESCE(snapshots.metrics->>'observedBlockTimestamp','') ~ '^[0-9]+$'
         AND to_timestamp((snapshots.metrics->>'observedBlockTimestamp')::double precision)
           >= (due.cutoff_date::timestamp AT TIME ZONE 'UTC')
         AND to_timestamp((snapshots.metrics->>'observedBlockTimestamp')::double precision)
           <= (due.cutoff_date::timestamp AT TIME ZONE 'UTC') + ($1::bigint * interval '1 millisecond')
         AND to_timestamp((snapshots.metrics->>'observedBlockTimestamp')::double precision) <= snapshots.created_at
         AND snapshots.created_at >= (due.cutoff_date::timestamp AT TIME ZONE 'UTC')
         AND snapshots.created_at <= (due.cutoff_date::timestamp AT TIME ZONE 'UTC')
           + ($1::bigint * interval '1 millisecond')
       ORDER BY (snapshots.metrics->>'observedBlockTimestamp')::NUMERIC ASC,snapshots.created_at ASC,snapshots.id ASC LIMIT 1
     ) reconciliation ON true
     WHERE vaults.mode='shadow' AND vaults.community_custody=false AND vaults.deposits_enabled=false
     LIMIT 1`, [ACCOUNTING_SOURCE_MAX_AGE_MS]
  );
  if (!target.rows[0]) throw new Error("lp_vault_due_cycle_source_unavailable");
  const { vault_id: vaultId, cutoff_date: cutoffDate, reconciliation_id: reconciliationId } = target.rows[0];
  return await runLpVaultAccountingTransaction(vaultId, async (client) => {
    const closed = await client.query<{ id: string; accounting_version: string }>(
      `SELECT cycles.id,closing_event.book_version::text AS accounting_version FROM lp_vault_daily_cycles cycles
       JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.cycle_id=cycles.id
       JOIN lp_vault_cycle_closing_states closing ON closing.checkpoint_id=checkpoints.id
       JOIN lp_vault_accounting_events closing_event ON closing_event.id=closing.accounting_event_id
       WHERE cycles.vault_id=$1 AND cycles.cutoff_date=$2::date AND cycles.status='closed'`, [vaultId, cutoffDate]
    );
    if (closed.rows[0]) return { status:"already_closed" as const,vaultId,cycleId:closed.rows[0].id,cutoffDate,
      bookVersion:closed.rows[0].accounting_version };
    const inception = await client.query<{ vault_id: string }>(
      `SELECT vault_id FROM lp_vault_accounting_inceptions WHERE vault_id=$1`, [vaultId]
    );
    if (!inception.rows[0]) await inceptLpVaultAccounting(client,{vaultId,reconciliationId});
    const cycle=await openOrGetLpVaultCycle(client,{vaultId,cutoffDate});
    const reconciliation=await client.query<{created_at:Date}>(`SELECT created_at FROM financial_reconciliation_snapshots WHERE id=$1`,[reconciliationId]);
    if(!reconciliation.rows[0]) throw new Error("lp_vault_reconciliation_missing");
    const tickets=await loadUnresolvedLpVaultTicketsAsOf(client,reconciliation.rows[0].created_at);
    const accounting=await closeLpVaultAccountingCycle(client,{vaultId,cycleId:cycle.id,reconciliationId,
      sourceMaxAgeMs:ACCOUNTING_SOURCE_MAX_AGE_MS,ticketMarks:tickets.map(ticket=>({ticketId:ticket.ticket_id,
        markedLiabilityMicroUnits:BigInt(ticket.offered_payout_micro_units),markSource:"gross_payout_fallback" as const,
        fallbackReason:"reliable unresolved-ticket mark unavailable",evidenceTime:reconciliation.rows[0].created_at}))});
    return {status:"created" as const,vaultId,cycleId:cycle.id,cutoffDate,bookVersion:accounting.bookVersion.toString()};
  },pool);
}
