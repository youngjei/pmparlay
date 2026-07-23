import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { createPublicClient, erc20Abi, formatEther, formatUnits, getAddress, http } from "viem";
import { sepolia } from "viem/chains";
import { CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS, config, SEPOLIA_PAYMENT_CHAIN_ID } from "./config";

const burnerFile = path.resolve(".context/sepolia-burner.env");

export function assertBotWalletBalances(ethWei: bigint, usdcMicroUnits: bigint) {
  if (ethWei <= 0n) throw new Error("sepolia_bot_eth_balance_empty");
  if (usdcMicroUnits <= 0n) throw new Error("sepolia_bot_usdc_balance_empty");
}

async function loadBotAddress() {
  const metadata = await stat(burnerFile);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("sepolia_bot_file_permissions_invalid");
  const values = parse(await readFile(burnerFile));
  if (!values.SEPOLIA_BURNER_ADDRESS) throw new Error("sepolia_bot_address_missing");
  return getAddress(values.SEPOLIA_BURNER_ADDRESS);
}

export async function qaSepoliaBotWallet() {
  if (!config.ETHEREUM_RPC_URL) throw new Error("sepolia_rpc_missing");
  if (config.SETTLEMENT_CHAIN_ID !== SEPOLIA_PAYMENT_CHAIN_ID) throw new Error("sepolia_payment_chain_mismatch");
  if (config.USDC_CONTRACT_ADDRESS.toLowerCase() !== CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS.toLowerCase()) {
    throw new Error("sepolia_usdc_contract_mismatch");
  }
  const address = await loadBotAddress();
  const client = createPublicClient({ chain: sepolia, transport: http(config.ETHEREUM_RPC_URL) });
  if ((await client.getChainId()) !== SEPOLIA_PAYMENT_CHAIN_ID) throw new Error("sepolia_rpc_chain_mismatch");
  const [ethWei, usdcMicroUnits] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: getAddress(config.USDC_CONTRACT_ADDRESS),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address]
    })
  ]);
  assertBotWalletBalances(ethWei, usdcMicroUnits);
  return {
    address,
    chainId: SEPOLIA_PAYMENT_CHAIN_ID,
    eth: formatEther(ethWei),
    usdc: formatUnits(usdcMicroUnits, 6),
    usdcContract: getAddress(config.USDC_CONTRACT_ADDRESS)
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  try {
    console.log(JSON.stringify(await qaSepoliaBotWallet(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "sepolia_bot_qa_failed");
    process.exitCode = 1;
  }
}
