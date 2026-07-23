import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    DATABASE_URL: "postgres://test",
    ETHEREUM_RPC_URL: "https://rpc.test",
    SETTLEMENT_CHAIN_ID: 11155111
  }
}));

import { processFinancialReconciliation } from "../workers/reconciliationWorker";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("financial reconciliation worker provenance", () => {
  const treasuryConfig = {
    chainId: 11155111,
    currency: "USDC" as const,
    treasuryAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    usdcContractAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    requiredConfirmations: 12,
    active: true
  };
  const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

  it("uses worker/onchain naming and rechecks the canonical hash immediately before insert", async () => {
    const getBlockHash = vi.fn().mockResolvedValue(blockHash);
    const createSnapshot = vi.fn(async (input) => {
      await input.verifyCanonicalBlock({ blockNumber: 100n, blockHash });
      return { id: "snapshot", ...input };
    });

    await processFinancialReconciliation({
      treasuryConfigs: [treasuryConfig],
      getCurrentBlock: async () => 100n,
      getBlockHash,
      getTokenBalance: async () => 5_000_000n,
      createSnapshot: createSnapshot as never
    });

    expect(getBlockHash).toHaveBeenCalledTimes(3);
    expect(getBlockHash).toHaveBeenNthCalledWith(3, 100n);
    expect(createSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      source: "worker",
      chainId: 11155111,
      currency: "USDC",
      treasuryAssets: [
        expect.objectContaining({
          source: "onchain",
          blockNumber: 100n,
          blockHash
        })
      ]
    }));
  });

  it("does not insert a snapshot when the block reorgs during balance collection", async () => {
    const getBlockHash = vi
      .fn()
      .mockResolvedValueOnce(blockHash)
      .mockResolvedValueOnce("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const createSnapshot = vi.fn();

    await expect(
      processFinancialReconciliation({
        treasuryConfigs: [treasuryConfig],
        getCurrentBlock: async () => 100n,
        getBlockHash,
        getTokenBalance: async () => 5_000_000n,
        createSnapshot: createSnapshot as never
      })
    ).rejects.toThrow("reconciliation_block_reorged_before_insert");
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("bounds default RPC reads with abort signals", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options?: RequestInit) => {
        const signal = options?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        signals.push(signal!);
        const request = JSON.parse(String(options?.body)) as { method: string };
        if (request.method === "eth_chainId") return new Response(JSON.stringify({ result: "0xaa36a7" }));
        if (request.method === "eth_blockNumber") return new Response(JSON.stringify({ result: "0x64" }));
        if (request.method === "eth_getBlockByNumber") return new Response(JSON.stringify({ result: { hash: blockHash } }));
        if (request.method === "eth_call") return new Response(JSON.stringify({ result: "0x4c4b40" }));
        throw new Error("unexpected_rpc_method");
      })
    );
    const createSnapshot = vi.fn(async (input) => {
      await input.verifyCanonicalBlock({ blockNumber: 100n, blockHash });
      return { id: "snapshot", ...input };
    });

    await processFinancialReconciliation({
      treasuryConfigs: [treasuryConfig],
      createSnapshot: createSnapshot as never
    });

    expect(signals).toHaveLength(6);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it("fails closed before reconciliation when the RPC chain differs from settlement", async () => {
    const createSnapshot = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: "0x1" })))
    );

    await expect(
      processFinancialReconciliation({
        treasuryConfigs: [treasuryConfig],
        createSnapshot: createSnapshot as never
      })
    ).rejects.toThrow("ethereum_rpc_chain_id_mismatch");
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed before reconciliation when the RPC chain is unavailable", async () => {
    const createSnapshot = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("unavailable"))));

    await expect(
      processFinancialReconciliation({
        treasuryConfigs: [treasuryConfig],
        createSnapshot: createSnapshot as never
      })
    ).rejects.toThrow("ethereum_rpc_request_failed");
    expect(createSnapshot).not.toHaveBeenCalled();
  });
});
