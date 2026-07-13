import { getAddress } from "viem";
import { config } from "../config";
import { closePool } from "../db/client";
import { creditConfirmedDeposit, getScanCursor, saveScanCursor, type ConfirmedDepositInput } from "../db/depositRepository";
import { getActiveTreasuryConfig } from "../db/treasuryRepository";
import { activateConfirmedQuotePayment, activateConfirmedQuotePayments } from "../paymentActivation";
import { startWorkerHeartbeat } from "./heartbeat";

const cursorName = "usdc-deposits";
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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

type DepositScannerDependencies = {
  getCurrentBlock?: () => Promise<bigint>;
  getTransferLogs?: (fromBlock: bigint, toBlock: bigint) => Promise<TransferLog[]>;
  creditDeposit?: typeof creditConfirmedDeposit;
  activatePayment?: typeof activateConfirmedQuotePayment;
  activateConfirmedPayments?: typeof activateConfirmedQuotePayments;
  getActiveTreasuryConfig?: typeof getActiveTreasuryConfig;
  getCursor?: typeof getScanCursor;
  saveCursor?: typeof saveScanCursor;
  treasuryConfig?: DepositTreasuryConfig;
};

type DepositTreasuryConfig = {
  chainId: number;
  treasuryAddress: string;
  usdcContractAddress: string;
  requiredConfirmations: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireRpcConfig() {
  if (!config.ETHEREUM_RPC_URL) {
    throw new Error("ETHEREUM_RPC_URL is required for USDC deposit scanning.");
  }
}

async function resolveDepositTreasuryConfig(loadActiveTreasuryConfig = getActiveTreasuryConfig): Promise<DepositTreasuryConfig> {
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

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  requireRpcConfig();
  const response = await fetch(config.ETHEREUM_RPC_URL!, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });

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

export async function processUsdcDepositScan(dependencies: DepositScannerDependencies = {}) {
  const treasuryConfig = dependencies.treasuryConfig || (await resolveDepositTreasuryConfig(dependencies.getActiveTreasuryConfig));
  const chainId = treasuryConfig.chainId;
  const getCurrentBlock = dependencies.getCurrentBlock || getRpcCurrentBlock;
  const getTransferLogs = dependencies.getTransferLogs || ((fromBlock, toBlock) => getRpcTransferLogs(fromBlock, toBlock, treasuryConfig));
  const creditDeposit = dependencies.creditDeposit || creditConfirmedDeposit;
  const activatePayment = dependencies.activatePayment || activateConfirmedQuotePayment;
  const activateConfirmedPayments = dependencies.activateConfirmedPayments || activateConfirmedQuotePayments;
  const loadCursor = dependencies.getCursor || getScanCursor;
  const storeCursor = dependencies.saveCursor || saveScanCursor;

  const currentBlock = await getCurrentBlock();
  const confirmedBlock =
    currentBlock >= BigInt(treasuryConfig.requiredConfirmations) ? currentBlock - BigInt(treasuryConfig.requiredConfirmations) + 1n : 0n;
  const previousCursor = await loadCursor(chainId, cursorName);
  const fromBlock = previousCursor === undefined ? defaultStartBlock(confirmedBlock) : previousCursor + 1n;
  const maxToBlock = fromBlock + BigInt(config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS) - 1n;
  const toBlock = maxToBlock < confirmedBlock ? maxToBlock : confirmedBlock;

  if (toBlock < fromBlock) {
    return {
      fromBlock,
      toBlock,
      scanned: 0,
      credited: 0,
      ignored: 0
    };
  }

  const logs = await getTransferLogs(fromBlock, toBlock);
  let credited = 0;
  let ignored = 0;
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
  }

  const retriedActivations = await activateConfirmedPayments();
  activated += retriedActivations.activated;
  activationFailures.push(...retriedActivations.failed);

  await storeCursor(chainId, cursorName, toBlock);
  return {
    fromBlock,
    toBlock,
    scanned: logs.length,
    credited,
    ignored,
    activated,
    activationFailures
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let shouldStop = false;
  const stopHeartbeat = startWorkerHeartbeat("usdc-deposit-scanner");

  process.on("SIGINT", () => {
    shouldStop = true;
  });
  process.on("SIGTERM", () => {
    shouldStop = true;
  });

  try {
    console.log("USDC deposit scanner worker started");
    while (!shouldStop) {
      try {
        const result = await processUsdcDepositScan();
        console.log(JSON.stringify({ event: "deposit.scan", ...result, fromBlock: result.fromBlock.toString(), toBlock: result.toBlock.toString() }));
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "deposit.scan.error",
            error: error instanceof Error ? error.message : "deposit_scan_failed"
          })
        );
      }
      await sleep(config.USDC_DEPOSIT_POLL_INTERVAL_MS);
    }
  } finally {
    stopHeartbeat();
    await closePool();
  }
}
