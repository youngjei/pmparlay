import type pg from "pg";
import { getPool } from "./client";

export type OutboxMessage = {
  id: string;
  topic: string;
  payload: unknown;
  attempts: number;
  createdAt: string;
};

export async function claimOutboxBatch(limit = 10): Promise<OutboxMessage[]> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const selected = await client.query<{ id: string }>(
      `
        SELECT id
        FROM outbox
        WHERE (
            (status IN ('pending', 'failed') AND available_at <= now())
            OR (status = 'processing' AND locked_at <= now() - interval '5 minutes')
          )
          AND attempts < 10
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [limit]
    );

    if (selected.rows.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const result = await client.query<{
      id: string;
      topic: string;
      payload: unknown;
      attempts: number;
      created_at: Date;
    }>(
      `
        UPDATE outbox
        SET status = 'processing', attempts = attempts + 1, locked_at = now()
        WHERE id = ANY($1::uuid[])
        RETURNING id, topic, payload, attempts, created_at
      `,
      [selected.rows.map((row) => row.id)]
    );

    await client.query("COMMIT");

    return result.rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      payload: row.payload,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString()
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markOutboxSent(id: string) {
  await getPool().query("UPDATE outbox SET status = 'sent', locked_at = NULL WHERE id = $1", [id]);
}

export async function markOutboxFailed(id: string, delaySeconds = 60) {
  await getPool().query(
    `
      UPDATE outbox
      SET
        status = CASE WHEN attempts >= 10 THEN 'dead' ELSE 'failed' END,
        available_at = now() + ($2::text || ' seconds')::interval,
        locked_at = NULL
      WHERE id = $1
    `,
    [id, delaySeconds]
  );
}

export async function pendingOutboxCount(client: pg.Pool | pg.PoolClient = getPool()) {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM outbox WHERE status IN ('pending', 'failed', 'processing') AND attempts < 10"
  );
  return Number(result.rows[0].count);
}

export async function deadOutboxCount(client: pg.Pool | pg.PoolClient = getPool()) {
  const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox WHERE status = 'dead'");
  return Number(result.rows[0].count);
}
