import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { classifyDepositScanResult, processUsdcDepositScan, stringifyDepositWorkerEvent } from "../workers/usdcDepositScannerWorker";

const originalScannerConfig = {
  ETHEREUM_RPC_URL: config.ETHEREUM_RPC_URL,
  USDC_DEPOSIT_SCAN_BATCH_BLOCKS: config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS,
  USDC_DEPOSIT_RPC_LOG_PAGE_BLOCKS: config.USDC_DEPOSIT_RPC_LOG_PAGE_BLOCKS,
  USDC_DEPOSIT_RPC_MIN_INTERVAL_MS: config.USDC_DEPOSIT_RPC_MIN_INTERVAL_MS
};

afterEach(() => {
  Object.assign(config, originalScannerConfig);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("USDC deposit scanner worker", () => {
  it("serializes bigint scan boundaries in structured logs", () => {
    expect(JSON.parse(stringifyDepositWorkerEvent({ event: "deposit.scan", fromBlock: 100n, requestedToBlock: 120n }))).toEqual({
      event: "deposit.scan",
      fromBlock: "100",
      requestedToBlock: "120"
    });
  });

  it("fails closed before scanning when the RPC chain differs from settlement", async () => {
    let getCurrentBlockCalled = false;
    await expect(
      processUsdcDepositScan({
        treasuryConfig: {
          chainId: config.SETTLEMENT_CHAIN_ID,
          treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
        },
        getChainId: async () => "0x1",
        getCurrentBlock: async () => {
          getCurrentBlockCalled = true;
          return 120n;
        }
      })
    ).rejects.toThrow("ethereum_rpc_chain_id_mismatch");
    expect(getCurrentBlockCalled).toBe(false);
  });

  it("fails closed before scanning when the RPC chain is unavailable", async () => {
    await expect(
      processUsdcDepositScan({
        treasuryConfig: {
          chainId: config.SETTLEMENT_CHAIN_ID,
          treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
        },
        getChainId: async () => {
          throw new Error("ethereum_rpc_request_failed");
        },
        getCurrentBlock: async () => 120n
      })
    ).rejects.toThrow("ethereum_rpc_request_failed");
  });

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
      getBlockHash: async () => "0x9999999999999999999999999999999999999999999999999999999999999999",
      overlapBlocks: 0n,
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
      getBlockHash: async () => "0x9999999999999999999999999999999999999999999999999999999999999999",
      overlapBlocks: 0n,
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
      treasuryConfigs: [
        {
          id: "treasury-config-test",
          chainId: 11155111,
          currency: "USDC",
          treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          requiredConfirmations: 3,
          active: true
        }
      ],
      getCurrentBlock: async () => 120n,
      getCursor: async (chainId) => {
        cursorChainId = chainId;
        return 116n;
      },
      getBlockHash: async () => "0x9999999999999999999999999999999999999999999999999999999999999999",
      overlapBlocks: 0n,
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

  it("deduplicates duplicate logs before crediting deposits", async () => {
    let creditCalls = 0;
    const duplicatedLog = {
      transactionHash: "0x6666666666666666666666666666666666666666666666666666666666666666" as const,
      logIndex: 2,
      blockNumber: 108n,
      blockHash: "0x7777777777777777777777777777777777777777777777777777777777777777" as const,
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const,
      args: {
        from: "0x1234567890abcdef1234567890abcdef12345678" as const,
        to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const,
        value: 10_000_000n
      }
    };

    const result = await processUsdcDepositScan({
      treasuryConfig: {
        chainId: config.SETTLEMENT_CHAIN_ID,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
      },
      getCurrentBlock: async () => 120n,
      getCursor: async () => 100n,
      getBlockHash: async () => "0x9999999999999999999999999999999999999999999999999999999999999999",
      overlapBlocks: 0n,
      saveCursor: async () => {},
      getTransferLogs: async () => [duplicatedLog, duplicatedLog],
      creditDeposit: async () => {
        creditCalls += 1;
        return {
          id: "deposit-test",
          status: "credited",
          userId: "00000000-0000-0000-0000-000000000001",
          walletId: "wallet-test",
          ledgerTransactionId: "ledger-test"
        };
      },
      activateConfirmedPayments: async () => ({
        scanned: 0,
        activated: 0,
        failed: []
      })
    });

    expect(result.scanned).toBe(1);
    expect(result.duplicateLogs).toBe(1);
    expect(creditCalls).toBe(1);
  });

  it("rescans configured overlap blocks on a normal cycle without reducing forward progress", async () => {
    let fetchedRange: [bigint, bigint] | undefined;
    let reconciledRange: [bigint, bigint] | undefined;

    const result = await processUsdcDepositScan({
      treasuryConfig: {
        chainId: 11155111,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        requiredConfirmations: 3
      },
      overlapBlocks: 5n,
      getCurrentBlock: async () => 110n,
      getCursor: async () => ({
        lastScannedBlock: 100n,
        lastScannedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      listScanBlockObservations: async () => [
        { blockNumber: 96n, blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { blockNumber: 97n, blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { blockNumber: 98n, blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { blockNumber: 99n, blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      ],
      getBlockHash: async () => "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      getTransferLogs: async (fromBlock, toBlock) => {
        fetchedRange = [fromBlock, toBlock];
        return [];
      },
      markReorgedDeposits: async (input) => {
        reconciledRange = [input.fromBlock, input.toBlock];
        return { reorged: 0, creditedReorged: 0, houseFundingReorged: 0 };
      },
      saveCursor: async () => {},
      activateConfirmedPayments: async () => ({ scanned: 0, activated: 0, failed: [] })
    });

    expect(fetchedRange).toEqual([96n, 108n]);
    expect(reconciledRange).toEqual([96n, 108n]);
    expect(result).toMatchObject({ fromBlock: 96n, toBlock: 108n, reorgDetected: false });
  });

  it("finds a common ancestor before marking orphaned reorg logs", async () => {
    let reorgReason: string | undefined;
    let cursorHashChecks = 0;
    let ancestorHashChecks = 0;

    const result = await processUsdcDepositScan({
      treasuryConfig: {
        chainId: config.SETTLEMENT_CHAIN_ID,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
      },
      getCurrentBlock: async () => 120n,
      getCursor: async () => ({
        lastScannedBlock: 100n,
        lastScannedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      getBlockHash: async (blockNumber) => {
        cursorHashChecks += blockNumber === 100n ? 1 : 0;
        ancestorHashChecks += blockNumber === 90n ? 1 : 0;
        if (blockNumber === 90n) return "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
      listScanBlockObservations: async () => [
        {
          blockNumber: 90n,
          blockHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        }
      ],
      saveCursor: async () => {},
      getTransferLogs: async () => [
        {
          transactionHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
          logIndex: 4,
          blockNumber: 99n,
          blockHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          args: {
            from: "0x1234567890abcdef1234567890abcdef12345678",
            to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            value: 10_000_000n
          }
        }
      ],
      markReorgedDeposits: async (input) => {
        reorgReason = input.reason;
        expect(input.fromBlock).toBe(91n);
        expect(input.toBlock).toBe(120n - BigInt(config.USDC_REQUIRED_CONFIRMATIONS) + 1n);
        return {
          reorged: 1,
          creditedReorged: 1,
          houseFundingReorged: 0
        };
      },
      creditDeposit: async () => ({
        id: "deposit-test",
        status: "duplicate",
        ledgerTransactionId: "ledger-test"
      }),
      activateConfirmedPayments: async () => ({
        scanned: 0,
        activated: 0,
        failed: []
      })
    });

    expect(result.reorgDetected).toBe(true);
    expect(result.reorged).toBe(1);
    expect(result.creditedReorged).toBe(1);
    expect(result.duplicate).toBe(1);
    expect(result.commonAncestorBlock).toBe(90n);
    expect(reorgReason).toBe("overlap_block_hash_mismatch");
    expect(cursorHashChecks).toBe(1);
    expect(ancestorHashChecks).toBe(1);
  });

  it("rescans the configured overlap and detects a below-tip orphan while the cursor tip remains canonical", async () => {
    const scannedRanges: Array<[bigint, bigint]> = [];
    const savedObservations: Array<{ blockNumber: bigint; blockHash: string }> = [];
    let reorgInput: Parameters<
      NonNullable<NonNullable<Parameters<typeof processUsdcDepositScan>[0]>["markReorgedDeposits"]>
    >[0] | undefined;

    const result = await processUsdcDepositScan({
      treasuryConfig: {
        chainId: 11155111,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        requiredConfirmations: 3
      },
      overlapBlocks: 5n,
      getCurrentBlock: async () => 110n,
      getCursor: async () => ({
        lastScannedBlock: 100n,
        lastScannedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }),
      listScanBlockObservations: async () => [
        {
          blockNumber: 98n,
          blockHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        {
          blockNumber: 97n,
          blockHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        }
      ],
      getBlockHash: async (blockNumber) => {
        if (blockNumber === 100n) return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if (blockNumber === 98n) return "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        if (blockNumber === 97n) return "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        return "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      },
      getTransferLogs: async (fromBlock, toBlock) => {
        scannedRanges.push([fromBlock, toBlock]);
        return [];
      },
      markReorgedDeposits: async (input) => {
        reorgInput = input;
        return { reorged: 1, creditedReorged: 1, houseFundingReorged: 0 };
      },
      saveCursor: async (_chainId, _cursorName, _block, _hash, observations) => {
        savedObservations.push(...(observations || []));
      },
      activateConfirmedPayments: async () => ({ scanned: 0, activated: 0, failed: [] })
    });

    expect(scannedRanges).toEqual([[98n, 108n]]);
    expect(reorgInput).toMatchObject({
      fromBlock: 98n,
      toBlock: 108n,
      reason: "overlap_block_hash_mismatch"
    });
    expect(result).toMatchObject({
      reorgDetected: true,
      commonAncestorBlock: 97n,
      reorged: 1,
      creditedReorged: 1,
      houseFundingReorged: 0
    });
    expect(savedObservations.map((observation) => observation.blockNumber)).toEqual([104n, 105n, 106n, 107n, 108n]);
  });

  it("blocks operations and stops when no common ancestor exists in the overlap lookback", async () => {
    let incidentInput: Parameters<
      NonNullable<NonNullable<Parameters<typeof processUsdcDepositScan>[0]>["blockForMissingAncestor"]>
    >[0] | undefined;
    let fetchedLogs = false;
    let savedCursor = false;

    await expect(
      processUsdcDepositScan({
        treasuryConfig: {
          chainId: 11155111,
          treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          requiredConfirmations: 3
        },
        overlapBlocks: 5n,
        getCurrentBlock: async () => 110n,
        getCursor: async () => ({
          lastScannedBlock: 100n,
          lastScannedBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }),
        listScanBlockObservations: async () => [
          { blockNumber: 96n, blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          { blockNumber: 97n, blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          { blockNumber: 98n, blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          { blockNumber: 99n, blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
        ],
        getBlockHash: async () => "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        blockForMissingAncestor: async (input) => {
          incidentInput = input;
          return { incidentId: "00000000-0000-0000-0000-000000000099" };
        },
        getTransferLogs: async () => {
          fetchedLogs = true;
          return [];
        },
        saveCursor: async () => {
          savedCursor = true;
        }
      })
    ).rejects.toThrow("deposit_scan_common_ancestor_missing");

    expect(incidentInput).toMatchObject({
      chainId: 11155111,
      cursorName: "usdc-deposits",
      previousCursorBlock: 100n,
      lookbackFromBlock: 96n
    });
    expect(incidentInput?.mismatchedBlocks).toEqual([96n, 97n, 98n, 99n, 100n]);
    expect(fetchedLogs).toBe(false);
    expect(savedCursor).toBe(false);
  });

  it("does not advance the cursor past an incomplete RPC range", async () => {
    let savedCursor: bigint | undefined;
    const result = await processUsdcDepositScan({
      treasuryConfig: {
        chainId: config.SETTLEMENT_CHAIN_ID,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
      },
      getCurrentBlock: async () => 120n,
      getCursor: async () => 100n,
      getBlockHash: async () => "0x9999999999999999999999999999999999999999999999999999999999999999",
      overlapBlocks: 0n,
      saveCursor: async (_chainId, _cursorName, block) => {
        savedCursor = block;
      },
      getTransferLogs: async () => ({
        logs: [],
        complete: false,
        completeToBlock: 105n
      }),
      activateConfirmedPayments: async () => ({
        scanned: 0,
        activated: 0,
        failed: []
      })
    });

    expect(result.incomplete).toBe(true);
    expect(result.requestedToBlock).toBe(120n - BigInt(config.USDC_REQUIRED_CONFIRMATIONS) + 1n);
    expect(result.toBlock).toBe(105n);
    expect(savedCursor).toBe(105n);
  });

  it("scans active plus retired treasury addresses so rotation does not strand deposits", async () => {
    const scannedTreasuries: string[] = [];
    const creditedToAddresses: string[] = [];

    const result = await processUsdcDepositScan({
      treasuryConfigs: [
        {
          id: "active-treasury",
          chainId: 11155111,
          currency: "USDC",
          treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          requiredConfirmations: 3,
          active: true
        },
        {
          id: "retired-treasury",
          chainId: 11155111,
          currency: "USDC",
          treasuryAddress: "0x1111111111111111111111111111111111111111",
          usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          requiredConfirmations: 3,
          active: false
        }
      ],
      getCurrentBlock: async () => 120n,
      getCursor: async () => 116n,
      getBlockHash: async () => "0x9999999999999999999999999999999999999999999999999999999999999999",
      overlapBlocks: 0n,
      saveCursor: async () => {},
      getTransferLogs: async (_fromBlock, _toBlock, treasuryConfig) => {
        scannedTreasuries.push(treasuryConfig.treasuryAddress);
        return [
          {
            transactionHash:
              treasuryConfig.active === false
                ? "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                : "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            logIndex: treasuryConfig.active === false ? 2 : 1,
            blockNumber: 118n,
            blockHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
            address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            args: {
              from: "0x1234567890abcdef1234567890abcdef12345678",
              to: treasuryConfig.treasuryAddress as `0x${string}`,
              value: 10_000_000n
            }
          }
        ];
      },
      creditDeposit: async (input) => {
        creditedToAddresses.push(input.toAddress);
        return {
          id: `deposit-${creditedToAddresses.length}`,
          status: "credited",
          userId: "00000000-0000-0000-0000-000000000001",
          walletId: "wallet-test",
          ledgerTransactionId: "ledger-test"
        };
      },
      activateConfirmedPayments: async () => ({
        scanned: 0,
        activated: 0,
        failed: []
      })
    });

    expect(result.scanned).toBe(2);
    expect(scannedTreasuries).toEqual([
      "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD",
      "0x1111111111111111111111111111111111111111"
    ]);
    expect(creditedToAddresses).toEqual([
      "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD",
      "0x1111111111111111111111111111111111111111"
    ]);
  });
});

describe("bounded deposit catch-up", () => {
  const hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
  const changedHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
  type Dependencies = NonNullable<Parameters<typeof processUsdcDepositScan>[0]>;

  function dependencies(overrides: Dependencies = {}): Dependencies {
    return {
      treasuryConfig: {
        chainId: config.SETTLEMENT_CHAIN_ID,
        treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        requiredConfirmations: 3
      },
      getCurrentBlock: async () => 5_000n,
      getCursor: async () => ({ lastScannedBlock: 100n, lastScannedBlockHash: hash }),
      getBlockHash: async () => hash,
      listScanBlockObservations: async () => Array.from({ length: 24 }, (_, i) => ({ blockNumber: 77n + BigInt(i), blockHash: hash })),
      getTransferLogs: async () => [],
      markReorgedDeposits: vi.fn(async () => ({ reorged: 0, creditedReorged: 0, houseFundingReorged: 0 })),
      creditDeposit: vi.fn(),
      saveCursor: vi.fn(),
      activateConfirmedPayments: async () => ({ scanned: 0, activated: 0, failed: [] }),
      ...overrides
    };
  }

  it("pages a 2000-block forward window plus overlap contiguously in at most 10-block queries for every treasury", async () => {
    config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS = 2_000;
    config.USDC_DEPOSIT_RPC_LOG_PAGE_BLOCKS = 10;
    const ranges: Array<[bigint, bigint, string]> = [];
    const base = dependencies();
    const active = base.treasuryConfig!;
    const retired = { ...active, treasuryAddress: "0x1111111111111111111111111111111111111111" };
    const getBlockHash = vi.fn(async () => hash);
    const result = await processUsdcDepositScan({
      ...base,
      treasuryConfigs: [active, retired],
      getBlockHash,
      getTransferLogs: async (from, to, treasury) => {
        ranges.push([from, to, treasury.treasuryAddress.toLowerCase()]);
        return [];
      }
    });

    for (const treasury of [active, retired]) {
      const pages = ranges.filter((range) => range[2] === treasury.treasuryAddress.toLowerCase());
      expect(pages).toHaveLength(203);
      expect(pages[0].slice(0, 2)).toEqual([77n, 86n]);
      expect(pages.at(-1)!.slice(0, 2)).toEqual([2097n, 2100n]);
      pages.forEach(([from, to], i) => {
        expect(to - from + 1n).toBeLessThanOrEqual(10n);
        if (i > 0) expect(from).toBe(pages[i - 1][1] + 1n);
      });
    }
    expect(getBlockHash).toHaveBeenCalledTimes(48);
    expect(base.saveCursor).toHaveBeenCalledWith(config.SETTLEMENT_CHAIN_ID, "usdc-deposits", 2100n, hash, expect.any(Array));
    expect(result).toMatchObject({ fromBlock: 77n, toBlock: 2100n, backlogBlocks: 2898n, caughtUp: false });
    expect(classifyDepositScanResult(result)).toMatchObject({ healthy: false, failure: "deposit_scan_backlog:2898", pollIntervalMs: 1000 });
  });

  it("does not write deposits, reorgs, or cursor when a later RPC page fails", async () => {
    config.USDC_DEPOSIT_RPC_LOG_PAGE_BLOCKS = 10;
    let pages = 0;
    const base = dependencies({
      getTransferLogs: async () => {
        if (++pages === 3) throw new Error("ethereum_rpc_http_429");
        return [];
      }
    });
    await expect(processUsdcDepositScan(base)).rejects.toThrow("ethereum_rpc_http_429");
    expect(pages).toBe(3);
    expect(base.saveCursor).not.toHaveBeenCalled();
    expect(base.creditDeposit).not.toHaveBeenCalled();
    expect(base.markReorgedDeposits).not.toHaveBeenCalled();
  });

  it("caps reorg replay at 2000 blocks without skipping the saved cursor", async () => {
    config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS = 2_000;
    config.USDC_DEPOSIT_RPC_LOG_PAGE_BLOCKS = 10;
    const base = dependencies({ getBlockHash: async (block) => block === 100n ? changedHash : hash });
    const result = await processUsdcDepositScan(base);
    expect(result).toMatchObject({ reorgDetected: true, commonAncestorBlock: 99n, fromBlock: 100n, toBlock: 2099n, caughtUp: false, backlogBlocks: 2899n });
    expect(base.markReorgedDeposits).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 100n, toBlock: 2099n, reason: "overlap_block_hash_mismatch" }));
    expect(base.saveCursor).toHaveBeenCalledWith(config.SETTLEMENT_CHAIN_ID, "usdc-deposits", 2099n, hash, expect.any(Array));
  });

  it("leaves cursor and reorg evidence untouched if the logical window cannot replay through the saved cursor", async () => {
    config.USDC_DEPOSIT_SCAN_BATCH_BLOCKS = 10;
    const getTransferLogs = vi.fn(async () => []);
    const base = dependencies({
      getBlockHash: async (block) => block >= 78n ? changedHash : hash,
      getTransferLogs
    });
    await expect(processUsdcDepositScan(base)).rejects.toThrow("deposit_scan_reorg_window_too_small");
    expect(getTransferLogs).not.toHaveBeenCalled();
    expect(base.markReorgedDeposits).not.toHaveBeenCalled();
    expect(base.saveCursor).not.toHaveBeenCalled();
  });

  it("leaves reorg evidence untouched when incomplete pages do not cover the saved cursor", async () => {
    const base = dependencies({
      getBlockHash: async (block) => block >= 90n ? changedHash : hash,
      getTransferLogs: async () => ({ logs: [], complete: false, completeToBlock: 95n })
    });
    await expect(processUsdcDepositScan(base)).rejects.toThrow("deposit_scan_reorg_replay_incomplete");
    expect(base.markReorgedDeposits).not.toHaveBeenCalled();
    expect(base.saveCursor).not.toHaveBeenCalled();
  });

  it("reports caught up only after reaching the confirmed head", async () => {
    const result = await processUsdcDepositScan(dependencies({ getCurrentBlock: async () => 120n }));
    expect(result).toMatchObject({ toBlock: 118n, caughtUp: true, backlogBlocks: 0n });
    expect(classifyDepositScanResult(result)).toEqual({ healthy: true, failure: undefined, pollIntervalMs: 30000 });
  });

  it("reports no-op scans at an already saved head as caught up", async () => {
    const result = await processUsdcDepositScan(dependencies({ getCurrentBlock: async () => 102n, overlapBlocks: 0n }));
    expect(result).toMatchObject({ scanned: 0, caughtUp: true, backlogBlocks: 0n });
    expect(classifyDepositScanResult(result).healthy).toBe(true);
  });

  it("does not mark incomplete scans healthy even if the previous cursor is at head", async () => {
    const result = await processUsdcDepositScan(dependencies({
      getCurrentBlock: async () => 102n,
      getTransferLogs: async () => ({ logs: [], complete: false })
    }));
    expect(result).toMatchObject({ caughtUp: false, backlogBlocks: 0n, incomplete: true });
    expect(classifyDepositScanResult(result)).toEqual({ healthy: false, failure: "deposit_scan_incomplete", pollIntervalMs: 30000 });
  });

  it("uses normal polling for errors and activation failures, and never classifies a backlog as healthy", () => {
    expect(classifyDepositScanResult()).toEqual({ healthy: false, failure: "deposit_scan_failed", pollIntervalMs: 30000 });
    expect(classifyDepositScanResult({ caughtUp: true, backlogBlocks: 1n, incomplete: false }).healthy).toBe(false);
    expect(classifyDepositScanResult({ caughtUp: false, backlogBlocks: 10n, incomplete: true }).pollIntervalMs).toBe(30000);
    expect(classifyDepositScanResult({ caughtUp: true, backlogBlocks: 0n, incomplete: false, activationFailures: [{}] })).toEqual({
      healthy: false, failure: "deposit_activation_failures:1", pollIntervalMs: 30000
    });
  });

  it("paces every real RPC method across successive scans, including failed requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    config.ETHEREUM_RPC_URL = "https://rpc.example.test";
    config.USDC_DEPOSIT_RPC_MIN_INTERVAL_MS = 200;
    const starts: Array<{ method: string; at: number }> = [];
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const { method } = JSON.parse(init.body);
      starts.push({ method, at: Date.now() });
      if (method === "eth_getLogs" && fail) {
        fail = false;
        return { ok: false, status: 429 };
      }
      return { ok: true, json: async () => ({ result: method === "eth_chainId" ? `0x${config.SETTLEMENT_CHAIN_ID.toString(16)}` : method === "eth_blockNumber" ? "0x78" : method === "eth_getLogs" ? [] : { hash } }) };
    }));
    const base = dependencies({ getCurrentBlock: undefined, getBlockHash: undefined, getTransferLogs: undefined });
    const failed = expect(processUsdcDepositScan(base)).rejects.toThrow("ethereum_rpc_http_429");
    await vi.runAllTimersAsync();
    await failed;
    const scan = processUsdcDepositScan(base);
    await vi.runAllTimersAsync();
    await scan;
    expect(new Set(starts.map(({ method }) => method))).toEqual(new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"]));
    starts.forEach(({ at }, i) => { if (i > 0) expect(at - starts[i - 1].at).toBeGreaterThanOrEqual(200); });
  });
});
