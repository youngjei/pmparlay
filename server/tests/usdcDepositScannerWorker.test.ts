import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { processUsdcDepositScan, stringifyDepositWorkerEvent } from "../workers/usdcDepositScannerWorker";

afterEach(() => {
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
