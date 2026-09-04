import type pg from "pg";
import { getPool } from "./db/client";

export type ReconciliationGate = {
  launchGate: "ready" | "blocked";
  operationGate: "open" | "restricted" | "blocked";
  reasons: string[];
};

export type FinancialControlGate = {
  scope: "global";
  operationGate: "restricted" | "blocked";
  reason: string;
  incidentId?: string;
  metadata: Record<string, unknown>;
  setAt: string;
};

export type FinancialGateSnapshotInput = {
  id: string;
  source?: "worker" | "legacy";
  launchGate: "ready" | "blocked";
  operationGate: "open" | "restricted" | "blocked";
  gateReasons: string[];
  createdAt: string;
  observedBlockNumber?: string;
  observedBlockHash?: string;
  scopeTreasuryAddress?: string;
  scopeTokenAddress?: string;
};

export type FinancialGateDecision = {
  allowed: boolean;
  launchGate: "ready" | "blocked";
  operationGate: "open" | "restricted" | "blocked";
  reasons: string[];
  snapshotId?: string;
  snapshotAgeMs?: number;
  maxSnapshotAgeMs: number;
  controlGate?: FinancialControlGate;
};

export const defaultFinancialGateMaxSnapshotAgeMs = 5 * 60_000;
export const financialControlLockName = "financial-control-gate:global";

async function assertExistingTransaction(client: pg.PoolClient) {
  await client.query("SAVEPOINT financial_gate_transaction_guard");
  await client.query("RELEASE SAVEPOINT financial_gate_transaction_guard");
}

export async function lockFinancialControlGateForMoney(client: pg.PoolClient) {
  await assertExistingTransaction(client);
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [financialControlLockName]);
}

export async function lockFinancialControlGateForMutation(client: pg.PoolClient) {
  await assertExistingTransaction(client);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [financialControlLockName]);
}

function abs(value: bigint) {
  return value < 0n ? -value : value;
}

function strongestOperationGate(values: Array<"open" | "restricted" | "blocked">) {
  if (values.includes("blocked")) return "blocked";
  if (values.includes("restricted")) return "restricted";
  return "open";
}

export function evaluateReconciliationGate(input: {
  unexplainedDeltaMicroUnits: bigint;
  houseEquityMicroUnits: bigint;
  pendingWithdrawalMicroUnits: bigint;
  pendingWithdrawalLedgerMicroUnits: bigint;
  driftToleranceMicroUnits?: bigint;
  operationWarnToleranceMicroUnits?: bigint;
}): ReconciliationGate {
  const driftTolerance = input.driftToleranceMicroUnits ?? 0n;
  const operationWarnTolerance = input.operationWarnToleranceMicroUnits ?? 10_000_000n;
  const drift = abs(input.unexplainedDeltaMicroUnits);
  const reasons: string[] = [];

  if (drift > driftTolerance) reasons.push("treasury_internal_delta");
  if (input.houseEquityMicroUnits < 0n) reasons.push("negative_house_equity");
  if (input.pendingWithdrawalMicroUnits !== input.pendingWithdrawalLedgerMicroUnits) reasons.push("pending_withdrawal_ledger_mismatch");

  const launchGate = reasons.length === 0 ? "ready" : "blocked";
  let operationGate: ReconciliationGate["operationGate"] = "open";
  if (input.houseEquityMicroUnits < 0n || drift > operationWarnTolerance) {
    operationGate = "blocked";
  } else if (reasons.length > 0) {
    operationGate = "restricted";
  }

  return {
    launchGate,
    operationGate,
    reasons
  };
}

export function evaluateFreshCanonicalReconciliationGate(input: {
  snapshot?: FinancialGateSnapshotInput;
  controlGate?: FinancialControlGate;
  now?: Date;
  maxSnapshotAgeMs?: number;
}): FinancialGateDecision {
  const maxSnapshotAgeMs = input.maxSnapshotAgeMs ?? defaultFinancialGateMaxSnapshotAgeMs;
  const reasons: string[] = [];
  const now = input.now ?? new Date();

  if (!input.snapshot) {
    reasons.push("reconciliation_snapshot_absent");
    if (input.controlGate) reasons.push(`financial_gate_${input.controlGate.operationGate}:${input.controlGate.reason}`);
    return {
      allowed: false,
      launchGate: "blocked",
      operationGate: strongestOperationGate(["blocked", input.controlGate?.operationGate || "open"]),
      reasons,
      maxSnapshotAgeMs,
      controlGate: input.controlGate
    };
  }

  const snapshotCreatedAt = Date.parse(input.snapshot.createdAt);
  const snapshotAgeMs = Number.isFinite(snapshotCreatedAt) ? now.getTime() - snapshotCreatedAt : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(snapshotAgeMs) || snapshotAgeMs < 0 || snapshotAgeMs > maxSnapshotAgeMs) {
    reasons.push("reconciliation_snapshot_stale");
  }
  if (!input.snapshot.observedBlockNumber || !input.snapshot.observedBlockHash) {
    reasons.push("reconciliation_snapshot_unverified_block");
  }
  if (
    input.snapshot.source !== "worker" ||
    !input.snapshot.scopeTreasuryAddress ||
    !input.snapshot.scopeTokenAddress
  ) {
    reasons.push("reconciliation_snapshot_untrusted_provenance");
  }
  if (input.snapshot.launchGate !== "ready") {
    const launchReasons = input.snapshot.gateReasons.map((reason) => `launch:${reason}`);
    reasons.push(...(launchReasons.length > 0 ? launchReasons : ["launch_gate_blocked"]));
  }
  if (input.snapshot.operationGate !== "open") {
    const operationReasons = input.snapshot.gateReasons.map((reason) => `operation:${reason}`);
    reasons.push(...(operationReasons.length > 0 ? operationReasons : [`operation_gate_${input.snapshot.operationGate}`]));
  }
  if (input.controlGate) {
    reasons.push(`financial_gate_${input.controlGate.operationGate}:${input.controlGate.reason}`);
  }

  const launchGate = reasons.length === 0 && input.snapshot.launchGate === "ready" ? "ready" : "blocked";
  const operationGate = strongestOperationGate([
    input.snapshot.operationGate,
    reasons.includes("reconciliation_snapshot_stale") ||
    reasons.includes("reconciliation_snapshot_unverified_block") ||
    reasons.includes("reconciliation_snapshot_untrusted_provenance")
      ? "blocked"
      : "open",
    input.controlGate?.operationGate || "open"
  ]);

  return {
    allowed: launchGate === "ready" && operationGate === "open",
    launchGate,
    operationGate,
    reasons,
    snapshotId: input.snapshot.id,
    snapshotAgeMs,
    maxSnapshotAgeMs,
    controlGate: input.controlGate
  };
}

export async function setFinancialControlGate(
  client: pg.PoolClient,
  input: {
    operationGate: "restricted" | "blocked";
    reason: string;
    incidentId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  await lockFinancialControlGateForMutation(client);
  await client.query(
    `
      INSERT INTO financial_control_gates (
        scope,
        operation_gate,
        reason,
        incident_id,
        metadata,
        set_at,
        cleared_at
      )
      VALUES ('global', $1, $2, $3, $4, now(), NULL)
      ON CONFLICT (scope)
      DO UPDATE SET
        operation_gate = EXCLUDED.operation_gate,
        reason = EXCLUDED.reason,
        incident_id = EXCLUDED.incident_id,
        metadata = EXCLUDED.metadata,
        set_at = now(),
        cleared_at = NULL
    `,
    [input.operationGate, input.reason, input.incidentId || null, input.metadata || {}]
  );
}

export async function getActiveFinancialControlGate(
  client?: Pick<pg.Pool | pg.PoolClient, "query">,
  options: { lock?: boolean } = {}
): Promise<FinancialControlGate | undefined> {
  const queryable = client || getPool();
  const result = await queryable.query<{
    scope: "global";
    operationGate: "restricted" | "blocked";
    reason: string;
    incidentId: string | null;
    metadata: Record<string, unknown>;
    setAt: Date;
  }>(
    `
      SELECT
        scope,
        operation_gate AS "operationGate",
        reason,
        incident_id AS "incidentId",
        metadata,
        set_at AS "setAt"
      FROM financial_control_gates
      WHERE scope = 'global'
        AND operation_gate IN ('restricted', 'blocked')
        AND cleared_at IS NULL
      LIMIT 1
      ${options.lock ? "FOR SHARE" : ""}
    `
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    scope: row.scope,
    operationGate: row.operationGate,
    reason: row.reason,
    incidentId: row.incidentId || undefined,
    metadata: row.metadata || {},
    setAt: row.setAt.toISOString()
  };
}

export async function getFinancialGateDecision(input: {
  latestSnapshot?: () => Promise<FinancialGateSnapshotInput | undefined>;
  maxSnapshotAgeMs?: number;
  now?: Date;
}): Promise<FinancialGateDecision> {
  const [{ getLatestReconciliationSnapshot }, controlGate] = await Promise.all([
    import("./db/reconciliationRepository"),
    getActiveFinancialControlGate()
  ]);
  const latestSnapshot = input.latestSnapshot || getLatestReconciliationSnapshot;
  return evaluateFreshCanonicalReconciliationGate({
    snapshot: await latestSnapshot(),
    controlGate,
    maxSnapshotAgeMs: input.maxSnapshotAgeMs,
    now: input.now
  });
}

export async function getFinancialGateDecisionInTransaction(
  client: pg.PoolClient,
  input: { maxSnapshotAgeMs?: number; now?: Date } = {}
): Promise<FinancialGateDecision> {
  await lockFinancialControlGateForMoney(client);
  const { getLatestReconciliationSnapshot } = await import("./db/reconciliationRepository");
  const controlGate = await getActiveFinancialControlGate(client, { lock: true });
  const snapshot = await getLatestReconciliationSnapshot(client);
  return evaluateFreshCanonicalReconciliationGate({
    snapshot,
    controlGate,
    maxSnapshotAgeMs: input.maxSnapshotAgeMs,
    now: input.now
  });
}

export async function assertFinancialGateOpenInTransaction(
  client: pg.PoolClient,
  input: { maxSnapshotAgeMs?: number; operation?: string; now?: Date } = {}
) {
  const decision = await getFinancialGateDecisionInTransaction(client, input);
  if (!decision.allowed) {
    const error = new Error(`financial_gate_closed:${decision.reasons.join(",")}`);
    Object.assign(error, {
      operation: input.operation,
      decision
    });
    throw error;
  }
  return decision;
}

export async function assertFinancialGateOpen(input: { maxSnapshotAgeMs?: number; operation?: string } = {}) {
  const decision = await getFinancialGateDecision({
    maxSnapshotAgeMs: input.maxSnapshotAgeMs
  });
  if (!decision.allowed) {
    const error = new Error(`financial_gate_closed:${decision.reasons.join(",")}`);
    Object.assign(error, {
      operation: input.operation,
      decision
    });
    throw error;
  }
  return decision;
}

export const financialGateIntegrationHooks = {
  module: "server/financialGate.ts",
  statusFunction: "getFinancialGateDecision",
  assertFunction: "assertFinancialGateOpen",
  transactionAssertFunction: "assertFinancialGateOpenInTransaction",
  setGateFunction: "setFinancialControlGate",
  lockProtocol: {
    order: "first-after-BEGIN",
    moneyTransactions: "shared transaction advisory lock",
    gateMutations: "exclusive transaction advisory lock",
    lockName: financialControlLockName
  }
} as const;
