import { describe, expect, it } from "vitest";
import { config } from "../config";
import { processUsdcDepositScan } from "../workers/usdcDepositScannerWorker";

describe("USDC deposit scanner worker", () => {
  it("scans only confirmed blocks, credits logs, and advances the cursor", async () => {
    const credited: Array<{ txHash: string; confirmations: number; amount: string }> = [];
    const activations: Array<{ quoteId: string; userId: string }> = [];
    let savedCursor: bigint | undefined;
    const currentBlock = 120n;
    const expectedToBlock = currentBlock - BigInt(config.USDC_REQUIRED_CONFIRMATIONS) + 1n;

    const result = await processUsdcDepositScan({
      treasuryConfig: {
        chainId: config.SETTLEMENT_CHAIN_ID,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
      },
      getCurrentBlock: async () => currentBlock,
      getCursor: async () => 100n,
      saveCursor: async (_chainId, _cursorName, block) => {
        savedCursor = block;
      },
      getTransferLogs: async (fromBlock, toBlock) => {
        expect(fromBlock).toBe(101n);
        expect(toBlock).toBe(expectedToBlock);
        return [
          {
            transactionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
            logIndex: 7,
            blockNumber: 108n,
            blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            args: {
              from: "0x1234567890abcdef1234567890abcdef12345678",
              to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              value: 25_000_000n
            }
          }
        ];
      },
      creditDeposit: async (input) => {
        credited.push({
          txHash: input.txHash,
          confirmations: input.confirmations,
          amount: input.amountMicroUnits.toString()
        });
        return {
          id: "deposit-test",
          status: "payment_confirmed",
          paymentIntentId: "payment-intent-test",
          quoteId: "quote-test",
          userId: "00000000-0000-0000-0000-000000000001",
          walletId: "wallet-test",
          ledgerTransactionId: "ledger-test"
        };
      },
      activatePayment: async (input) => {
        activations.push(input);
        return {
          ticketId: "ticket-test",
          quoteId: input.quoteId,
          status: "accepted",
          ledgerTransactionId: "ledger-test",
          accountingMode: "house_book_usdc",
          currency: "USDC"
        };
      },
      activateConfirmedPayments: async () => {
        return {
          scanned: 0,
          activated: 0,
          failed: []
        };
      }
    });

    expect(result).toMatchObject({
      scanned: 1,
      credited: 1,
      ignored: 0,
      activated: 1,
      activationFailures: []
    });
    expect(result.fromBlock).toBe(101n);
    expect(result.toBlock).toBe(expectedToBlock);
    expect(savedCursor).toBe(expectedToBlock);
    expect(credited).toEqual([
      {
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        confirmations: 13,
        amount: "25000000"
      }
    ]);
    expect(activations).toEqual([
      {
        quoteId: "quote-test",
        userId: "00000000-0000-0000-0000-000000000001"
      }
    ]);
  });

  it("keeps scanning when quote payment activation needs a later retry", async () => {
    const result = await processUsdcDepositScan({
      treasuryConfig: {
        chainId: config.SETTLEMENT_CHAIN_ID,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
      },
      getCurrentBlock: async () => 120n,
      getCursor: async () => 100n,
      saveCursor: async () => {},
      getTransferLogs: async () => [
        {
          transactionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
          logIndex: 7,
          blockNumber: 108n,
          blockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          args: {
            from: "0x1234567890abcdef1234567890abcdef12345678",
            to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            value: 25_000_000n
          }
        }
      ],
      creditDeposit: async () => ({
        id: "deposit-test",
        status: "payment_confirmed",
        paymentIntentId: "payment-intent-test",
        quoteId: "quote-test",
        userId: "00000000-0000-0000-0000-000000000001",
        walletId: "wallet-test",
        ledgerTransactionId: "ledger-test"
      }),
      activatePayment: async () => {
        throw new Error("insufficient_house_reserve");
      },
      activateConfirmedPayments: async () => ({
        scanned: 1,
        activated: 0,
        failed: [{ quoteId: "quote-test", userId: "00000000-0000-0000-0000-000000000001", error: "insufficient_house_reserve" }]
      })
    });

    expect(result).toMatchObject({
      scanned: 1,
      credited: 1,
      ignored: 0,
      activated: 0
    });
    expect(result.activationFailures).toEqual([
      { quoteId: "quote-test", userId: "00000000-0000-0000-0000-000000000001", error: "insufficient_house_reserve" },
      { quoteId: "quote-test", userId: "00000000-0000-0000-0000-000000000001", error: "insufficient_house_reserve" }
    ]);
  });

  it("uses the active treasury config for scan chain and confirmation depth", async () => {
    const credited: Array<{ chainId: number; confirmations: number }> = [];
    let cursorChainId: number | undefined;
    let savedChainId: number | undefined;

    const result = await processUsdcDepositScan({
      getActiveTreasuryConfig: async () => ({
        id: "treasury-config-test",
        chainId: 11155111,
        currency: "USDC",
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        requiredConfirmations: 3,
        updatedAt: "2026-07-08T00:00:00.000Z"
      }),
      getCurrentBlock: async () => 120n,
      getCursor: async (chainId) => {
        cursorChainId = chainId;
        return 116n;
      },
      saveCursor: async (chainId) => {
        savedChainId = chainId;
      },
      getTransferLogs: async (fromBlock, toBlock) => {
        expect(fromBlock).toBe(117n);
        expect(toBlock).toBe(118n);
        return [
          {
            transactionHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
            logIndex: 1,
            blockNumber: 118n,
            blockHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
            address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            args: {
              from: "0x1234567890abcdef1234567890abcdef12345678",
              to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              value: 25_000_000n
            }
          }
        ];
      },
      creditDeposit: async (input) => {
        credited.push({
          chainId: input.chainId,
          confirmations: input.confirmations
        });
        return {
          id: "deposit-test",
          status: "ignored"
        };
      },
      activateConfirmedPayments: async () => ({
        scanned: 0,
        activated: 0,
        failed: []
      })
    });

    expect(result).toMatchObject({
      scanned: 1,
      credited: 0,
      ignored: 1
    });
    expect(cursorChainId).toBe(11155111);
    expect(savedChainId).toBe(11155111);
    expect(credited).toEqual([{ chainId: 11155111, confirmations: 3 }]);
  });
});
