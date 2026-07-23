import { getAddress, zeroAddress } from "viem";
import { config } from "./config";

export function usesStaticStagingTreasury() {
  return config.NODE_ENV === "production";
}

export function staticStagingTreasuryConfig() {
  if (!config.TREASURY_SAFE_ADDRESS) throw new Error("TREASURY_SAFE_ADDRESS is required for supervised staging.");
  const treasuryAddress = getAddress(config.TREASURY_SAFE_ADDRESS);
  if (treasuryAddress === zeroAddress) throw new Error("TREASURY_SAFE_ADDRESS must not be the zero address.");
  return {
    chainId: config.SETTLEMENT_CHAIN_ID,
    currency: "USDC" as const,
    treasuryAddress,
    usdcContractAddress: getAddress(config.USDC_CONTRACT_ADDRESS),
    requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS,
    active: true
  };
}
