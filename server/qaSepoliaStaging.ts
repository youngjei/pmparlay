import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import pg from "pg";
import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";
import { sepolia } from "viem/chains";
import { config, CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS, SEPOLIA_PAYMENT_CHAIN_ID } from "./config";
import { closePool } from "./db/client";
import { migrationChecksum } from "./db/migrate";
import { getSettlementIdentityQuarantineSummary } from "./db/settlementRepository";
import { processFinancialReconciliation } from "./workers/reconciliationWorker";

const requireOpen = process.argv.includes("--require-open");
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

export function assertIsolatedStagingTargets(databaseUrl: string | undefined, redisUrl: string) {
  if (!databaseUrl) throw new Error("staging_database_url_missing");
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  const redisLoopback = redis.hostname === "127.0.0.1" || redis.hostname === "localhost" || redis.hostname === "::1";
  if (database.pathname !== "/legwork_sepolia_staging") throw new Error("staging_database_target_mismatch");
  if (!redisLoopback || redis.pathname !== "/1") throw new Error("staging_redis_target_mismatch");
}

export function assertMigrationManifest(
  applied: Array<{ name: string; checksum: string | null }>,
  current: Array<{ name: string; checksum: string }>
) {
  if (applied.length !== current.length) throw new Error("staging_migration_count_mismatch");
  for (let index = 0; index < current.length; index += 1) {
    if (applied[index]?.name !== current[index].name) throw new Error("staging_migration_name_mismatch");
    if (applied[index]?.checksum !== current[index].checksum) {
      throw new Error(`staging_migration_checksum_mismatch:${current[index].name}`);
    }
  }
}

async function verifyDatabase() {
  assertIsolatedStagingTargets(config.DATABASE_URL, config.REDIS_URL);
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    const migrationDirectory = path.resolve("server/db/migrations");
    const migrationNames = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
    const currentMigrations = await Promise.all(
      migrationNames.map(async (name) => ({
        name,
        checksum: migrationChecksum(await readFile(path.join(migrationDirectory, name), "utf8"))
      }))
    );
    const applied = await client.query<{ name: string; checksum: string | null }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name"
    );
    assertMigrationManifest(applied.rows, currentMigrations);
    const counts: Record<string, number> = {};
    for (const table of financialTables) {
      const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      counts[table] = Number(result.rows[0].count);
    }
    const workers = await client.query<{
      worker_name: string;
      instance_generation: string;
      heartbeat_at: Date;
      last_success_at: Date | null;
      latest_failure: string | null;
    }>(
      `SELECT worker_name, instance_generation::text, heartbeat_at, last_success_at, latest_failure
       FROM worker_runtime_heartbeats
       ORDER BY worker_name`
    );
    return {
      migrations: currentMigrations.length,
      migrationChecksums: "verified",
      counts,
      workers: workers.rows.map((worker) => ({
        name: worker.worker_name,
        instanceGeneration: worker.instance_generation,
        heartbeatAt: worker.heartbeat_at.toISOString(),
        lastSuccessAt: worker.last_success_at?.toISOString() || null,
        latestFailure: worker.latest_failure
      }))
    };
  } finally {
    await client.end();
  }
}

async function verifyRedis() {
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false
  });
  try {
    await redis.connect();
    if ((await redis.ping()) !== "PONG") throw new Error("staging_redis_ping_failed");
  } finally {
    redis.disconnect();
  }
}

async function verifyOnchainConfiguration() {
  if (config.NODE_ENV !== "production") throw new Error("staging_requires_production_config");
  if (config.SETTLEMENT_CHAIN_ID !== SEPOLIA_PAYMENT_CHAIN_ID) throw new Error("staging_payment_chain_mismatch");
  if (config.USDC_CONTRACT_ADDRESS.toLowerCase() !== CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS.toLowerCase()) {
    throw new Error("staging_usdc_contract_mismatch");
  }
  if (!config.ETHEREUM_RPC_URL || !config.TREASURY_SAFE_ADDRESS) throw new Error("staging_onchain_config_missing");

  const client = createPublicClient({ chain: sepolia, transport: http(config.ETHEREUM_RPC_URL) });
  if ((await client.getChainId()) !== SEPOLIA_PAYMENT_CHAIN_ID) throw new Error("staging_rpc_chain_mismatch");
  const safeAddress = getAddress(config.TREASURY_SAFE_ADDRESS);
  const expectedSafeOwner = process.env.STAGING_EXPECTED_SAFE_OWNER
    ? getAddress(process.env.STAGING_EXPECTED_SAFE_OWNER)
    : undefined;
  if (!expectedSafeOwner) throw new Error("staging_expected_safe_owner_missing");
  const usdcAddress = getAddress(config.USDC_CONTRACT_ADDRESS);
  const [safeCode, usdcCode, owners, threshold, usdcBalance] = await Promise.all([
    client.getCode({ address: safeAddress }),
    client.getCode({ address: usdcAddress }),
    client.readContract({
      address: safeAddress,
      abi: [{ type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] }],
      functionName: "getOwners"
    }),
    client.readContract({
      address: safeAddress,
      abi: [{ type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "getThreshold"
    }),
    client.readContract({ address: usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [safeAddress] })
  ]);
  if (!safeCode || safeCode === "0x") throw new Error("staging_safe_not_deployed");
  if (!usdcCode || usdcCode === "0x") throw new Error("staging_usdc_not_deployed");
  if (owners.length === 0 || threshold < 1n || threshold > BigInt(owners.length)) throw new Error("staging_safe_policy_invalid");
  if (owners.length !== 1 || threshold !== 1n || getAddress(owners[0]) !== expectedSafeOwner) {
    throw new Error("staging_safe_owner_or_threshold_mismatch");
  }
  return { owners, threshold: threshold.toString(), usdcBalance: formatUnits(usdcBalance, 6) };
}

export async function runSepoliaStagingQa() {
  assertIsolatedStagingTargets(config.DATABASE_URL, config.REDIS_URL);
  const [database, onchain, quarantine] = await Promise.all([
    verifyDatabase(),
    verifyOnchainConfiguration(),
    getSettlementIdentityQuarantineSummary()
  ]);
  await verifyRedis();
  if (quarantine.unresolved > 0) throw new Error("staging_settlement_identity_quarantine_unresolved");
  const reconciliation = await processFinancialReconciliation();
  if (requireOpen && (reconciliation.launchGate !== "ready" || reconciliation.operationGate !== "open")) {
    throw new Error(`staging_financial_gate_not_open:${reconciliation.gateReasons.join(",")}`);
  }
  return {
    database,
    redis: "ready",
    onchain,
    settlementIdentityQuarantine: quarantine,
    reconciliation: {
      launchGate: reconciliation.launchGate,
      operationGate: reconciliation.operationGate,
      unexplainedDeltaMicroUnits: reconciliation.unexplainedDeltaMicroUnits,
      reasons: reconciliation.gateReasons
    }
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  try {
    console.log(JSON.stringify(await runSepoliaStagingQa(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "staging_qa_failed");
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
