import { describe, expect, it } from "vitest";
import {
  LpVaultFetchError,
  canShowLpVaultAmounts,
  collateralHealthCopy,
  explorerUrl,
  fetchLpVault,
  formatReconciliationAge,
  getLpVaultDisplayState,
  shortHash,
  type LpVaultResponse
} from "./lpVault";

const readyVault: LpVaultResponse = {
  mode: "shadow",
  depositsEnabled: false,
  availability: "available",
  network: { chainId: 11155111, name: "Sepolia", currency: "USDC" },
  vault: {
    id: "vault_1",
    key: "founder-sepolia-shadow",
    name: "LEGWORK LP Vault",
    capitalSource: "founder",
    custodyModel: "logical_operating_treasury",
    communityCustody: false,
    treasuryAddress: "0x1111111111111111111111111111111111111111",
    tokenAddress: "0x2222222222222222222222222222222222222222"
  },
  epoch: { id: "epoch_1", number: 2, status: "active", startsAt: "2026-09-03T00:00:00.000Z" },
  snapshot: {
    accountingScope: "global_house_book_not_lp_attributed",
    asOf: "2026-09-03T00:00:00.000Z",
    blockNumber: "123",
    blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    treasuryAssetsUsd: 1000,
    seniorUserObligationsUsd: 100,
    grossUnresolvedPayoutsUsd: 200,
    reservedNetLiabilityUsd: 150,
    hardCapitalUsd: 700,
    hardSolvencyFloorUsd: 300,
    operatingCoverageBufferUsd: 50,
    pendingBasketStakeUsd: 0,
    pendingBasketMaxPayoutUsd: 0,
    pendingBasketCount: 0,
    pendingBasketCapacityChargeUsd: 0,
    operatingWithdrawalFloorUsd: 350,
    capitalAboveWithdrawalFloorUsd: 650,
    grossCoverage: 4.5,
    custodyDeltaUsd: 0,
    solvencyStatus: "healthy",
    gate: { underwriting: "open", seniorOperations: "open", lpWithdrawals: "not_live" }
  }
};

describe("LP Vault helpers", () => {
  it("withholds all capital amounts when the reconciliation is stale", () => {
    const staleVault = { ...readyVault, availability: "reconciliation_stale" as const, snapshot: null };
    expect(getLpVaultDisplayState(staleVault)).toBe("reconciliation_stale");
    expect(canShowLpVaultAmounts(staleVault)).toBe(false);
  });

  it("withholds a response that ages past the client freshness limit", () => {
    const afterFreshnessWindow = Date.parse("2026-09-03T00:05:00.001Z");
    expect(getLpVaultDisplayState(readyVault, afterFreshnessWindow)).toBe("reconciliation_stale");
    expect(canShowLpVaultAmounts(readyVault, afterFreshnessWindow)).toBe(false);
  });

  it("formats evidence links and reconciliation age safely", () => {
    expect(explorerUrl("https://sepolia.etherscan.io/", "block/123")).toBe("https://sepolia.etherscan.io/block/123");
    expect(explorerUrl("not a url", "block/123")).toBeUndefined();
    expect(shortHash("0x123456789abcdef")).toBe("0x123456...abcdef");
    expect(formatReconciliationAge("2026-09-03T00:00:00.000Z", Date.parse("2026-09-03T01:30:00.000Z"))).toBe("1h ago");
  });

  it("rejects a malformed successful API response", async () => {
    await expect(fetchLpVault("/api/lp-vault", async () => ({ ok: true, status: 200, json: async () => ({ mode: "live" }) }))).rejects.toBeInstanceOf(LpVaultFetchError);
  });

  it("rejects an available response with malformed financial evidence", async () => {
    await expect(fetchLpVault("/api/lp-vault", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...readyVault, snapshot: { ...readyVault.snapshot, blockHash: "bad" } })
    }))).rejects.toBeInstanceOf(LpVaultFetchError);
  });

  it("rejects internally inconsistent collateral arithmetic", async () => {
    await expect(fetchLpVault("/api/lp-vault", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...readyVault,
        snapshot: { ...readyVault.snapshot!, operatingWithdrawalFloorUsd: 349.99 }
      })
    }))).rejects.toBeInstanceOf(LpVaultFetchError);
  });

  it("never labels a reserve shortfall as fully collateralized", () => {
    expect(collateralHealthCopy({ ...readyVault.snapshot!, treasuryAssetsUsd: 299.99 }).tone).toBe("critical");
    expect(collateralHealthCopy({ ...readyVault.snapshot!, treasuryAssetsUsd: 325 }).tone).toBe("warning");
    expect(collateralHealthCopy(readyVault.snapshot!).tone).toBe("healthy");
  });
});
