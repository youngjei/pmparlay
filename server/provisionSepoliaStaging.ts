import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import Redis from "ioredis";
import pg from "pg";
import { getAddress } from "viem";
import { runSettlementIdentityBackfillCommand } from "./backfillSettlementIdentities";
import {
  CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS,
  SEPOLIA_PAYMENT_CHAIN_ID,
  SEPOLIA_REQUIRED_CONFIRMATIONS,
  config
} from "./config";
import { closePool } from "./db/client";
import { provisionFounderSepoliaShadowVault } from "./db/lpVaultRepository";
import { migrate } from "./db/migrate";

const stagingDatabaseName = "legwork_sepolia_staging";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingEnvironmentPath = path.join(repositoryRoot, ".context/sepolia-staging.env");
const stagingEnvironmentDirectory = path.dirname(stagingEnvironmentPath);
const financialTables = [
  "users",
  "quotes",
  "quote_payment_intents",
  "tickets",
  "ledger_entries",
  "onchain_deposits",
  "withdrawal_requests",
  "house_funding_evidence"
] as const;

export function assertSafeDatabaseName(value: string) {
  if (!/^legwork_sepolia(?:_[a-z0-9_]+)?$/.test(value)) throw new Error("unsafe_staging_database_name");
}

export function databaseUrlForName(source: string, databaseName: string) {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  url.hash = "";
  return url.toString();
}

export function redisUrlForStaging(source: string) {
  const url = new URL(source);
  url.pathname = "/1";
  return url.toString();
}

export function assertSafeLocalStagingRedisReset(source: string) {
  const url = new URL(source);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (!loopback || url.pathname !== "/1") throw new Error("unsafe_staging_redis_reset_target");
}

async function resetStagingRedis(source: string) {
  assertSafeLocalStagingRedisReset(source);
  const redis = new Redis(source, { lazyConnect: true, connectTimeout: 5_000, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

async function existingStagingEnvironment() {
  await assertSafeStagingEnvironmentPath();
  try {
    return parse(await readFile(stagingEnvironmentPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function assertSafeStagingEnvironmentPath() {
  await mkdir(stagingEnvironmentDirectory, { recursive: true, mode: 0o700 });
  const [directoryMetadata, resolvedDirectory] = await Promise.all([
    lstat(stagingEnvironmentDirectory),
    realpath(stagingEnvironmentDirectory)
  ]);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    resolvedDirectory !== stagingEnvironmentDirectory
  ) {
    throw new Error("unsafe_staging_environment_directory");
  }
  try {
    const metadata = await lstat(stagingEnvironmentPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("unsafe_staging_environment_file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function rpc<T>(url: string, method: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`sepolia_rpc_http_${response.status}`);
  const payload = (await response.json()) as { result?: T; error?: unknown };
  if (payload.error || payload.result === undefined) throw new Error("sepolia_rpc_invalid_response");
  return payload.result;
}

function quoted(value: string | number | boolean) {
  return JSON.stringify(String(value));
}

async function writeStagingEnvironment(input: {
  databaseUrl: string;
  depositStartBlock: bigint;
  existing: Record<string, string>;
}) {
  const required = {
    TREASURY_SAFE_ADDRESS: process.env.TREASURY_SAFE_ADDRESS,
    ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL,
    PRIVY_APP_ID: process.env.PRIVY_APP_ID
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new Error(`${name}_required_for_staging`);
  }
  const expectedSafeOwner = process.env.STAGING_EXPECTED_SAFE_OWNER || input.existing.STAGING_EXPECTED_SAFE_OWNER;
  if (!expectedSafeOwner) throw new Error("STAGING_EXPECTED_SAFE_OWNER_required_for_staging");

  const values: Record<string, string | number | boolean> = {
    NODE_ENV: "production",
    API_HOST: "127.0.0.1",
    API_PORT: 8790,
    WEB_ORIGIN: "http://localhost:5174",
    DATABASE_URL: input.databaseUrl,
    REDIS_URL: redisUrlForStaging(process.env.REDIS_URL || "redis://127.0.0.1:6379"),
    RATE_LIMIT_BACKEND: "redis",
    RATE_LIMIT_SKIP_ON_REDIS_ERROR: false,
    ACCOUNTING_MODE: "house_book_usdc",
    LEDGER_CURRENCY: "USDC",
    SETTLEMENT_CHAIN_ID: SEPOLIA_PAYMENT_CHAIN_ID,
    SETTLEMENT_AUTHORITY: "polymarket_api",
    SETTLEMENT_API_STABILITY_MS: 120_000,
    TREASURY_SAFE_ADDRESS: getAddress(required.TREASURY_SAFE_ADDRESS!),
    STAGING_EXPECTED_SAFE_OWNER: getAddress(expectedSafeOwner),
    USDC_CONTRACT_ADDRESS: CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS,
    USDC_REQUIRED_CONFIRMATIONS: SEPOLIA_REQUIRED_CONFIRMATIONS,
    USDC_DEPOSIT_START_BLOCK: input.depositStartBlock.toString(),
    ETHEREUM_RPC_URL: required.ETHEREUM_RPC_URL!,
    PRIVY_APP_ID: required.PRIVY_APP_ID!,
    PRIVY_JWKS_URL:
      process.env.PRIVY_JWKS_URL || `https://auth.privy.io/api/v1/apps/${required.PRIVY_APP_ID}/jwks.json`,
    OPS_API_KEY: process.env.OPS_API_KEY || input.existing.OPS_API_KEY || randomBytes(32).toString("hex"),
    MARKET_INDEX_MAX_PAGES: 1,
    MARKET_INDEX_INTERVAL_MS: 60_000,
    MARKET_INDEX_DB_SOFT_LIMIT_BYTES: 350_000_000,
    WORKER_HEARTBEAT_MAX_AGE_MS: 45_000,
    WORKER_SUCCESS_MAX_AGE_MS: 180_000
  };
  const body = `${Object.entries(values)
    .map(([name, value]) => `${name}=${quoted(value)}`)
    .join("\n")}\n`;
  await assertSafeStagingEnvironmentPath();
  const temporaryPath = `${stagingEnvironmentPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, body, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await assertSafeStagingEnvironmentPath();
    await rename(temporaryPath, stagingEnvironmentPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function assertResetRecoveryPoint(reset: boolean) {
  if (!reset) return;
  const configuredPath = process.env.STAGING_RESET_BACKUP_FILE;
  if (!configuredPath) throw new Error("STAGING_RESET_BACKUP_FILE_required");
  const configuredProofPath = process.env.STAGING_RESET_RESTORE_PROOF;
  if (!configuredProofPath) throw new Error("STAGING_RESET_RESTORE_PROOF_required");
  const backupRoot = await realpath(path.resolve(".context/backups"));
  const backupPath = await realpath(path.resolve(configuredPath));
  const proofPath = await realpath(path.resolve(configuredProofPath));
  const metadata = await stat(backupPath);
  const proofMetadata = await stat(proofPath);
  if (
    path.dirname(backupPath) !== backupRoot ||
    !path.basename(backupPath).startsWith(`${stagingDatabaseName}-`) ||
    !path.basename(backupPath).endsWith(".dump") ||
    !metadata.isFile() ||
    metadata.size === 0 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("invalid_staging_reset_backup");
  }
  if (proofPath !== `${backupPath}.restore-verified` || !proofMetadata.isFile() || (proofMetadata.mode & 0o077) !== 0) {
    throw new Error("invalid_staging_reset_restore_proof");
  }
  const archiveHash = createHash("sha256").update(await readFile(backupPath)).digest("hex");
  if ((await readFile(proofPath, "utf8")) !== resetRecoveryProof(stagingDatabaseName, archiveHash)) {
    throw new Error("staging_reset_restore_proof_mismatch");
  }
}

export function resetRecoveryProof(databaseName: string, archiveHash: string) {
  return `${databaseName}:${archiveHash}\n`;
}

async function createOrResetDatabase(adminUrl: string, reset: boolean) {
  assertSafeDatabaseName(stagingDatabaseName);
  assertResetConfirmed(reset, stagingDatabaseName, process.env.STAGING_RESET_CONFIRM);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [stagingDatabaseName]
    );
    if (existing.rows[0].exists && reset) {
      const active = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [stagingDatabaseName]
      );
      if (Number(active.rows[0].count) > 0) throw new Error("staging_database_has_active_connections");
      await client.query(`DROP DATABASE ${stagingDatabaseName}`);
    }
    if (!existing.rows[0].exists || reset) await client.query(`CREATE DATABASE ${stagingDatabaseName}`);
  } finally {
    await client.end();
  }
}

export function assertResetConfirmed(reset: boolean, databaseName: string, confirmation?: string) {
  if (reset && confirmation !== databaseName) throw new Error(`STAGING_RESET_CONFIRM_must_equal_${databaseName}`);
}

export function stagingDepositStartBlock(input: { reset: boolean; existing?: string; proposed: bigint }) {
  return !input.reset && input.existing && /^(0|[1-9][0-9]*)$/.test(input.existing)
    ? BigInt(input.existing)
    : input.proposed;
}

export function stagingShadowVaultProvisioningInput(treasuryAddress: string) {
  return {
    treasuryAddress: getAddress(treasuryAddress),
    tokenAddress: CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS
  };
}

async function verifyFreshFinancialState(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const counts: Record<string, number> = {};
    for (const table of financialTables) {
      const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      counts[table] = Number(result.rows[0].count);
    }
    const populated = Object.entries(counts).filter(([, count]) => count !== 0);
    if (populated.length > 0) throw new Error(`staging_financial_state_not_empty:${populated.map(([name]) => name).join(",")}`);
    return counts;
  } finally {
    await client.end();
  }
}

export async function provisionSepoliaStaging(reset = process.argv.includes("--reset")) {
  if (process.env.STAGING_DATABASE_NAME && process.env.STAGING_DATABASE_NAME !== stagingDatabaseName) {
    throw new Error("STAGING_DATABASE_NAME_must_be_legwork_sepolia_staging");
  }
  const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL_or_DATABASE_URL_required");
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) throw new Error("ETHEREUM_RPC_URL_required_for_staging");
  const chainId = BigInt(await rpc<string>(rpcUrl, "eth_chainId"));
  if (chainId !== BigInt(SEPOLIA_PAYMENT_CHAIN_ID)) throw new Error("staging_rpc_must_be_sepolia");
  const currentBlock = BigInt(await rpc<string>(rpcUrl, "eth_blockNumber"));
  const proposedDepositStartBlock = currentBlock > 128n ? currentBlock - 128n : 0n;
  const targetUrl = databaseUrlForName(adminUrl, stagingDatabaseName);
  if (targetUrl === adminUrl) throw new Error("staging_database_must_be_isolated");

  const existing = await existingStagingEnvironment();
  const persistedDepositStartBlock = existing.USDC_DEPOSIT_START_BLOCK;
  const depositStartBlock = stagingDepositStartBlock({ reset, existing: persistedDepositStartBlock, proposed: proposedDepositStartBlock });
  const stagingRedisUrl = redisUrlForStaging(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  assertSafeLocalStagingRedisReset(stagingRedisUrl);
  await assertResetRecoveryPoint(reset);
  // Validate every required value and prove the private file is writable before a reset can drop state.
  await writeStagingEnvironment({ databaseUrl: targetUrl, depositStartBlock, existing });
  await createOrResetDatabase(adminUrl, reset);
  if (reset) await resetStagingRedis(stagingRedisUrl);

  await closePool();
  config.DATABASE_URL = targetUrl;
  await migrate();
  const shadowVault = await provisionFounderSepoliaShadowVault(
    stagingShadowVaultProvisioningInput(process.env.TREASURY_SAFE_ADDRESS!)
  );
  const backfill = await runSettlementIdentityBackfillCommand({ log: () => undefined });
  if (backfill.exitCode !== 0) throw new Error("staging_settlement_identity_backfill_failed");
  const counts = await verifyFreshFinancialState(targetUrl);
  const migrationCount = (await readdir(path.resolve("server/db/migrations"))).filter((name) => name.endsWith(".sql")).length;
  await closePool();

  return {
    database: stagingDatabaseName,
    environmentFile: path.relative(process.cwd(), stagingEnvironmentPath),
    migrations: migrationCount,
    shadowVault: {
      id: shadowVault.id,
      key: shadowVault.vaultKey,
      depositsEnabled: shadowVault.depositsEnabled,
      communityCustody: shadowVault.communityCustody
    },
    depositStartBlock: depositStartBlock.toString(),
    financialRows: counts,
    reset
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  try {
    console.log(JSON.stringify(await provisionSepoliaStaging(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "staging_provision_failed");
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
