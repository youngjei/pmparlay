import { closePool, getPool } from "./client";

async function deleteExpiredIdempotencyKeys() {
  const result = await getPool().query<{ count: string }>(
    `
      WITH deleted AS (
        DELETE FROM idempotency_keys
        WHERE expires_at <= now()
        RETURNING id
      )
      SELECT count(*)::text AS count
      FROM deleted
    `
  );

  return Number(result.rows[0].count);
}

async function expireStaleQuotes() {
  const result = await getPool().query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE quotes
        SET status = 'expired'
        WHERE status = 'quoted'
          AND expires_at <= now()
        RETURNING id
      )
      SELECT count(*)::text AS count
      FROM updated
    `
  );

  return Number(result.rows[0].count);
}

async function expireStalePaymentIntents() {
  const result = await getPool().query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE quote_payment_intents
        SET status = 'expired', updated_at = now()
        WHERE status IN ('pending', 'submitted')
          AND expires_at <= now()
        RETURNING id
      )
      SELECT count(*)::text AS count
      FROM updated
    `
  );

  return Number(result.rows[0].count);
}

try {
  const expiredIdempotencyKeys = await deleteExpiredIdempotencyKeys();
  const expiredQuotes = await expireStaleQuotes();
  const expiredPaymentIntents = await expireStalePaymentIntents();

  console.log(
    JSON.stringify(
      {
        expiredIdempotencyKeys,
        expiredQuotes,
        expiredPaymentIntents
      },
      null,
      2
    )
  );
} finally {
  await closePool();
}
