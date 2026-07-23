import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn()
}));
const gateMocks = vi.hoisted(() => ({
  assertOpenInTransaction: vi.fn(),
  lockForMoney: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({
    connect: async () => dbMocks
  })
}));

vi.mock("../config", () => ({
  config: {
    ETHEREUM_RPC_URL: "https://rpc.test",
    MARKET_FETCH_TIMEOUT_MS: 30_000,
    TREASURY_SAFE_ADDRESS: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    SETTLEMENT_CHAIN_ID: 11155111,
    USDC_CONTRACT_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    USDC_REQUIRED_CONFIRMATIONS: 12
  }
}));

vi.mock("../financialGate", () => ({
  assertFinancialGateOpenInTransaction: gateMocks.assertOpenInTransaction,
  lockFinancialControlGateForMoney: gateMocks.lockForMoney
}));

import {
  buildAndPersistSafeWithdrawalProposal,
  buildSafeWithdrawalProposalHookPayload,
  cancelWithdrawalRequest,
  createWithdrawalRequest,
  markWithdrawalSent,
  parseUsdcMicroUnitsExact,
  safeWithdrawalProposalHash,
  withdrawalRequestHashVersion,
  withdrawalRequestHash
} from "../db/withdrawalRepository";

beforeEach(() => {
  dbMocks.query.mockReset();
  dbMocks.release.mockReset();
  gateMocks.assertOpenInTransaction.mockReset();
  gateMocks.assertOpenInTransaction.mockResolvedValue({ allowed: true });
  gateMocks.lockForMoney.mockReset();
  gateMocks.lockForMoney.mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});

describe("withdrawal repository hardening", () => {
  const destinationAddress = "0x1234567890abcdef1234567890abcdef12345678";
  const treasuryAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const usdcAddress = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
  const requestHash = withdrawalRequestHash({
    userId: "00000000-0000-0000-0000-000000000001",
    destinationAddress,
    amountMicroUnits: 5_000_000n,
    chainId: 11155111
  });

  function topicAddress(address: string) {
    return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  }

  it("parses exact USDC strings into immutable micro-units", () => {
    expect(parseUsdcMicroUnitsExact("5")).toBe(5_000_000n);
    expect(parseUsdcMicroUnitsExact("5.000001")).toBe(5_000_001n);
    expect(parseUsdcMicroUnitsExact("0.000001")).toBe(1n);
    expect(() => parseUsdcMicroUnitsExact("5.0000001")).toThrow("invalid_usdc_amount");
    expect(() => parseUsdcMicroUnitsExact("0")).toThrow("invalid_withdrawal_amount");
  });

  it("returns an existing withdrawal for duplicate retry without reserving funds again", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM withdrawal_requests") && text.includes("idempotency_key")) {
        return {
          rows: [
            {
              id: "withdrawal-existing",
              status: "requested",
              chain_id: 11155111,
              destination_address: "0x1234567890abcdef1234567890abcdef12345678",
              amount_micro_units: "5000000",
              request_transaction_id: "request-ledger-existing",
              idempotency_key: "retry-key-1",
              request_hash: requestHash,
              request_hash_version: withdrawalRequestHashVersion
            }
          ]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await createWithdrawalRequest({
      userId: "00000000-0000-0000-0000-000000000001",
      destinationAddress: "0x1234567890abcdef1234567890abcdef12345678",
      amountMicroUnits: 5_000_000n,
      chainId: 11155111,
      idempotencyKey: "retry-key-1"
    });

    expect(result).toEqual({
      id: "withdrawal-existing",
      status: "requested",
      requestTransactionId: "request-ledger-existing",
      idempotencyKey: "retry-key-1",
      requestHash,
      idempotentReplay: true
    });
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ledger_entries"))).toBe(false);
    expect(dbMocks.release).toHaveBeenCalledOnce();
    expect(gateMocks.assertOpenInTransaction).toHaveBeenCalledWith(dbMocks, { operation: "withdrawal.request" });
  });

  it("handles legacy request hashes by comparing immutable request fields", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM withdrawal_requests") && text.includes("idempotency_key")) {
        return {
          rows: [
            {
              id: "withdrawal-legacy",
              status: "sent",
              chain_id: 11155111,
              destination_address: destinationAddress,
              amount_micro_units: "6000000",
              request_transaction_id: "request-ledger-legacy",
              idempotency_key: "retry-key-legacy",
              request_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              request_hash_version: "legacy-unknown-v0"
            }
          ]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      createWithdrawalRequest({
        userId: "00000000-0000-0000-0000-000000000001",
        destinationAddress,
        amountMicroUnits: 5_000_000n,
        chainId: 11155111,
        idempotencyKey: "retry-key-legacy"
      })
    ).rejects.toThrow("idempotency_key_conflict");
  });

  it("cancels an owned requested withdrawal by returning its exact reserved funds", async () => {
    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM withdrawal_requests") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "withdrawal-requested",
              user_id: "00000000-0000-0000-0000-000000000001",
              amount_micro_units: "5000000",
              status: "requested",
              completion_transaction_id: null,
              onchain_tx_hash: null,
              sent_at: null
            }
          ]
        };
      }
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: `${params?.[1]}-account` }] };
      if (text.includes("SELECT id FROM ledger_accounts") || text.includes("INSERT INTO ledger_entries")) return { rows: [] };
      if (text.includes("UPDATE withdrawal_requests") || text.includes("INSERT INTO audit_log")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await cancelWithdrawalRequest({
      withdrawalRequestId: "withdrawal-requested",
      actor: "user",
      userId: "00000000-0000-0000-0000-000000000001",
      reason: "customer request"
    });

    expect(result).toEqual({
      id: "withdrawal-requested",
      status: "canceled",
      completionTransactionId: expect.any(String),
      result: "canceled"
    });
    expect(gateMocks.lockForMoney).toHaveBeenCalledWith(dbMocks);
    const ledgerCall = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO ledger_entries"));
    expect(ledgerCall?.[1]).toEqual([
      expect.any(String),
      "pending_usdc_withdrawals-account",
      "-5000000",
      "user_usdc_available-account",
      "5000000"
    ]);
    const updateCall = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("status = 'canceled'"));
    expect(updateCall?.[1]).toEqual([
      "withdrawal-requested",
      result.completionTransactionId,
      "customer request",
      null
    ]);
  });

  it("returns already_canceled without another ledger movement", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM withdrawal_requests") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "withdrawal-canceled",
              user_id: "00000000-0000-0000-0000-000000000001",
              amount_micro_units: "5000000",
              status: "canceled",
              completion_transaction_id: "cancel-ledger-existing",
              onchain_tx_hash: null,
              sent_at: null
            }
          ]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      cancelWithdrawalRequest({
        withdrawalRequestId: "withdrawal-canceled",
        actor: "user",
        userId: "00000000-0000-0000-0000-000000000001"
      })
    ).resolves.toEqual({
      id: "withdrawal-canceled",
      status: "canceled",
      completionTransactionId: "cancel-ledger-existing",
      result: "already_canceled"
    });
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ledger_entries"))).toBe(false);
  });

  it("rejects cancellation by a non-owner", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM withdrawal_requests") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "withdrawal-requested",
              user_id: "00000000-0000-0000-0000-000000000001",
              amount_micro_units: "5000000",
              status: "requested",
              completion_transaction_id: null,
              onchain_tx_hash: null,
              sent_at: null
            }
          ]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      cancelWithdrawalRequest({
        withdrawalRequestId: "withdrawal-requested",
        actor: "user",
        userId: "00000000-0000-0000-0000-000000000099"
      })
    ).rejects.toThrow("withdrawal_not_owned");
  });

  it("locks the withdrawal row and rejects sent, failed, or already-executed states", async () => {
    const states = [
      { status: "sent", onchainTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", error: "withdrawal_terminal_state" },
      { status: "failed", onchainTxHash: null, error: "withdrawal_terminal_state" },
      { status: "proposed", onchainTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", error: "withdrawal_onchain_execution_exists" },
      { status: "proposed", onchainTxHash: null, error: "withdrawal_not_cancelable" }
    ];

    for (const state of states) {
      dbMocks.query.mockReset();
      dbMocks.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("FROM withdrawal_requests") && text.includes("FOR UPDATE")) {
          return {
            rows: [
              {
                id: "withdrawal-terminal",
                user_id: "00000000-0000-0000-0000-000000000001",
                amount_micro_units: "5000000",
                status: state.status,
                completion_transaction_id: null,
                onchain_tx_hash: state.onchainTxHash,
                sent_at: state.status === "sent" ? new Date("2026-01-01T00:00:00.000Z") : null
              }
            ]
          };
        }
        throw new Error(`unexpected query: ${text}`);
      });

      await expect(
        cancelWithdrawalRequest({
          withdrawalRequestId: "withdrawal-terminal",
          actor: "user",
          userId: "00000000-0000-0000-0000-000000000001"
        })
      ).rejects.toThrow(state.error);
      expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ledger_entries"))).toBe(false);
    }
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true);
  });

  it("verifies chain, canonical block, finality, treasury, destination, and amount before completing sent withdrawals", async () => {
    const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const blockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const safeProposalPayload = buildSafeWithdrawalProposalHookPayload({
      withdrawalRequestId: "withdrawal-test",
      chainId: 11155111,
      safeAddress: treasuryAddress,
      usdcContractAddress: usdcAddress,
      destinationAddress,
      amountMicroUnits: 5_000_000n
    });
    const safeProposalHash = safeWithdrawalProposalHash(safeProposalPayload);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const result =
          body.method === "eth_chainId"
            ? "0xaa36a7"
            : body.method === "eth_getTransactionReceipt"
              ? {
                  status: "0x1",
                  transactionHash: txHash,
                  blockNumber: "0x64",
                  blockHash,
                  logs: [
                    {
                      address: usdcAddress,
                      topics: [
                        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                        topicAddress(treasuryAddress),
                        topicAddress(destinationAddress)
                      ],
                      data: "0x4c4b40",
                      blockNumber: "0x64",
                      blockHash
                    }
                  ]
                }
              : body.method === "eth_getBlockByNumber"
                ? { hash: blockHash }
                : "0x6f";
        return {
          ok: true,
          json: async () => ({ result })
        } as Response;
      })
    );

    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("safe_proposal_payload") && text.includes("FROM withdrawal_requests")) {
        return {
          rows: [
            {
              id: "withdrawal-test",
              user_id: "00000000-0000-0000-0000-000000000001",
              chain_id: 11155111,
              destination_address: destinationAddress,
              amount_micro_units: "5000000",
              status: "proposed",
              safe_proposal_payload: safeProposalPayload,
              safe_proposal_hash: safeProposalHash,
              safe_proposed_at: new Date("2026-01-01T00:00:00.000Z"),
              safe_proposed_by: "operator-proposer"
            }
          ]
        };
      }
      if (text.includes("WHERE chain_id = $1") && text.includes("onchain_tx_hash")) return { rows: [] };
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: `${params?.[1]}-account` }] };
      if (text.includes("FROM treasury_config")) {
        return {
          rows: [
            {
              treasuryAddress,
              usdcContractAddress: usdcAddress,
              requiredConfirmations: 12
            }
          ]
        };
      }
      if (text.includes("INSERT INTO ledger_entries") || text.includes("UPDATE withdrawal_requests") || text.includes("INSERT INTO audit_log")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await markWithdrawalSent({
      id: "withdrawal-test",
      operatorId: "operator-test",
      onchainTxHash: txHash
    });

    expect(result.status).toBe("sent");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(gateMocks.lockForMoney).toHaveBeenCalledWith(dbMocks);
    expect(gateMocks.assertOpenInTransaction).not.toHaveBeenCalledWith(dbMocks, { operation: "withdrawal.sent" });
    const updateCall = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("onchain_block_number"));
    expect(updateCall?.[1]).toEqual([
      "withdrawal-test",
      expect.any(String),
      txHash,
      "operator-test",
      "100",
      blockHash,
      "12",
      safeProposalHash
    ]);
  });

  it("re-reads the receipt and canonical block immediately before ledger completion", async () => {
    const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const firstBlockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const secondBlockHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const safeProposalPayload = buildSafeWithdrawalProposalHookPayload({
      withdrawalRequestId: "withdrawal-reorg",
      chainId: 11155111,
      safeAddress: treasuryAddress,
      usdcContractAddress: usdcAddress,
      destinationAddress,
      amountMicroUnits: 5_000_000n
    });
    const safeProposalHash = safeWithdrawalProposalHash(safeProposalPayload);
    let receiptReads = 0;
    let canonicalReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const method = JSON.parse(String(init.body)).method as string;
        let result: unknown;
        if (method === "eth_chainId") {
          result = "0xaa36a7";
        } else if (method === "eth_getTransactionReceipt") {
          receiptReads += 1;
          const blockHash = receiptReads === 1 ? firstBlockHash : secondBlockHash;
          result = {
            status: "0x1",
            transactionHash: txHash,
            blockNumber: "0x64",
            blockHash,
            logs: [
              {
                address: usdcAddress,
                topics: [
                  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                  topicAddress(treasuryAddress),
                  topicAddress(destinationAddress)
                ],
                data: "0x4c4b40",
                blockNumber: "0x64",
                blockHash
              }
            ]
          };
        } else if (method === "eth_getBlockByNumber") {
          canonicalReads += 1;
          result = { hash: canonicalReads === 1 ? firstBlockHash : secondBlockHash };
        } else {
          result = "0x6f";
        }
        return { ok: true, json: async () => ({ result }) } as Response;
      })
    );

    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("safe_proposal_payload") && text.includes("FROM withdrawal_requests")) {
        return {
          rows: [
            {
              id: "withdrawal-reorg",
              user_id: "00000000-0000-0000-0000-000000000001",
              chain_id: 11155111,
              destination_address: destinationAddress,
              amount_micro_units: "5000000",
              status: "proposed",
              safe_proposal_payload: safeProposalPayload,
              safe_proposal_hash: safeProposalHash,
              safe_proposed_at: new Date("2026-01-01T00:00:00.000Z"),
              safe_proposed_by: "operator-proposer"
            }
          ]
        };
      }
      if (text.includes("FROM treasury_config")) {
        return { rows: [{ treasuryAddress, usdcContractAddress: usdcAddress, requiredConfirmations: 12 }] };
      }
      if (text.includes("WHERE chain_id = $1") && text.includes("onchain_tx_hash")) return { rows: [] };
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: `${params?.[1]}-account` }] };
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      markWithdrawalSent({
        id: "withdrawal-reorg",
        operatorId: "operator-test",
        onchainTxHash: txHash
      })
    ).rejects.toThrow("withdrawal_tx_reorged_before_commit");
    expect(receiptReads).toBe(2);
    expect(canonicalReads).toBe(2);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO ledger_entries"))).toBe(false);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE withdrawal_requests"))).toBe(false);
  });

  it("refuses requested withdrawals and tampered Safe proposal hashes before receipt verification", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM withdrawal_requests") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "withdrawal-test",
              user_id: "00000000-0000-0000-0000-000000000001",
              chain_id: 11155111,
              destination_address: destinationAddress,
              amount_micro_units: "5000000",
              status: "requested",
              safe_proposal_payload: null,
              safe_proposal_hash: null,
              safe_proposed_at: null,
              safe_proposed_by: null
            }
          ]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      markWithdrawalSent({
        id: "withdrawal-test",
        operatorId: "operator-test",
        onchainTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toThrow("withdrawal_not_proposed");
    expect(fetchMock).not.toHaveBeenCalled();

    const safeProposalPayload = buildSafeWithdrawalProposalHookPayload({
      withdrawalRequestId: "withdrawal-test",
      chainId: 11155111,
      safeAddress: treasuryAddress,
      usdcContractAddress: usdcAddress,
      destinationAddress,
      amountMicroUnits: 5_000_000n
    });
    dbMocks.query.mockReset();
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("safe_proposal_payload") && text.includes("FROM withdrawal_requests")) {
        return {
          rows: [
            {
              id: "withdrawal-test",
              user_id: "00000000-0000-0000-0000-000000000001",
              chain_id: 11155111,
              destination_address: destinationAddress,
              amount_micro_units: "5000000",
              status: "proposed",
              safe_proposal_payload: safeProposalPayload,
              safe_proposal_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              safe_proposed_at: new Date("2026-01-01T00:00:00.000Z"),
              safe_proposed_by: "operator-proposer"
            }
          ]
        };
      }
      if (text.includes("FROM treasury_config")) {
        return { rows: [{ treasuryAddress, usdcContractAddress: usdcAddress, requiredConfirmations: 12 }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      markWithdrawalSent({
        id: "withdrawal-test",
        operatorId: "operator-test",
        onchainTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toThrow("withdrawal_safe_proposal_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires one active database treasury configuration before building a Safe proposal", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM withdrawal_requests") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "withdrawal-test",
              user_id: "00000000-0000-0000-0000-000000000001",
              chain_id: 11155111,
              destination_address: destinationAddress,
              amount_micro_units: "5000000",
              status: "requested",
              request_hash: requestHash,
              request_hash_version: withdrawalRequestHashVersion
            }
          ]
        };
      }
      if (text.includes("FROM treasury_config")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      buildAndPersistSafeWithdrawalProposal({
        withdrawalRequestId: "withdrawal-test",
        operatorId: "operator-test"
      })
    ).rejects.toThrow("active_treasury_config_missing");
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE withdrawal_requests"))).toBe(false);
  });

  it("exposes a Safe proposal payload hook without calling the Safe API", () => {
    const payload = buildSafeWithdrawalProposalHookPayload({
      withdrawalRequestId: "withdrawal-test",
      chainId: 11155111,
      safeAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      destinationAddress: "0x1234567890abcdef1234567890abcdef12345678",
      amountMicroUnits: 5_000_000n
    });

    expect(payload).toMatchObject({
      withdrawalRequestId: "withdrawal-test",
      chainId: 11155111,
      safeAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      tokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
      destinationAddress: "0x1234567890abcdef1234567890abcdef12345678",
      amountMicroUnits: "5000000",
      tokenTransferCall: {
        to: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
        value: "0"
      }
    });
    expect(payload.tokenTransferCall.data).toBe(
      "0xa9059cbb0000000000000000000000001234567890abcdef1234567890abcdef1234567800000000000000000000000000000000000000000000000000000000004c4b40"
    );
  });

  it("loads and locks a requested withdrawal before persisting an immutable Safe proposal hash", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM withdrawal_requests") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "withdrawal-test",
              user_id: "00000000-0000-0000-0000-000000000001",
              chain_id: 11155111,
              destination_address: destinationAddress,
              amount_micro_units: "5000000",
              status: "requested",
              request_hash: requestHash,
              request_hash_version: withdrawalRequestHashVersion
            }
          ]
        };
      }
      if (text.includes("FROM treasury_config")) {
        return {
          rows: [
            {
              treasuryAddress,
              usdcContractAddress: usdcAddress,
              requiredConfirmations: 12
            }
          ]
        };
      }
      if (text.includes("UPDATE withdrawal_requests") || text.includes("INSERT INTO audit_log")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const proposal = await buildAndPersistSafeWithdrawalProposal({
      withdrawalRequestId: "withdrawal-test",
      operatorId: "operator-test"
    });

    expect(proposal).toMatchObject({
      withdrawalRequestId: "withdrawal-test",
      chainId: 11155111,
      safeAddress: treasuryAddress,
      tokenAddress: usdcAddress,
      destinationAddress,
      amountMicroUnits: "5000000",
      status: "proposed",
      requestHash,
      safeApiBroadcast: "disabled"
    });
    expect(proposal.safeProposalHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(gateMocks.assertOpenInTransaction).toHaveBeenCalledWith(dbMocks, { operation: "withdrawal.safe_propose" });
    const updateCall = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("safe_proposal_hash"));
    expect(updateCall?.[1]).toEqual(["withdrawal-test", expect.any(Object), proposal.safeProposalHash, "operator-test"]);
  });
});
