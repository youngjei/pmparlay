import { getPool } from "./client";

export type IdempotencyReservation =
  | { kind: "reserved" }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "processing" }
  | { kind: "conflict" };

type ReserveInput = {
  route: string;
  key: string;
  userScope?: string;
  requestHash: string;
  ttlSeconds?: number;
};

type CompleteInput = {
  route: string;
  key: string;
  userScope?: string;
  responseStatus: number;
  responseBody: unknown;
};

const defaultUserScope = "anonymous";

export async function reserveIdempotencyKey(input: ReserveInput): Promise<IdempotencyReservation> {
  const userScope = input.userScope || defaultUserScope;
  const ttlSeconds = input.ttlSeconds || 24 * 60 * 60;
  const pool = getPool();

  const inserted = await pool.query(
    `
      INSERT INTO idempotency_keys (
        route,
        idempotency_key,
        user_scope,
        request_hash,
        status,
        expires_at
      )
      VALUES ($1, $2, $3, $4, 'processing', now() + ($5::text || ' seconds')::interval)
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [input.route, input.key, userScope, input.requestHash, ttlSeconds]
  );

  if (inserted.rows[0]) {
    return { kind: "reserved" };
  }

  const existing = await pool.query<{
    request_hash: string;
    status: "processing" | "completed";
    response_status: number | null;
    response_body: unknown | null;
    expired: boolean;
  }>(
    `
      SELECT
        request_hash,
        status,
        response_status,
        response_body,
        expires_at <= now() AS expired
      FROM idempotency_keys
      WHERE route = $1
        AND idempotency_key = $2
        AND user_scope = $3
      LIMIT 1
    `,
    [input.route, input.key, userScope]
  );

  const record = existing.rows[0];
  if (!record) {
    return { kind: "processing" };
  }

  if (record.request_hash !== input.requestHash) {
    return { kind: "conflict" };
  }

  if (record.status === "completed" && record.response_status && record.response_body) {
    return {
      kind: "replay",
      responseStatus: record.response_status,
      responseBody: record.response_body
    };
  }

  if (record.status === "processing") {
    const reclaimed = await pool.query(
      `
        UPDATE idempotency_keys
        SET updated_at = now()
        WHERE route = $1
          AND idempotency_key = $2
          AND user_scope = $3
          AND request_hash = $4
          AND status = 'processing'
          AND updated_at <= now() - interval '5 minutes'
        RETURNING id
      `,
      [input.route, input.key, userScope, input.requestHash]
    );

    if (reclaimed.rows[0]) {
      return { kind: "reserved" };
    }
  }

  if (record.expired) {
    const refreshed = await pool.query(
      `
        UPDATE idempotency_keys
        SET
          status = 'processing',
          response_status = NULL,
          response_body = NULL,
          updated_at = now(),
          expires_at = now() + ($4::text || ' seconds')::interval
        WHERE route = $1
          AND idempotency_key = $2
          AND user_scope = $3
          AND expires_at <= now()
        RETURNING id
      `,
      [input.route, input.key, userScope, ttlSeconds]
    );

    if (refreshed.rows[0]) {
      return { kind: "reserved" };
    }
  }

  return { kind: "processing" };
}

export async function completeIdempotencyKey(input: CompleteInput) {
  await getPool().query(
    `
      UPDATE idempotency_keys
      SET
        status = 'completed',
        response_status = $4,
        response_body = $5,
        updated_at = now()
      WHERE route = $1
        AND idempotency_key = $2
        AND user_scope = $3
    `,
    [input.route, input.key, input.userScope || defaultUserScope, input.responseStatus, input.responseBody]
  );
}
