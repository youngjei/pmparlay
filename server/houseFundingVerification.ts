import { getAddress, isAddress, zeroAddress } from "viem";
import { config, SEPOLIA_PAYMENT_CHAIN_ID } from "./config";

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const rpcTimeoutMs = Math.min(config.MARKET_FETCH_TIMEOUT_MS, 10_000);

export type HouseFundingSettings = {
  chainId: number;
  treasurySafeAddress: string;
  usdcContractAddress: string;
  requiredConfirmations: number;
};

export type VerifiedHouseFundingTransfer = {
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  amountMicroUnits: bigint;
  confirmations: number;
  receipt: unknown;
};

export type EthereumRpc = <T>(method: string, params: unknown[]) => Promise<T>;

function normalizeAddress(value: string) {
  if (!isAddress(value)) throw new Error("invalid_evm_address");
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error("invalid_evm_address");
  return address.toLowerCase();
}

function normalizeHash(value: string, error = "invalid_tx_hash") {
  const hash = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(hash)) throw new Error(error);
  return hash;
}

function topicAddress(address: string) {
  return `0x${normalizeAddress(address).slice(2).padStart(64, "0")}`;
}

function parseQuantity(value: string, error: string) {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error(error);
  try {
    return BigInt(value);
  } catch {
    throw new Error(error);
  }
}

function confirmationCount(value: bigint) {
  if (value < 1n || value > BigInt(2_147_483_647)) throw new Error("house_funding_confirmation_count_invalid");
  return Number(value);
}

export function configuredHouseFundingSettings(): HouseFundingSettings {
  if (config.SETTLEMENT_CHAIN_ID !== SEPOLIA_PAYMENT_CHAIN_ID) throw new Error("house_funding_chain_not_sepolia");
  if (!config.TREASURY_SAFE_ADDRESS) throw new Error("house_funding_treasury_safe_missing");
  if (!config.ETHEREUM_RPC_URL) throw new Error("house_funding_rpc_missing");
  return {
    chainId: config.SETTLEMENT_CHAIN_ID,
    treasurySafeAddress: normalizeAddress(config.TREASURY_SAFE_ADDRESS),
    usdcContractAddress: normalizeAddress(config.USDC_CONTRACT_ADDRESS),
    requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
  };
}

async function configuredEthereumRpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!config.ETHEREUM_RPC_URL) throw new Error("house_funding_rpc_missing");
  let response: Response;
  try {
    response = await fetch(config.ETHEREUM_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(rpcTimeoutMs)
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("ethereum_rpc_timeout");
    throw new Error("ethereum_rpc_request_failed");
  }
  if (!response.ok) throw new Error(`ethereum_rpc_http_${response.status}`);
  const payload = (await response.json()) as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message || "ethereum_rpc_error");
  if (payload.result === undefined) throw new Error("ethereum_rpc_result_missing");
  return payload.result;
}

export async function verifyHouseFundingTransfer(input: {
  txHash: string;
  logIndex: number;
  settings?: HouseFundingSettings;
  rpc?: EthereumRpc;
}): Promise<VerifiedHouseFundingTransfer> {
  if (!Number.isSafeInteger(input.logIndex) || input.logIndex < 0) throw new Error("invalid_log_index");
  const settings = input.settings || configuredHouseFundingSettings();
  if (settings.chainId !== SEPOLIA_PAYMENT_CHAIN_ID) throw new Error("house_funding_chain_not_sepolia");
  if (!Number.isInteger(settings.requiredConfirmations) || settings.requiredConfirmations <= 0) {
    throw new Error("house_funding_confirmations_invalid");
  }
  const txHash = normalizeHash(input.txHash);
  const treasurySafeAddress = normalizeAddress(settings.treasurySafeAddress);
  const usdcContractAddress = normalizeAddress(settings.usdcContractAddress);
  const rpc = input.rpc || configuredEthereumRpc;

  const rpcChainId = await rpc<string>("eth_chainId", []);
  if (parseQuantity(rpcChainId, "ethereum_rpc_chain_id_invalid") !== BigInt(settings.chainId)) {
    throw new Error("ethereum_rpc_chain_id_mismatch");
  }

  const receipt = await rpc<{
    status?: string;
    transactionHash?: string;
    blockNumber?: string;
    blockHash?: string;
    logs?: Array<{ address?: string; logIndex?: string; blockNumber?: string; blockHash?: string; topics?: string[]; data?: string }>;
  } | null>("eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("house_funding_tx_not_found");
  if (receipt.status !== "0x1") throw new Error("house_funding_tx_failed");
  if (!receipt.transactionHash || normalizeHash(receipt.transactionHash) !== txHash) throw new Error("house_funding_tx_hash_mismatch");
  if (!receipt.blockNumber || !receipt.blockHash) throw new Error("house_funding_tx_uncanonical");

  const blockNumber = parseQuantity(receipt.blockNumber, "house_funding_block_number_invalid");
  const blockHash = normalizeHash(receipt.blockHash, "house_funding_block_hash_invalid");
  const canonicalBlock = await rpc<{ hash?: string } | null>("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!canonicalBlock?.hash || normalizeHash(canonicalBlock.hash, "house_funding_block_hash_invalid") !== blockHash) {
    throw new Error("house_funding_tx_not_canonical");
  }

  const currentBlock = parseQuantity(await rpc<string>("eth_blockNumber", []), "house_funding_current_block_invalid");
  const confirmations = currentBlock >= blockNumber ? currentBlock - blockNumber + 1n : 0n;
  if (confirmations < BigInt(settings.requiredConfirmations)) throw new Error("house_funding_tx_unfinalized");

  const matchingLogs = (receipt.logs || []).filter((log) => {
    if (!log.logIndex || parseQuantity(log.logIndex, "house_funding_log_index_invalid") !== BigInt(input.logIndex)) return false;
    if (!log.address || normalizeAddress(log.address) !== usdcContractAddress) return false;
    if (!log.blockNumber || parseQuantity(log.blockNumber, "house_funding_log_block_invalid") !== blockNumber) return false;
    if (!log.blockHash || normalizeHash(log.blockHash, "house_funding_log_block_hash_invalid") !== blockHash) return false;
    if (log.topics?.length !== 3 || log.topics[0]?.toLowerCase() !== transferTopic) return false;
    if (!log.topics[1] || !log.topics[2] || !/^0x[0-9a-f]{64}$/i.test(log.topics[1]) || !/^0x[0-9a-f]{64}$/i.test(log.topics[2])) return false;
    return log.topics[2].toLowerCase() === topicAddress(treasurySafeAddress);
  });
  if (matchingLogs.length !== 1) throw new Error("house_funding_transfer_log_mismatch");

  const log = matchingLogs[0];
  const fromAddress = normalizeAddress(`0x${log.topics![1]!.slice(-40)}`);
  if (log.topics![1]!.toLowerCase() !== topicAddress(fromAddress)) throw new Error("house_funding_transfer_log_mismatch");
  if (fromAddress === treasurySafeAddress) throw new Error("house_funding_self_transfer");
  if (!log.data || !/^0x[0-9a-f]{64}$/i.test(log.data)) throw new Error("house_funding_transfer_amount_invalid");
  const amountMicroUnits = BigInt(log.data);
  if (amountMicroUnits <= 0n) throw new Error("house_funding_transfer_amount_invalid");

  return {
    chainId: settings.chainId,
    txHash,
    logIndex: input.logIndex,
    blockNumber,
    blockHash,
    fromAddress,
    toAddress: treasurySafeAddress,
    tokenAddress: usdcContractAddress,
    amountMicroUnits,
    confirmations: confirmationCount(confirmations),
    receipt
  };
}
