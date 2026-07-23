import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { describe, expect, it, type TestContext } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");

async function withDisposableSchema(context: TestContext, run: (client: pg.Client) => Promise<void>) {
  if (!testDatabaseUrl) {
    context.skip();
    return;
  }
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  try {
    await client.connect();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      context.skip();
      return;
    }
    throw error;
  }

  const schema = `house_funding_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    for (const migration of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
    }
    await run(client);
  } finally {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

postgresDescribe("0033 house funding evidence PostgreSQL integration", () => {
  it("enforces one immutable evidence record for each canonical transfer log", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const evidence = [
        randomUUID(),
        11155111,
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        7,
        100,
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "0x1234567890abcdef1234567890abcdef12345678",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
        "9007199254740993",
        12,
        randomUUID(),
        "operator-a",
        "operator-b",
        "reviewed Sepolia funding",
        { status: "0x1" }
      ];
      const insert = `
        INSERT INTO house_funding_evidence (
          id, chain_id, tx_hash, log_index, block_number, block_hash, from_address, to_address, token_address,
          amount_micro_units, confirmations, ledger_transaction_id, operator_id, approver_id, reason, receipt
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `;
      await client.query("BEGIN");
      try {
        await client.query(insert, evidence);
        await client.query(
          `
            INSERT INTO onchain_transfer_claims (
              chain_id, tx_hash, log_index, claim_type, house_funding_evidence_id
            )
            VALUES ($1, $2, $3, 'house_funding', $4)
          `,
          [evidence[1], evidence[2], evidence[3], evidence[0]]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      await expect(client.query(insert, [...evidence.slice(0, 11), randomUUID(), ...evidence.slice(12)])).rejects.toThrow();
      await expect(
        client.query(
          "UPDATE onchain_transfer_claims SET claim_type = 'user_deposit' WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3",
          [evidence[1], evidence[2], evidence[3]]
        )
      ).rejects.toThrow("onchain_transfer_claims_is_append_only");
      await expect(client.query("UPDATE house_funding_evidence SET reason = 'mutated' WHERE id = $1", [evidence[0]])).rejects.toThrow(
        "house_funding_evidence_is_append_only"
      );

      const selfTransfer = [...evidence];
      selfTransfer[0] = randomUUID();
      selfTransfer[2] = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      selfTransfer[3] = 8;
      selfTransfer[6] = selfTransfer[7];
      selfTransfer[11] = randomUUID();
      await expect(client.query(insert, selfTransfer)).rejects.toThrow();
    });
  });
});
