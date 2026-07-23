import { describe, expect, it } from "vitest";
import { assertBotWalletBalances } from "../qaSepoliaBotWallet";

describe("Sepolia bot-wallet QA", () => {
  it("requires both gas and Circle test USDC", () => {
    expect(() => assertBotWalletBalances(1n, 1n)).not.toThrow();
    expect(() => assertBotWalletBalances(0n, 1n)).toThrow("sepolia_bot_eth_balance_empty");
    expect(() => assertBotWalletBalances(1n, 0n)).toThrow("sepolia_bot_usdc_balance_empty");
  });
});
