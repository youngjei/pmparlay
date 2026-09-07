import { pathToFileURL } from "node:url";
import { getAddress, isAddress, zeroAddress } from "viem";
import {
  CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS,
  SEPOLIA_PAYMENT_CHAIN_ID,
  config
} from "./config";
import { closePool } from "./db/client";
import { provisionFounderSepoliaShadowVault } from "./db/lpVaultRepository";

export function shadowVaultProvisioningInput(input: {
  accountingMode: string;
  chainId: number;
  treasuryAddress?: string;
  tokenAddress: string;
}) {
  if (input.accountingMode !== "house_book_usdc") throw new Error("shadow_vault_requires_house_book_usdc");
  if (input.chainId !== SEPOLIA_PAYMENT_CHAIN_ID) throw new Error("shadow_vault_requires_sepolia");
  if (!input.treasuryAddress || !isAddress(input.treasuryAddress)) throw new Error("shadow_vault_treasury_required");
  const treasuryAddress = getAddress(input.treasuryAddress);
  if (treasuryAddress === zeroAddress) throw new Error("shadow_vault_treasury_required");
  if (
    !isAddress(input.tokenAddress) ||
    getAddress(input.tokenAddress) !== getAddress(CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS)
  ) {
    throw new Error("shadow_vault_requires_circle_sepolia_usdc");
  }
  return {
    treasuryAddress,
    tokenAddress: getAddress(CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS)
  };
}

export async function provisionConfiguredLpVaultShadow() {
  const input = shadowVaultProvisioningInput({
    accountingMode: config.ACCOUNTING_MODE,
    chainId: config.SETTLEMENT_CHAIN_ID,
    treasuryAddress: config.TREASURY_SAFE_ADDRESS,
    tokenAddress: config.USDC_CONTRACT_ADDRESS
  });
  return provisionFounderSepoliaShadowVault(input);
}

async function main() {
  try {
    const vault = await provisionConfiguredLpVaultShadow();
    console.log(`Provisioned ${vault.vaultKey} at ${vault.treasuryAddress}`);
  } finally {
    await closePool();
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
