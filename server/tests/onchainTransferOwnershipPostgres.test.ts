import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { config } from "../config";
import { closePool } from "../db/client";
import { creditConfirmedDeposit } from "../db/depositRepository";
import { recordVerifiedHouseFunding } from "../db/houseFundingRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const originalDatabaseUrl = config.DATABASE_URL;
const chainId = 11155111;
const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const blockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const sourceAddress = "0x1234567890abcdef1234567890abcdef12345678";
const safeAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const usdcAddress = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

function databaseUrlForSchema(schema: string) {
  const url = new URL(testDatabaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function withDisposableSchema(context: TestContext, run: (client: pg.Client) => Promise<void>) {
  if (!testDatabaseUrl) {
    context.skip();
    return;
  }
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  const schema = `transfer_owner_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    for (const migration of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
    }
    await closePool();
    config.DATABASE_URL = databaseUrlForSchema(schema);
    await run(client);
  } finally {
    await closePool();
    config.DATABASE_URL = originalDatabaseUrl;
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

function depositInput() {
  return {
    chainId,
    txHash,
    logIndex: 7,
    blockNumber: 100n,
    blockHash,
    fromAddress: sourceAddress,
    toAddress: safeAddress,
    tokenAddress: usdcAddress,
    amountMicroUnits: 5_000_000n,
    confirmations: 12,
    raw: { status: "0x1" }
  };
}

function houseFundingInput() {
  return {
    ...depositInput(),
    receipt: { transactionHash: txHash },
    operatorId: "operator-a",
    approverId: "operator-b",
    reason: "Supervised Sepolia funding review"
  };
}

async function seedUserWallet(client: pg.Client) {
  const userId = randomUUID();
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  await client.query(
    "INSERT INTO user_wallets (user_id, address, chain_id, active) VALUES ($1, $2, $3, true)",
    [userId, sourceAddress, chainId]
  );
  return userId;
}

async function accountBalance(client: pg.Client, accountType: string, userId?: string) {
  const result = await client.query<{ balance: string }>(
    `
      SELECT COALESCE(sum(entries.amount_micro_units), 0)::text AS balance
      FROM ledger_accounts accounts
      LEFT JOIN ledger_entries entries ON entries.account_id = accounts.id
      WHERE accounts.account_type = $1
        AND accounts.currency = 'USDC'
        AND accounts.user_id IS NOT DISTINCT FROM $2::uuid
    `,
    [accountType, userId || null]
  );
  return BigInt(result.rows[0]?.balance || "0");
}

afterEach(async () => {
  await closePool();
  config.DATABASE_URL = originalDatabaseUrl;
});

postgresDescribe("onchain transfer ownership PostgreSQL integration", () => {
  it("prevents a user deposit from also becoming house funding", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const userId = await seedUserWallet(client);
      const deposit = await creditConfirmedDeposit(depositInput());
      expect(deposit.status).toBe("credited");

      await expect(recordVerifiedHouseFunding(houseFundingInput())).rejects.toThrow(
        "onchain_transfer_already_claimed:user_deposit"
      );
      expect(await accountBalance(client, "user_usdc_available", userId)).toBe(5_000_000n);
      expect(await accountBalance(client, "house_usdc_operating")).toBe(0n);
    });
  });

  it("lets house funding claim an ignored observation and permanently blocks later user credit", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const observation = await creditConfirmedDeposit(depositInput());
      expect(observation.status).toBe("ignored");

      await expect(recordVerifiedHouseFunding(houseFundingInput())).resolves.toMatchObject({
        amountMicroUnits: "5000000",
        idempotentReplay: false
      });
      const userId = await seedUserWallet(client);
      const replay = await creditConfirmedDeposit(depositInput());

      expect(replay.status).toBe("ignored");
      expect(await accountBalance(client, "user_usdc_available", userId)).toBe(0n);
      expect(await accountBalance(client, "house_usdc_operating")).toBe(5_000_000n);
      const claim = await client.query<{ claim_type: string }>(
        "SELECT claim_type FROM onchain_transfer_claims WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3",
        [chainId, txHash, 7]
      );
      expect(claim.rows[0]?.claim_type).toBe("house_funding");
    });
  });
});
