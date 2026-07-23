import type pg from "pg";
import { randomUUID } from "node:crypto";
import { getPool } from "./client";

export const REQUIRED_FINANCIAL_WORKERS = ["usdc-deposit-scanner", "financial-reconciliation", "settlement-worker"] as const;
export const REQUIRED_RUNTIME_WORKERS = ["market-worker", ...REQUIRED_FINANCIAL_WORKERS] as const;

const MAX_FAILURE_MESSAGE_LENGTH = 512;
const WORKER_INSTANCE_ID = randomUUID();
let workerInstanceGenerationPromise: Promise<bigint> | undefined;

function validateWorkerName(name: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error("invalid_worker_name");
  return name;
}

function validateWorkerInstanceId(instanceId: string) {
  const value = instanceId.trim();
  if (!value || value.length > 128) throw new Error("invalid_worker_instance_id");
  return value;
}

function validateWorkerInstanceGeneration(generation: string | number | bigint) {
  let value: bigint;
  try {
    value = BigInt(generation);
  } catch {
    throw new Error("invalid_worker_instance_generation");
  }
  if (value <= 0n) throw new Error("invalid_worker_instance_generation");
  return value;
}

async function resolveWorkerInstanceGeneration(input?: string | number | bigint) {
  if (input !== undefined) return validateWorkerInstanceGeneration(input);
  const allocation =
    workerInstanceGenerationPromise ??=
      getPool()
        .query<{ generation: string }>(
          "SELECT nextval('worker_runtime_instance_generation_seq')::text AS generation"
        )
        .then((result) => validateWorkerInstanceGeneration(result.rows[0]?.generation || "0"));
  try {
    return await allocation;
  } catch (error) {
    if (workerInstanceGenerationPromise === allocation) workerInstanceGenerationPromise = undefined;
    throw error;
  }
}

export function sanitizeWorkerFailure(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "worker_cycle_failed";
  const redacted = message
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/(authorization|api[_-]?key|token|secret|password|signature)\s*([=:])\s*(?:bearer\s+)?([^\s,;]+)/gi, "$1$2[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return (redacted || "worker_cycle_failed").slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function validateHeartbeatTime(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_worker_heartbeat_time");
  return now;
}

export async function recordWorkerHeartbeat(
  workerName: string,
  input: {
    now?: Date;
    processId?: number;
    instanceId?: string;
    instanceGeneration?: string | number | bigint;
    metadata?: Record<string, unknown>;
  } = {}
) {
  const name = validateWorkerName(workerName);
  const heartbeatAt = validateHeartbeatTime(input.now || new Date());
  const instanceId = validateWorkerInstanceId(input.instanceId ?? WORKER_INSTANCE_ID);
  const instanceGeneration = await resolveWorkerInstanceGeneration(input.instanceGeneration);

  await getPool().query(
    `
      INSERT INTO worker_runtime_heartbeats (
        worker_name, heartbeat_at, process_id, instance_id, instance_generation, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (worker_name)
      DO UPDATE SET
        heartbeat_at = EXCLUDED.heartbeat_at,
        last_success_at = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
          THEN NULL
          ELSE worker_runtime_heartbeats.last_success_at
        END,
        last_failure_at = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
          THEN NULL
          ELSE worker_runtime_heartbeats.last_failure_at
        END,
        latest_failure = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
          THEN NULL
          ELSE worker_runtime_heartbeats.latest_failure
        END,
        process_id = EXCLUDED.process_id,
        instance_id = EXCLUDED.instance_id,
        instance_generation = EXCLUDED.instance_generation,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      WHERE worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
        OR (
          worker_runtime_heartbeats.instance_generation = EXCLUDED.instance_generation
          AND worker_runtime_heartbeats.instance_id = EXCLUDED.instance_id
          AND worker_runtime_heartbeats.heartbeat_at <= EXCLUDED.heartbeat_at
        )
    `,
    [
      name,
      heartbeatAt.toISOString(),
      input.processId ?? process.pid,
      instanceId,
      instanceGeneration.toString(),
      input.metadata || {}
    ]
  );
}

export async function markWorkerSuccess(
  workerName: string,
  input: {
    now?: Date;
    processId?: number;
    instanceId?: string;
    instanceGeneration?: string | number | bigint;
  } = {}
) {
  const name = validateWorkerName(workerName);
  const completedAt = validateHeartbeatTime(input.now || new Date());
  const instanceId = validateWorkerInstanceId(input.instanceId ?? WORKER_INSTANCE_ID);
  const instanceGeneration = await resolveWorkerInstanceGeneration(input.instanceGeneration);

  await getPool().query(
    `
      INSERT INTO worker_runtime_heartbeats (
        worker_name, heartbeat_at, last_success_at, process_id, instance_id, instance_generation
      )
      VALUES ($1, $2, $2, $3, $4, $5)
      ON CONFLICT (worker_name)
      DO UPDATE SET
        heartbeat_at = GREATEST(worker_runtime_heartbeats.heartbeat_at, EXCLUDED.heartbeat_at),
        last_success_at = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
            OR worker_runtime_heartbeats.last_success_at IS NULL
            OR worker_runtime_heartbeats.last_success_at <= EXCLUDED.last_success_at
          THEN EXCLUDED.last_success_at
          ELSE worker_runtime_heartbeats.last_success_at
        END,
        last_failure_at = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
          THEN NULL
          ELSE worker_runtime_heartbeats.last_failure_at
        END,
        latest_failure = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
          THEN NULL
          ELSE worker_runtime_heartbeats.latest_failure
        END,
        process_id = EXCLUDED.process_id,
        instance_id = EXCLUDED.instance_id,
        instance_generation = EXCLUDED.instance_generation,
        updated_at = now()
      WHERE worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
        OR (
          worker_runtime_heartbeats.instance_generation = EXCLUDED.instance_generation
          AND worker_runtime_heartbeats.instance_id = EXCLUDED.instance_id
          AND (
            worker_runtime_heartbeats.heartbeat_at <= EXCLUDED.heartbeat_at
            OR worker_runtime_heartbeats.last_success_at IS NULL
            OR worker_runtime_heartbeats.last_success_at <= EXCLUDED.last_success_at
          )
        )
    `,
    [name, completedAt.toISOString(), input.processId ?? process.pid, instanceId, instanceGeneration.toString()]
  );
}

export async function markWorkerFailure(
  workerName: string,
  error: unknown,
  input: {
    now?: Date;
    processId?: number;
    instanceId?: string;
    instanceGeneration?: string | number | bigint;
  } = {}
) {
  const name = validateWorkerName(workerName);
  const failedAt = validateHeartbeatTime(input.now || new Date());
  const failure = sanitizeWorkerFailure(error);
  const instanceId = validateWorkerInstanceId(input.instanceId ?? WORKER_INSTANCE_ID);
  const instanceGeneration = await resolveWorkerInstanceGeneration(input.instanceGeneration);

  await getPool().query(
    `
      INSERT INTO worker_runtime_heartbeats (
        worker_name, heartbeat_at, last_failure_at, latest_failure, process_id, instance_id, instance_generation
      )
      VALUES ($1, $2, $2, $3, $4, $5, $6)
      ON CONFLICT (worker_name)
      DO UPDATE SET
        heartbeat_at = GREATEST(worker_runtime_heartbeats.heartbeat_at, EXCLUDED.heartbeat_at),
        last_success_at = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
          THEN NULL
          ELSE worker_runtime_heartbeats.last_success_at
        END,
        last_failure_at = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
            OR worker_runtime_heartbeats.last_failure_at IS NULL
            OR worker_runtime_heartbeats.last_failure_at <= EXCLUDED.last_failure_at
          THEN EXCLUDED.last_failure_at
          ELSE worker_runtime_heartbeats.last_failure_at
        END,
        latest_failure = CASE
          WHEN worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
            OR worker_runtime_heartbeats.last_failure_at IS NULL
            OR worker_runtime_heartbeats.last_failure_at <= EXCLUDED.last_failure_at
          THEN EXCLUDED.latest_failure
          ELSE worker_runtime_heartbeats.latest_failure
        END,
        process_id = EXCLUDED.process_id,
        instance_id = EXCLUDED.instance_id,
        instance_generation = EXCLUDED.instance_generation,
        updated_at = now()
      WHERE worker_runtime_heartbeats.instance_generation < EXCLUDED.instance_generation
        OR (
          worker_runtime_heartbeats.instance_generation = EXCLUDED.instance_generation
          AND worker_runtime_heartbeats.instance_id = EXCLUDED.instance_id
          AND (
            worker_runtime_heartbeats.heartbeat_at <= EXCLUDED.heartbeat_at
            OR worker_runtime_heartbeats.last_failure_at IS NULL
            OR worker_runtime_heartbeats.last_failure_at <= EXCLUDED.last_failure_at
          )
        )
    `,
    [
      name,
      failedAt.toISOString(),
      failure,
      input.processId ?? process.pid,
      instanceId,
      instanceGeneration.toString()
    ]
  );
}

export type WorkerHeartbeatHealth = {
  healthy: boolean;
  checkedAt: string;
  maxAgeMs: number;
  successMaxAgeMs: number;
  workers: Array<{
    name: string;
    status: "healthy" | "stale" | "failed" | "missing";
    heartbeatAt?: string;
    ageMs?: number;
    lastSuccessAt?: string;
    successAgeMs?: number;
    lastFailureAt?: string;
    failureAgeMs?: number;
    latestFailure?: string;
  }>;
};

type WorkerHeartbeatQueryable = pg.Pool | pg.PoolClient;

async function getWorkerHeartbeatHealthFromQueryable(
  queryable: WorkerHeartbeatQueryable,
  requiredWorkerNames: readonly string[],
  input: { now?: Date; maxAgeMs?: number; successMaxAgeMs?: number } = {}
): Promise<WorkerHeartbeatHealth> {
  const names = [...new Set(requiredWorkerNames.map(validateWorkerName))];
  const now = input.now || new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_worker_heartbeat_time");
  const maxAgeMs = input.maxAgeMs ?? 120_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("invalid_worker_heartbeat_max_age");
  const successMaxAgeMs = input.successMaxAgeMs ?? maxAgeMs;
  if (!Number.isFinite(successMaxAgeMs) || successMaxAgeMs <= 0) throw new Error("invalid_worker_success_max_age");

  const result = await queryable.query<{
    worker_name: string;
    heartbeat_at: Date;
    last_success_at: Date | null;
    last_failure_at: Date | null;
    latest_failure: string | null;
  }>(
    `
      SELECT worker_name, heartbeat_at, last_success_at, last_failure_at, latest_failure
      FROM worker_runtime_heartbeats
      WHERE worker_name = ANY($1::text[])
    `,
    [names]
  );
  const byName = new Map(result.rows.map((row) => [row.worker_name, row]));
  const workers = names.map((name) => {
    const worker = byName.get(name);
    if (!worker) return { name, status: "missing" as const };
    const ageMs = Math.max(0, now.getTime() - worker.heartbeat_at.getTime());
    const successAgeMs = worker.last_success_at ? Math.max(0, now.getTime() - worker.last_success_at.getTime()) : undefined;
    const failureAgeMs = worker.last_failure_at ? Math.max(0, now.getTime() - worker.last_failure_at.getTime()) : undefined;
    const processFresh = ageMs <= maxAgeMs;
    const successFresh = successAgeMs !== undefined && successAgeMs <= successMaxAgeMs;
    const failureNewerThanSuccess =
      Boolean(worker.last_failure_at) && (!worker.last_success_at || worker.last_failure_at!.getTime() > worker.last_success_at.getTime());
    const status: WorkerHeartbeatHealth["workers"][number]["status"] = failureNewerThanSuccess
      ? "failed"
      : processFresh && successFresh
        ? "healthy"
        : "stale";
    return {
      name,
      status,
      heartbeatAt: worker.heartbeat_at.toISOString(),
      ageMs,
      ...(worker.last_success_at ? { lastSuccessAt: worker.last_success_at.toISOString(), successAgeMs } : {}),
      ...(worker.last_failure_at ? { lastFailureAt: worker.last_failure_at.toISOString(), failureAgeMs } : {}),
      ...(worker.latest_failure ? { latestFailure: worker.latest_failure } : {})
    };
  });

  return {
    healthy: workers.every((worker) => worker.status === "healthy"),
    checkedAt: now.toISOString(),
    maxAgeMs,
    successMaxAgeMs,
    workers
  };
}

function assertHealthyWorkers(health: WorkerHeartbeatHealth) {
  if (!health.healthy) {
    const unavailable = health.workers.filter((worker) => worker.status !== "healthy").map((worker) => worker.name);
    throw new Error(`required_financial_workers_unhealthy:${unavailable.join(",")}`);
  }
  return health;
}

export async function getWorkerHeartbeatHealth(
  requiredWorkerNames: readonly string[],
  input: { now?: Date; maxAgeMs?: number; successMaxAgeMs?: number } = {}
) {
  return getWorkerHeartbeatHealthFromQueryable(getPool(), requiredWorkerNames, input);
}

export async function assertWorkerHeartbeatsHealthy(
  requiredWorkerNames: readonly string[],
  input: { now?: Date; maxAgeMs?: number; successMaxAgeMs?: number } = {}
) {
  return assertHealthyWorkers(await getWorkerHeartbeatHealth(requiredWorkerNames, input));
}

export async function assertWorkerHeartbeatsHealthyInTransaction(
  client: pg.PoolClient,
  requiredWorkerNames: readonly string[],
  input: { now?: Date; maxAgeMs?: number; successMaxAgeMs?: number } = {}
) {
  await client.query("SAVEPOINT worker_heartbeat_transaction_guard");
  await client.query("RELEASE SAVEPOINT worker_heartbeat_transaction_guard");
  return assertHealthyWorkers(await getWorkerHeartbeatHealthFromQueryable(client, requiredWorkerNames, input));
}

export async function assertFinancialWorkersHealthy(
  input: { now?: Date; maxAgeMs?: number; successMaxAgeMs?: number } = {}
) {
  return assertWorkerHeartbeatsHealthy(REQUIRED_FINANCIAL_WORKERS, input);
}
