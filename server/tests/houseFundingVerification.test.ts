import { describe, expect, it } from "vitest";
import { verifyHouseFundingTransfer, type EthereumRpc } from "../houseFundingVerification";

const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const blockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const safeAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const sourceAddress = "0x1234567890abcdef1234567890abcdef12345678";
const tokenAddress = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function topicAddress(address: string) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function rpcForReceipt(receipt: unknown, currentBlock = "0x75") {
  return (async (method: string) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getTransactionReceipt") return receipt;
    if (method === "eth_getBlockByNumber") return { hash: blockHash };
    if (method === "eth_blockNumber") return currentBlock;
    throw new Error(`unexpected rpc method ${method}`);
  }) as EthereumRpc;
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    status: "0x1",
    transactionHash: txHash,
    blockNumber: "0x64",
    blockHash,
    logs: [
      {
        address: tokenAddress,
        logIndex: "0x7",
        blockNumber: "0x64",
        blockHash,
        topics: [transferTopic, topicAddress(sourceAddress), topicAddress(safeAddress)],
        data: "0x0000000000000000000000000000000000000000000000000020000000000001"
      }
    ],
    ...overrides
  };
}

const settings = {
  chainId: 11155111,
  treasurySafeAddress: safeAddress,
  usdcContractAddress: tokenAddress,
  requiredConfirmations: 12
};

describe("house funding transfer verification", () => {
  it("verifies the canonical selected USDC Transfer log with bigint-exact amount", async () => {
    const verified = await verifyHouseFundingTransfer({ txHash, logIndex: 7, settings, rpc: rpcForReceipt(receipt()) });

    expect(verified).toMatchObject({
      chainId: 11155111,
      txHash,
      logIndex: 7,
      blockHash,
      fromAddress: sourceAddress,
      toAddress: safeAddress,
      tokenAddress,
      confirmations: 18
    });
    expect(verified.amountMicroUnits).toBe(9_007_199_254_740_993n);
  });

  it("rejects a finalized receipt whose selected transfer does not target the configured Safe", async () => {
    const wrongDestinationReceipt = receipt({
      logs: [
        {
          address: tokenAddress,
          logIndex: "0x7",
          blockNumber: "0x64",
          blockHash,
          topics: [transferTopic, topicAddress(sourceAddress), topicAddress("0x9999999999999999999999999999999999999999")],
          data: "0x0000000000000000000000000000000000000000000000000000000000000001"
        }
      ]
    });
    await expect(
      verifyHouseFundingTransfer({ txHash, logIndex: 7, settings, rpc: rpcForReceipt(wrongDestinationReceipt) })
    ).rejects.toThrow("house_funding_transfer_log_mismatch");
  });

  it("rejects a receipt before the configured confirmation depth", async () => {
    await expect(
      verifyHouseFundingTransfer({ txHash, logIndex: 7, settings, rpc: rpcForReceipt(receipt(), "0x6e") })
    ).rejects.toThrow("house_funding_tx_unfinalized");
  });

  it("rejects a Safe self-transfer that does not increase treasury assets", async () => {
    const selfTransferReceipt = receipt({
      logs: [
        {
          address: tokenAddress,
          logIndex: "0x7",
          blockNumber: "0x64",
          blockHash,
          topics: [transferTopic, topicAddress(safeAddress), topicAddress(safeAddress)],
          data: "0x0000000000000000000000000000000000000000000000000000000000000001"
        }
      ]
    });
    await expect(
      verifyHouseFundingTransfer({ txHash, logIndex: 7, settings, rpc: rpcForReceipt(selfTransferReceipt) })
    ).rejects.toThrow("house_funding_self_transfer");
  });
});
