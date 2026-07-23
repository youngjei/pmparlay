import { getAddress } from "viem";
import { config } from "../config";
import { closePool } from "../db/client";
import {
  markWorkerFailure,
  markWorkerSuccess,
  REQUIRED_FINANCIAL_WORKERS,
  sanitizeWorkerFailure
} from "../db/workerHeartbeatRepository";
import {
  blockDepositScannerForMissingAncestor,
  creditConfirmedDeposit,
  getScanCursor,
  listScanBlockObservations,
  listDepositTreasuryScanConfigs,
  markReorgedDeposits,
  saveScanCursor,
  type ConfirmedDepositInput,
  type DepositTreasuryScanConfig,
  type ScanBlockObservation,
  type ScanCursor
} from "../db/depositRepository";
import { getActiveTreasuryConfig } from "../db/treasuryRepository";
import { activateConfirmedQuotePayment, activateConfirmedQuotePayments } from "../paymentActivation";
import { staticStagingTreasuryConfig, usesStaticStagingTreasury } from "../stagingTreasury";
import { requireEthereumRpcChainId } from "./ethereumRpcChain";
import { startWorkerHeartbeat } from "./heartbeat";
import { createInterruptibleSleeper } from "./interruptibleSleep";
import { acquireWorkerSingletonLease } from "./singletonLease";

const cursorName = "usdc-deposits";
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const defaultDepositScanOverlapBlocks = 24n;
const outboundReadTimeoutMs = 10_000;
// This worker reaches activation only after its current canonical scan succeeds; requiring its prior-cycle
// success here would prevent recovery after startup or a transient scan failure.
const depositActivationRequiredWorkers = REQUIRED_FINANCIAL_WORKERS.filter(
  (workerName) => workerName !== "usdc-deposit-scanner"
);

type Hex = `0x${string}`;
type Address = Hex;

type TransferLog = {
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash?: Hex | null;
  address: Address;
  args: {
    from?: Address;
    to?: Address;
    value?: bigint;
  };
};

type TransferLogPage = {
  logs: TransferLog[];
  complete: boolean;
  completeToBlock?: bigint;
};

type DepositScannerDependencies = {
  getChainId?: () => Promise<Hex>;
  getCurrentBlock?: () => Promise<bigint>;
  getBlockHash?: (blockNumber: bigint) => Promise<Hex>;
  getTransferLogs?: (fromBlock: bigint, toBlock: bigint, treasuryConfig: DepositTreasuryConfig) => Promise<TransferLog[] | TransferLogPage>;
  creditDeposit?: typeof creditConfirmedDeposit;
  activatePayment?: typeof activateConfirmedQuotePayment;
  activateConfirmedPayments?: typeof activateConfirmedQuotePayments;
  getActiveTreasuryConfig?: typeof getActiveTreasuryConfig;
  listTreasuryScanConfigs?: typeof listDepositTreasuryScanConfigs;
  markReorgedDeposits?: typeof markReorgedDeposits;
  listScanBlockObservations?: typeof listScanBlockObservations;
  blockForMissingAncestor?: typeof blockDepositScannerForMissingAncestor;
  getCursor?: (chainId: number, cursor: string) => Promise<ScanCursor | bigint | undefined>;
  saveCursor?: typeof saveScanCursor;
  treasuryConfig?: DepositTreasuryConfig;
  treasuryConfigs?: DepositTreasuryConfig[];
  overlapBlocks?: bigint | number;
};

type DepositTreasuryConfig = {
  id?: string;
  chainId: number;
  currency?: "USDC";
  treasuryAddress: string;
  usdcContractAddress: string;
  requiredConfirmations: number;
  active?: boolean;
};

export function stringifyDepositWorkerEvent(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function requireRpcConfig() {
  if (!config.ETHEREUM_RPC_URL) {
    throw new Error("ETHEREUM_RPC_URL is required for USDC deposit scanning.");
  }
}

async function resolveDepositTreasuryConfig(loadActiveTreasuryConfig = getActiveTreasuryConfig): Promise<DepositTreasuryConfig> {
  if (usesStaticStagingTreasury()) return staticStagingTreasuryConfig();

  if (config.DATABASE_URL) {
    const active = await loadActiveTreasuryConfig(config.SETTLEMENT_CHAIN_ID, "USDC");
    if (active) {
      return {
        chainId: active.chainId,
        treasuryAddress: active.treasuryAddress,
        usdcContractAddress: active.usdcContractAddress,
        requiredConfirmations: active.requiredConfirmations
      };
    }
  }

  if (!config.TREASURY_SAFE_ADDRESS) {
    throw new Error("TREASURY_SAFE_ADDRESS is required for USDC deposit scanning.");
  }
  return {
    chainId: config.SETTLEMENT_CHAIN_ID,
    treasuryAddress: config.TREASURY_SAFE_ADDRESS,
    usdcContractAddress: config.USDC_CONTRACT_ADDRESS,
    requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
  };
}

async function resolveDepositTreasuryConfigs(
  loadTreasuryScanConfigs = listDepositTreasuryScanConfigs,
  loadActiveTreasuryConfig = getActiveTreasuryConfig
): Promise<DepositTreasuryConfig[]> {
  if (usesStaticStagingTreasury()) return [staticStagingTreasuryConfig()];

  if (config.DATABASE_URL) {
    const configured = await loadTreasuryScanConfigs(config.SETTLEMENT_CHAIN_ID, "USDC");
    if (configured.length > 0) {
      return configured.map((item: DepositTreasuryScanConfig) => ({
        id: item.id,
        chainId: item.chainId,
        currency: item.currency,
        treasuryAddress: item.treasuryAddress,
        usdcContractAddress: item.usdcContractAddress,
        requiredConfirmations: item.requiredConfirmations,
        active: item.active
      }));
    }
  }

  return [await resolveDepositTreasuryConfig(loadActiveTreasuryConfig)];
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

  if (!response.ok) {
    throw new Error(`ethereum_rpc_http_${response.status}`);
  }

  const payload = (await response.json()) as { result?: T; error?: { message?: string } };
  if (payload.error) {
    throw new Error(payload.error.message || "ethereum_rpc_error");
  }
  if (payload.result === undefined) {
    throw new Error("ethereum_rpc_missing_result");
  }

  return payload.result;
}

function defaultStartBlock(currentBlock: bigint) {
  if (config.USDC_DEPOSIT_START_BLOCK !== undefined) return BigInt(config.USDC_DEPOSIT_START_BLOCK);
  const lookback = BigInt(config.USDC_DEPOSIT_SCAN_LOOKBACK_BLOCKS);
  return currentBlock > lookback ? currentBlock - lookback : 0n;
}

function toQuantity(value: bigint) {
  return `0x${value.toString(16)}`;
}

function topicAddress(address: string) {
  return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, "0")}`;
}

function addressFromTopic(topic: string): Address {
  return getAddress(`0x${topic.slice(-40)}`) as Address;
}

async function getRpcCurrentBlock() {
  const value = await rpc<Hex>("eth_blockNumber", []);
  return BigInt(value);
}

async function getRpcChainId() {
  return await rpc<Hex>("eth_chainId", []);
}

async function getRpcBlockHash(blockNumber: bigint) {
  const block = await rpc<{ hash?: Hex } | null>("eth_getBlockByNumber", [toQuantity(blockNumber), false]);
  if (!block?.hash) throw new Error("ethereum_rpc_block_unavailable");
  return block.hash;
}

async function getRpcTransferLogs(fromBlock: bigint, toBlock: bigint, treasuryConfig: DepositTreasuryConfig): Promise<TransferLog[]> {
  const treasuryAddress = getAddress(treasuryConfig.treasuryAddress);
  const usdcAddress = getAddress(treasuryConfig.usdcContractAddress);
  const logs = await rpc<
    Array<{
      transactionHash: Hex;
      logIndex: Hex;
      blockNumber: Hex;
      blockHash?: Hex;
      address: Address;
      topics: [Hex, Hex, Hex, ...Hex[]];
      data: Hex;
    }>
  >("eth_getLogs", [
    {
      address: usdcAddress,
      fromBlock: toQuantity(fromBlock),
      toBlock: toQuantity(toBlock),
      topics: [transferTopic, null, topicAddress(treasuryAddress)]
    }
  ]);

  return logs.map((log) => ({
    transactionHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    blockNumber: BigInt(log.blockNumber),
    blockHash: log.blockHash,
    address: getAddress(log.address) as Address,
    args: {
      from: addressFromTopic(log.topics[1]),
      to: addressFromTopic(log.topics[2]),
      value: BigInt(log.data)
    }
  }));
}

function cursorBlock(cursor: ScanCursor | bigint | undefined) {
  if (cursor === undefined) return undefined;
  return typeof cursor === "bigint" ? cursor : cursor.lastScannedBlock;
}

function cursorHash(cursor: ScanCursor | bigint | undefined) {
  return typeof cursor === "object" ? cursor.lastScannedBlockHash?.toLowerCase() : undefined;
}

function minimumStartBlock() {
  return config.USDC_DEPOSIT_START_BLOCK !== undefined ? BigInt(config.USDC_DEPOSIT_START_BLOCK) : 0n;
}

function normalizeTransferLogPage(result: TransferLog[] | TransferLogPage, requestedToBlock: bigint): TransferLogPage {
  if (Array.isArray(result)) {
    return {
      logs: result,
      complete: true,
      completeToBlock: requestedToBlock
    };
  }

  return {
    logs: result.logs,
    complete: result.complete,
    completeToBlock: result.complete ? requestedToBlock : result.completeToBlock
  };
}

function depositLogKey(log: TransferLog) {
  return `${log.transactionHash.toLowerCase()}:${log.logIndex}:${(log.blockHash || "").toLowerCase()}`;
}

function uniqueLogs(logs: TransferLog[]) {
  const seen = new Set<string>();
  const deduped: TransferLog[] = [];
  for (const log of logs) {
    const key = depositLogKey(log);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(log);
  }
  return deduped;
}

function normalizeTreasuryConfigs(treasuryConfigs: DepositTreasuryConfig[]) {
  const deduped = new Map<string, DepositTreasuryConfig>();

  for (const item of treasuryConfigs) {
    const treasuryAddress = getAddress(item.treasuryAddress);
    const usdcContractAddress = getAddress(item.usdcContractAddress);
    const key = `${item.chainId}:${treasuryAddress.toLowerCase()}:${usdcContractAddress.toLowerCase()}`;
    const existing = deduped.get(key);
    deduped.set(key, {
      ...item,
      treasuryAddress,
      usdcContractAddress,
      requiredConfirmations: Math.max(item.requiredConfirmations, existing?.requiredConfirmations || 0),
      active: Boolean(item.active || existing?.active)
    });
  }

  const configs = [...deduped.values()];
  if (configs.length === 0) throw new Error("treasury_config_missing");
  const chainId = configs[0].chainId;
  if (configs.some((item) => item.chainId !== chainId)) {
    throw new Error("deposit_scan_multiple_chains_not_supported");
  }
  return configs;
}

async function determineCommonAncestor(input: {
  beforeBlock: bigint;
  observations: ScanBlockObservation[];
  getBlockHash: (blockNumber: bigint) => Promise<Hex>;
}) {
  const byBlock = new Map<bigint, ScanBlockObservation>();
  for (const observation of input.observations) {
    if (observation.blockNumber >= input.beforeBlock) continue;
    byBlock.set(observation.blockNumber, {
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash.toLowerCase()
    });
  }

  for (const observation of [...byBlock.values()].sort((left, right) => (left.blockNumber > right.blockNumber ? -1 : 1))) {
    const canonicalHash = (await input.getBlockHash(observation.blockNumber)).toLowerCase();
    if (canonicalHash === observation.blockHash.toLowerCase()) {
      return observation.blockNumber;
    }
  }

  return undefined;
}

function configuredOverlapBlocks(value: bigint | number | undefined) {
  const overlap = value === undefined ? defaultDepositScanOverlapBlocks : BigInt(value);
  if (overlap < 0n) throw new Error("invalid_deposit_scan_overlap");
  return overlap;
}

function laterBlock(left: bigint, right: bigint) {
  return left > right ? left : right;
}

function earlierBlock(left: bigint, right: bigint) {
  return left < right ? left : right;
}

async function fetchTransferLogRange(input: {
  fromBlock: bigint;
  toBlock: bigint;
  treasuryConfigs: DepositTreasuryConfig[];
  getTransferLogs: (fromBlock: bigint, toBlock: bigint, treasuryConfig: DepositTreasuryConfig) => Promise<TransferLog[] | TransferLogPage>;
}) {
  const fetchedLogs: TransferLog[] = [];
  let incomplete = false;
  let completeToBlock = input.toBlock;

  for (const treasuryConfig of input.treasuryConfigs) {
    const page = normalizeTransferLogPage(await input.getTransferLogs(input.fromBlock, input.toBlock, treasuryConfig), input.toBlock);
    fetchedLogs.push(...page.logs);
    if (!page.complete) {
      incomplete = true;
      const pageCompleteToBlock = page.completeToBlock ?? input.fromBlock - 1n;
      completeToBlock = pageCompleteToBlock < completeToBlock ? pageCompleteToBlock : completeToBlock;
    }
  }

  return {
    fetchedLogs,
    incomplete,
    completeToBlock
  };
}

export async function processUsdcDepositScan(dependencies: DepositScannerDependencies = {}) {
  const usesEthereumRpc = !dependencies.getCurrentBlock || !dependencies.getBlockHash || !dependencies.getTransferLogs;
  if (usesEthereumRpc) {
    await requireEthereumRpcChainId(dependencies.getChainId || getRpcChainId, config.SETTLEMENT_CHAIN_ID);
  }

  const treasuryConfigs = normalizeTreasuryConfigs(
    dependencies.treasuryConfigs ||
      (dependencies.treasuryConfig ? [dependencies.treasuryConfig] : await resolveDepositTreasuryConfigs(dependencies.listTreasuryScanConfigs, dependencies.getActiveTreasuryConfig))
  );
  const chainId = treasuryConfigs[0].chainId;
  const requiredConfirmations = Math.max(...treasuryConfigs.map((item) => item.requiredConfirmations));
  const getCurrentBlock = dependencies.getCurrentBlock || getRpcCurrentBlock;
  const getBlockHash = dependencies.getBlockHash || getRpcBlockHash;
  const getTransferLogs = dependencies.getTransferLogs || getRpcTransferLogs;
  const creditDeposit = dependencies.creditDeposit || creditConfirmedDeposit;
  const activatePayment =
    dependencies.activatePayment ||
    ((input: { quoteId: string; userId: string }) =>
      activateConfirmedQuotePayment(input, { requiredWorkerNames: depositActivationRequiredWorkers }));
  const activateConfirmedPayments =
    dependencies.activateConfirmedPayments ||
    ((limit = 25) => activateConfirmedQuotePayments(limit, { requiredWorkerNames: depositActivationRequiredWorkers }));
  const loadCursor = dependencies.getCursor || getScanCursor;
  const storeCursor = dependencies.saveCursor || saveScanCursor;
  const loadScanBlockObservations = dependencies.listScanBlockObservations || listScanBlockObservations;
  const blockForMissingAncestor = dependencies.blockForMissingAncestor || blockDepositScannerForMissingAncestor;
  const overlapBlocks = configuredOverlapBlocks(dependencies.overlapBlocks);
  const markReorgs =
    dependencies.markReorgedDeposits ||
    (config.DATABASE_URL
      ? markReorgedDeposits
        : async () => ({
          reorged: 0,
          creditedReorged: 0,
          houseFundingReorged: 0
        }));

  const currentBlock = await getCurrentBlock();
  const confirmedBlock = currentBlock >= BigInt(requiredConfirmations) ? currentBlock - BigInt(requiredConfirmations) + 1n : 0n;
  const previousCursor = await loadCursor(chainId, cursorName);
  const previousCursorBlock = cursorBlock(previousCursor);
  const previousCursorHash = cursorHash(previousCursor);
  const canonicalBlockHashes = new Map<string, Hex>();
  const canonicalBlockHash = async (blockNumber: bigint) => {
    const key = blockNumber.toString();
    const cached = canonicalBlockHashes.get(key);
    if (cached) return cached;
    const hash = await getBlockHash(blockNumber);
    canonicalBlockHashes.set(key, hash);
    return hash;
  };
  let reorgDetected = false;
  let commonAncestorBlock: bigint | undefined;
  let overlapFromBlock = previousCursorBlock === undefined ? undefined : previousCursorBlock + 1n;
  if (previousCursorBlock !== undefined && overlapBlocks > 0n) {
    overlapFromBlock = laterBlock(minimumStartBlock(), previousCursorBlock - overlapBlocks + 1n);
    const overlapToBlock = earlierBlock(previousCursorBlock, confirmedBlock);
    if (overlapToBlock >= overlapFromBlock) {
      const observations = await loadScanBlockObservations({
        chainId,
        cursorName,
        fromBlock: overlapFromBlock,
        toBlock: overlapToBlock
      });
      const observationsByBlock = new Map(observations.map((observation) => [observation.blockNumber.toString(), observation]));
      if (previousCursorHash && previousCursorBlock <= overlapToBlock) {
        observationsByBlock.set(previousCursorBlock.toString(), {
          blockNumber: previousCursorBlock,
          blockHash: previousCursorHash
        });
      }
      const boundedObservations = [...observationsByBlock.values()];
      const mismatchedBlocks: bigint[] = [];
      for (const observation of boundedObservations) {
        const canonicalHash = (await canonicalBlockHash(observation.blockNumber)).toLowerCase();
        if (canonicalHash !== observation.blockHash.toLowerCase()) mismatchedBlocks.push(observation.blockNumber);
      }
      if (mismatchedBlocks.length > 0) {
        reorgDetected = true;
        const earliestMismatch = mismatchedBlocks.reduce((earliest, block) => (block < earliest ? block : earliest));
        commonAncestorBlock = await determineCommonAncestor({
          beforeBlock: earliestMismatch,
          observations: boundedObservations,
          getBlockHash: canonicalBlockHash
        });
        if (commonAncestorBlock === undefined) {
          await blockForMissingAncestor({
            chainId,
            cursorName,
            previousCursorBlock,
            lookbackFromBlock: overlapFromBlock,
            mismatchedBlocks
          });
          throw new Error("deposit_scan_common_ancestor_missing");
        }
      }
    }
  }

  const fromBlock =
    previousCursorBlock === undefined
      ? defaultStartBlock(confirmedBlock)
      : reorgDetected
        ? commonAncestorBlock! + 1n
        : overlapFromBlock!;
  const maxToBlock =
    reorgDetected || previousCursorBlock === undefined
      ? reorgDetected
        ? confirmedBlock
        : fromBlock + BigInt(config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS) - 1n
      : previousCursorBlock + BigInt(config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS);
  const toBlock = maxToBlock < confirmedBlock ? maxToBlock : confirmedBlock;

  if (toBlock < fromBlock) {
    return {
      fromBlock,
      toBlock,
      scanned: 0,
      credited: 0,
      ignored: 0,
      duplicate: 0,
      duplicateLogs: 0,
      reorgDetected,
      commonAncestorBlock,
      reorged: 0,
      creditedReorged: 0,
      houseFundingReorged: 0,
      incomplete: false,
      treasuryAddressesScanned: treasuryConfigs.map((item) => item.treasuryAddress)
    };
  }

  const fetchedLogs: TransferLog[] = [];
  let incomplete = false;
  let completeToBlock = toBlock;
  let rangeFromBlock = fromBlock;
  while (rangeFromBlock <= toBlock) {
    const rangeToBlock = rangeFromBlock + BigInt(config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS) - 1n < toBlock ? rangeFromBlock + BigInt(config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS) - 1n : toBlock;
    const page = await fetchTransferLogRange({
      fromBlock: rangeFromBlock,
      toBlock: rangeToBlock,
      treasuryConfigs,
      getTransferLogs
    });
    fetchedLogs.push(...page.fetchedLogs);
    if (page.incomplete) {
      incomplete = true;
      completeToBlock = page.completeToBlock < completeToBlock ? page.completeToBlock : completeToBlock;
      break;
    }
    rangeFromBlock = rangeToBlock + 1n;
  }

  const effectiveToBlock = incomplete ? completeToBlock : toBlock;
  const logs = uniqueLogs(fetchedLogs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= effectiveToBlock));
  const duplicateLogs = fetchedLogs.length - logs.length;
  const reorgResult =
    effectiveToBlock >= fromBlock
      ? await markReorgs({
          chainId,
          fromBlock,
          toBlock: effectiveToBlock,
          toAddresses: treasuryConfigs.map((item) => item.treasuryAddress),
          tokenAddresses: treasuryConfigs.map((item) => item.usdcContractAddress),
          canonicalFacts: logs.map((log) => ({
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            blockHash: log.blockHash
          })),
          reason: reorgDetected ? "overlap_block_hash_mismatch" : "overlap_rescan"
        })
        : {
          reorged: 0,
          creditedReorged: 0,
          houseFundingReorged: 0
        };
  reorgDetected = reorgDetected || reorgResult.reorged > 0;

  let credited = 0;
  let ignored = 0;
  let duplicate = 0;
  let activated = 0;
  const activationFailures: Array<{ quoteId: string; userId: string; error: string }> = [];

  for (const log of logs) {
    if (!log.args.from || !log.args.to || log.args.value === undefined) continue;
    const result = await creditDeposit({
      chainId,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash || undefined,
      fromAddress: log.args.from,
      toAddress: log.args.to,
      tokenAddress: log.address,
      amountMicroUnits: log.args.value,
      confirmations: Number(currentBlock - log.blockNumber + 1n),
      raw: {
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber.toString(),
        blockHash: log.blockHash,
        address: log.address,
        from: log.args.from,
        to: log.args.to,
        value: log.args.value.toString()
      }
    } satisfies ConfirmedDepositInput["raw"]);
    if (result.status === "credited" || result.status === "payment_confirmed") credited += 1;
    if (result.status === "payment_confirmed") {
      try {
        await activatePayment({
          quoteId: result.quoteId,
          userId: result.userId
        });
        activated += 1;
      } catch (error) {
        activationFailures.push({
          quoteId: result.quoteId,
          userId: result.userId,
          error: error instanceof Error ? error.message : "activation_failed"
        });
      }
    }
    if (result.status === "ignored") ignored += 1;
    if (result.status === "duplicate") duplicate += 1;
  }

  const retriedActivations = await activateConfirmedPayments();
  activated += retriedActivations.activated;
  activationFailures.push(...retriedActivations.failed);

  if (effectiveToBlock >= fromBlock && (previousCursorBlock === undefined || effectiveToBlock >= previousCursorBlock)) {
    const effectiveToBlockHash = await canonicalBlockHash(effectiveToBlock);
    const observations: ScanBlockObservation[] = [];
    if (overlapBlocks > 0n) {
      const observationFromBlock = laterBlock(minimumStartBlock(), effectiveToBlock - overlapBlocks + 1n);
      for (let blockNumber = observationFromBlock; blockNumber <= effectiveToBlock; blockNumber += 1n) {
        observations.push({
          blockNumber,
          blockHash: await canonicalBlockHash(blockNumber)
        });
      }
    }
    await storeCursor(chainId, cursorName, effectiveToBlock, effectiveToBlockHash, observations);
  }
  return {
    fromBlock,
    toBlock: effectiveToBlock,
    requestedToBlock: toBlock,
    scanned: logs.length,
    credited,
    ignored,
    duplicate,
    duplicateLogs,
    activated,
    activationFailures,
    reorgDetected,
    reorged: reorgResult.reorged,
    creditedReorged: reorgResult.creditedReorged,
    houseFundingReorged: reorgResult.houseFundingReorged,
    commonAncestorBlock,
    incomplete,
    treasuryAddressesScanned: treasuryConfigs.map((item) => item.treasuryAddress)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let shouldStop = false;
  const sleeper = createInterruptibleSleeper();
  const releaseWorkerLease = await acquireWorkerSingletonLease("usdc-deposit-scanner");
  const stopHeartbeat = startWorkerHeartbeat("usdc-deposit-scanner");

  process.on("SIGINT", () => {
    shouldStop = true;
    sleeper.interrupt();
  });
  process.on("SIGTERM", () => {
    shouldStop = true;
    sleeper.interrupt();
  });

  try {
    console.log("USDC deposit scanner worker started");
    while (!shouldStop) {
      try {
        const result = await processUsdcDepositScan();
        const activationFailures = ("activationFailures" in result ? result.activationFailures : undefined) || [];
        if (activationFailures.length > 0) {
          const error = `deposit_activation_failures:${activationFailures.length}`;
          await markWorkerFailure("usdc-deposit-scanner", error);
          console.error(
            stringifyDepositWorkerEvent({
              event: "deposit.scan.error",
              error,
              activationFailures: activationFailures.map((failure) => ({
                quoteId: failure.quoteId,
                error: sanitizeWorkerFailure(failure.error)
              }))
            })
          );
        } else {
          await markWorkerSuccess("usdc-deposit-scanner");
        }
        console.log(
          stringifyDepositWorkerEvent({
            event: "deposit.scan",
            ...result,
            activationFailures: activationFailures.map((failure) => ({
              quoteId: failure.quoteId,
              error: sanitizeWorkerFailure(failure.error)
            }))
          })
        );
      } catch (error) {
        const failure = sanitizeWorkerFailure(error);
        await markWorkerFailure("usdc-deposit-scanner", failure).catch((heartbeatError) => {
          console.error(JSON.stringify({ event: "deposit.scan.health.error", error: sanitizeWorkerFailure(heartbeatError) }));
        });
        console.error(
          JSON.stringify({
            event: "deposit.scan.error",
            error: failure
          })
        );
      }
      await sleeper.sleep(config.USDC_DEPOSIT_POLL_INTERVAL_MS);
    }
  } finally {
    stopHeartbeat();
    await releaseWorkerLease();
    await closePool();
  }
}
