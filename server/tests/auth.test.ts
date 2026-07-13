import { describe, expect, it } from "vitest";
import { parsePrivyChainId, privyWalletsFromLinkedAccounts } from "../auth";
import { config } from "../config";

describe("Privy auth helpers", () => {
  it("parses numeric and CAIP-2 chain ids", () => {
    expect(parsePrivyChainId("1")).toBe(1);
    expect(parsePrivyChainId(11155111)).toBe(11155111);
    expect(parsePrivyChainId("eip155:1")).toBe(1);
    expect(parsePrivyChainId("eip155:8453")).toBe(8453);
  });

  it("rejects blank, zero, and malformed chain ids", () => {
    expect(parsePrivyChainId("")).toBeUndefined();
    expect(parsePrivyChainId("0")).toBeUndefined();
    expect(parsePrivyChainId("eip155:not-a-number")).toBeUndefined();
    expect(parsePrivyChainId(undefined)).toBeUndefined();
  });

  it("normalizes Privy embedded wallet chain fallback without producing chain zero", () => {
    const wallets = privyWalletsFromLinkedAccounts([
      {
        type: "wallet",
        chain_type: "ethereum",
        address: "0x1234567890AbcdEF1234567890aBcdef12345678",
        chain_id: ""
      }
    ]);

    expect(wallets).toEqual([
      {
        address: "0x1234567890abcdef1234567890abcdef12345678",
        chainId: config.SETTLEMENT_CHAIN_ID,
        source: "privy"
      }
    ]);
  });

  it("syncs EVM smart wallets and ignores non-EVM accounts", () => {
    const wallets = privyWalletsFromLinkedAccounts([
      {
        type: "smart_wallet",
        address: "0x1234567890AbcdEF1234567890aBcdef12345678"
      },
      {
        type: "wallet",
        chain_type: "solana",
        address: "So11111111111111111111111111111111111111112"
      }
    ]);

    expect(wallets).toEqual([
      {
        address: "0x1234567890abcdef1234567890abcdef12345678",
        chainId: config.SETTLEMENT_CHAIN_ID,
        source: "privy"
      }
    ]);
  });

  it("stores valid EVM linked wallets on the configured settlement chain", () => {
    const wallets = privyWalletsFromLinkedAccounts([
      {
        type: "wallet",
        address: "0xCe59C7004182098fc430c204e9cd1474Be9EE492",
        chain_id: 1
      }
    ]);

    expect(wallets).toEqual([
      {
        address: "0xce59c7004182098fc430c204e9cd1474be9ee492",
        chainId: config.SETTLEMENT_CHAIN_ID,
        source: "privy"
      }
    ]);
  });
});
