import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { describe, expect, it, type TestContext } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const chainId = 11155111;
const blockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const sourceAddress = "0x1234567890abcdef1234567890abcdef12345678";
const safeAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const usdcAddress = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

function hash(character: string) {
  return `0x${character.repeat(64)}`;
}

async function withDisposableSchema(context: TestContext, run: (client: pg.Client) => Promise<void>) {
  if (!testDatabaseUrl) {
    context.skip();
    return;
  }

  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  const schema = `transfer_claim_constraints_${randomUUID().replaceAll("-", "")}`;
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
    await client.query("ROLLBACK");
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

async function seedCreditedDepositOwner(client: pg.Client) {
  const userId = randomUUID();
  const walletId = randomUUID();
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  await client.query(
    "INSERT INTO user_wallets (id, user_id, address, chain_id, active) VALUES ($1, $2, $3, $4, true)",
    [walletId, userId, sourceAddress, chainId]
  );
  return { userId, walletId };
}

async function insertCreditedDeposit(
  client: pg.Client,
  owner: { userId: string; walletId: string },
  id: string,
  txHash: string,
  logIndex: number
) {
  await client.query(
    `
      INSERT INTO onchain_deposits (
        id, chain_id, tx_hash, log_index, block_number, from_address, to_address, token_address,
        amount_micro_units, user_id, wallet_id, status, credited_transaction_id
      )
      VALUES ($1, $2, $3, $4, 100, $5, $6, $7, 5000000, $8, $9, 'credited', $10)
    `,
    [id, chainId, txHash, logIndex, sourceAddress, safeAddress, usdcAddress, owner.userId, owner.walletId, randomUUID()]
  );
}

async function insertHouseFundingEvidence(client: pg.Client, id: string, txHash: string, logIndex: number) {
  await client.query(
    `
      INSERT INTO house_funding_evidence (
        id, chain_id, tx_hash, log_index, block_number, block_hash, from_address, to_address, token_address,
        amount_micro_units, confirmations, ledger_transaction_id, operator_id, approver_id, reason, receipt
      )
      VALUES ($1, $2, $3, $4, 100, $5, $6, $7, $8, 5000000, 12, $9, 'operator-a', 'operator-b', 'reviewed funding', '{}')
    `,
    [id, chainId, txHash, logIndex, blockHash, sourceAddress, safeAddress, usdcAddress, randomUUID()]
  );
}

async function insertClaim(
  client: pg.Client,
  claimType: "user_deposit" | "house_funding",
  id: string,
  txHash: string,
  logIndex: number
) {
  const identityColumn = claimType === "user_deposit" ? "onchain_deposit_id" : "house_funding_evidence_id";
  await client.query(
    `
      INSERT INTO onchain_transfer_claims (chain_id, tx_hash, log_index, claim_type, ${identityColumn})
      VALUES ($1, $2, $3, $4, $5)
    `,
    [chainId, txHash, logIndex, claimType, id]
  );
}

postgresDescribe("0036 onchain transfer claim constraints PostgreSQL integration", () => {
  it("commits matching user-deposit and house-funding source and claim inserts in one transaction", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const owner = await seedCreditedDepositOwner(client);
      const depositId = randomUUID();
      const depositHash = hash("a");
      await client.query("BEGIN");
      await insertCreditedDeposit(client, owner, depositId, depositHash, 1);
      await insertClaim(client, "user_deposit", depositId, depositHash, 1);
      await client.query("COMMIT");

      const evidenceId = randomUUID();
      const fundingHash = hash("c");
      await client.query("BEGIN");
      await insertHouseFundingEvidence(client, evidenceId, fundingHash, 2);
      await insertClaim(client, "house_funding", evidenceId, fundingHash, 2);
      await client.query("COMMIT");
    });
  });

  it("rejects orphan credited deposits and house-funding evidence at commit", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const owner = await seedCreditedDepositOwner(client);
      await client.query("BEGIN");
      await insertCreditedDeposit(client, owner, randomUUID(), hash("d"), 3);
      await expect(client.query("COMMIT")).rejects.toThrow("onchain_transfer_claim_missing_user_deposit_claim");
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await insertHouseFundingEvidence(client, randomUUID(), hash("e"), 4);
      await expect(client.query("COMMIT")).rejects.toThrow("onchain_transfer_claim_missing_house_funding_claim");
      await client.query("ROLLBACK");
    });
  });
});
