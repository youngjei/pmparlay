import { closePool, getPool } from "./client";

const tables = [
  "markets",
  "market_outcomes",
  "market_snapshots",
  "quotes",
  "quote_legs",
  "risk_checks",
  "idempotency_keys",
  "tickets",
  "ticket_reserves",
  "ledger_entries",
  "settlements",
  "outbox"
];

try {
  const counts: Record<string, number> = {};

  for (const table of tables) {
    const result = await getPool().query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    counts[table] = Number(result.rows[0].count);
  }

  console.log(JSON.stringify(counts, null, 2));
} finally {
  await closePool();
}
