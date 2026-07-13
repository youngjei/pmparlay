import { closePool, getPool } from "./client";

try {
  const quotes = await getPool().query(`
    SELECT id, status, created_at
    FROM quotes
    ORDER BY created_at DESC
    LIMIT 5
  `);
  const tickets = await getPool().query(`
    SELECT id, quote_id, status, created_at
    FROM tickets
    ORDER BY created_at DESC
    LIMIT 5
  `);

  console.log(
    JSON.stringify(
      {
        quotes: quotes.rows,
        tickets: tickets.rows
      },
      null,
      2
    )
  );
} finally {
  await closePool();
}
