import { getAddress } from "viem";
import { config } from "../config";
import { closePool } from "../db/client";
import { markWorkerFailure, markWorkerSuccess, sanitizeWorkerFailure } from "../db/workerHeartbeatRepository";
import { listDepositTreasuryScanConfigs, type DepositTreasuryScanConfig } from "../db/depositRepository";
import {
  createReconciliationSnapshot,
  reconciliationApiIntegrationHooks,
  type TreasuryAssetSnapshotInput
} from "../db/reconciliationRepository";
import { staticStagingTreasuryConfig, usesStaticStagingTreasury } from "../stagingTreasury";
import { requireEthereumRpcChainId } from "./ethereumRpcChain";
import { startWorkerHeartbeat } from "./heartbeat";
import { createInterruptibleSleeper } from "./interruptibleSleep";
import { acquireWorkerSingletonLease } from "./singletonLease";

type Hex = `0x${string}`;
const outboundReadTimeoutMs = 10_000;

type ReconciliationWorkerDependencies = {
  getChainId?: () => Promise<Hex>;
  getCurrentBlock?: () => Promise<bigint>;
  getBlockHash?: (blockNumber: bigint) => Promise<Hex>;
  getTokenBalance?: (input: { tokenAddress: string; holderAddress: string; blockNumber: bigint }) => Promise<bigint>;
  listTreasuryScanConfigs?: typeof listDepositTreasuryScanConfigs;
  createSnapshot?: typeof createReconciliationSnapshot;
  treasuryConfigs?: DepositTreasuryScanConfig[];
  treasuryAssets?: TreasuryAssetSnapshotInput[];
};

export const reconciliationWorkerIntegrationHooks = {
  ...reconciliationApiIntegrationHooks,
  workerEntrypoint: "server/workers/reconciliationWorker.ts",
  workerFunction: "processFinancialReconciliation",
  npmScript: "worker:reconciliation"
} as const;

function requireRpcConfig() {
  if (!config.ETHEREUM_RPC_URL) {
    throw new Error("ETHEREUM_RPC_URL is required for financial reconciliation.");
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  requireRpcConfig();
  const timeoutSignal = AbortSignal.timeout(outboundReadTimeoutMs);
  let response: Response;
  try {
    response = await fetch(config.ETHEREUM_RPC_URL!, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      }),
      signal: timeoutSignal
    });
  } catch {
    throw new Error(timeoutSignal.aborted ? "ethereum_rpc_timeout" : "ethereum_rpc_request_failed");
  }

  if (!response.ok) throw new Error(`ethereum_rpc_http_${response.status}`);
  const payload = (await response.json()) as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message || "ethereum_rpc_error");
  if (payload.result === undefined) throw new Error("ethereum_rpc_missing_result");
  return payload.result;
}

function toQuantity(value: bigint) {
  return `0x${value.toString(16)}`;
}

async function getRpcCurrentBlock() {
  return BigInt(await rpc<Hex>("eth_blockNumber", []));
}

async function getRpcChainId() {
  return await rpc<Hex>("eth_chainId", []);
}

async function getRpcBlockHash(blockNumber: bigint) {
  const block = await rpc<{ hash?: Hex } | null>("eth_getBlockByNumber", [toQuantity(blockNumber), false]);
  if (!block?.hash) throw new Error("ethereum_rpc_block_unavailable");
  return block.hash;
}

async function getRpcTokenBalance(input: { tokenAddress: string; holderAddress: string; blockNumber: bigint }) {
  const tokenAddress = getAddress(input.tokenAddress);
  const holderAddress = getAddress(input.holderAddress);
  const balanceOfSelector = "70a08231";
  const data = `0x${balanceOfSelector}${holderAddress.slice(2).padStart(64, "0")}`;
  const value = await rpc<Hex>("eth_call", [{ to: tokenAddress, data }, toQuantity(input.blockNumber)]);
  return BigInt(value);
}

async function resolveTreasuryConfigs(loadTreasuryScanConfigs = listDepositTreasuryScanConfigs): Promise<DepositTreasuryScanConfig[]> {
  if (usesStaticStagingTreasury()) return [staticStagingTreasuryConfig()];

  if (config.DATABASE_URL) {
    const configured = await loadTreasuryScanConfigs(config.SETTLEMENT_CHAIN_ID, "USDC");
    if (configured.length > 0) return configured;
  }

  if (!config.TREASURY_SAFE_ADDRESS) throw new Error("TREASURY_SAFE_ADDRESS is required for financial reconciliation.");
  return [
    {
      chainId: config.SETTLEMENT_CHAIN_ID,
      currency: "USDC",
      treasuryAddress: getAddress(config.TREASURY_SAFE_ADDRESS),
      usdcContractAddress: getAddress(config.USDC_CONTRACT_ADDRESS),
      requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS,
      active: true
    }
  ];
}

function uniqueTreasuryAssets(configs: DepositTreasuryScanConfig[]) {
  const unique = new Map<string, DepositTreasuryScanConfig>();
  for (const item of configs) {
    const treasuryAddress = getAddress(item.treasuryAddress);
    const usdcContractAddress = getAddress(item.usdcContractAddress);
    unique.set(`${item.chainId}:${treasuryAddress.toLowerCase()}:${usdcContractAddress.toLowerCase()}`, {
      ...item,
      treasuryAddress,
      usdcContractAddress
    });
  }
  return [...unique.values()];
}

export async function processFinancialReconciliation(dependencies: ReconciliationWorkerDependencies = {}) {
  const usesEthereumRpc = dependencies.treasuryAssets
    ? !dependencies.getBlockHash
    : !dependencies.getCurrentBlock || !dependencies.getBlockHash || !dependencies.getTokenBalance;
  if (usesEthereumRpc) {
    await requireEthereumRpcChainId(dependencies.getChainId || getRpcChainId, config.SETTLEMENT_CHAIN_ID);
  }

  const createSnapshot = dependencies.createSnapshot || createReconciliationSnapshot;
  const treasuryConfigs = uniqueTreasuryAssets(
    (dependencies.treasuryConfigs || (await resolveTreasuryConfigs(dependencies.listTreasuryScanConfigs))).filter(
      (item) => item.active && item.chainId === config.SETTLEMENT_CHAIN_ID && item.currency === "USDC"
    )
  );
  if (treasuryConfigs.length === 0) throw new Error("treasury_config_missing");
  const chainId = treasuryConfigs[0].chainId;
  if (treasuryConfigs.some((item) => item.chainId !== chainId)) throw new Error("reconciliation_multiple_chains_not_supported");
  if (chainId !== config.SETTLEMENT_CHAIN_ID) throw new Error("reconciliation_payment_chain_mismatch");

  const getCurrentBlock = dependencies.getCurrentBlock || getRpcCurrentBlock;
  const getBlockHash = dependencies.getBlockHash || getRpcBlockHash;
  const treasuryAssets = dependencies.treasuryAssets || (await (async () => {
    const getTokenBalance = dependencies.getTokenBalance || getRpcTokenBalance;
    const blockNumber = await getCurrentBlock();
    const blockHash = await getBlockHash(blockNumber);
    return await Promise.all(
      treasuryConfigs.map(async (item) => ({
        chainId: item.chainId,
        treasuryAddress: item.treasuryAddress,
        tokenAddress: item.usdcContractAddress,
        balanceMicroUnits: await getTokenBalance({
          tokenAddress: item.usdcContractAddress,
          holderAddress: item.treasuryAddress,
          blockNumber
        }),
        blockNumber,
        blockHash,
        source: "onchain" as const
      }))
    );
  })());

  const observedBlockNumbers = new Set(treasuryAssets.map((asset) => asset.blockNumber?.toString()));
  const observedBlockHashes = new Set(treasuryAssets.map((asset) => asset.blockHash?.toLowerCase()));
  if (observedBlockNumbers.size !== 1 || observedBlockNumbers.has(undefined)) {
    throw new Error("reconciliation_assets_block_mismatch");
  }
  if (observedBlockHashes.size !== 1 || observedBlockHashes.has(undefined)) {
    throw new Error("reconciliation_assets_block_hash_mismatch");
  }
  const observedBlockNumber = BigInt([...observedBlockNumbers][0]!);
  const expectedBlockHash = [...observedBlockHashes][0]!;
  const canonicalBlockHash = (await getBlockHash(observedBlockNumber)).toLowerCase();
  if (canonicalBlockHash !== expectedBlockHash) throw new Error("reconciliation_block_reorged_before_insert");

  return await createSnapshot({
    source: "worker",
    chainId,
    currency: "USDC",
    treasuryAssets,
    verifyCanonicalBlock: async ({ blockNumber, blockHash }) => {
      const immediatelyCanonicalBlockHash = (await getBlockHash(blockNumber)).toLowerCase();
      if (immediatelyCanonicalBlockHash !== blockHash.toLowerCase()) {
        throw new Error("reconciliation_block_reorged_before_insert");
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let shouldStop = false;
  const sleeper = createInterruptibleSleeper();
  const pollIntervalMs = Number(process.env.RECONCILIATION_POLL_INTERVAL_MS || 60_000);
  const releaseWorkerLease = await acquireWorkerSingletonLease("financial-reconciliation");
  const stopHeartbeat = startWorkerHeartbeat("financial-reconciliation");

  process.on("SIGINT", () => {
    shouldStop = true;
    sleeper.interrupt();
  });
  process.on("SIGTERM", () => {
    shouldStop = true;
    sleeper.interrupt();
  });

  try {
    console.log("Financial reconciliation worker started");
    while (!shouldStop) {
      try {
        const result = await processFinancialReconciliation();
        await markWorkerSuccess("financial-reconciliation");
        console.log(
          JSON.stringify({
            event: "financial.reconciliation.snapshot",
            snapshotId: result.id,
            launchGate: result.launchGate,
            operationGate: result.operationGate,
            unexplainedDeltaMicroUnits: result.unexplainedDeltaMicroUnits,
            houseEquityMicroUnits: result.houseEquityMicroUnits
          })
        );
      } catch (error) {
        const failure = sanitizeWorkerFailure(error);
        await markWorkerFailure("financial-reconciliation", failure).catch((heartbeatError) => {
          console.error(JSON.stringify({ event: "financial.reconciliation.health.error", error: sanitizeWorkerFailure(heartbeatError) }));
        });
        console.error(
          JSON.stringify({
            event: "financial.reconciliation.error",
            error: failure
          })
        );
      }
      await sleeper.sleep(Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 60_000);
    }
  } finally {
    stopHeartbeat();
    await releaseWorkerLease();
    await closePool();
  }
}
