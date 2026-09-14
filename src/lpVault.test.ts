import { describe, expect, it } from "vitest";
import {
  LP_VAULT_FUTURE_LIFECYCLE,
  LP_VAULT_LIQUIDITY_COPY,
  LP_VAULT_SHADOW_COPY
} from "./LpVaultView";
import {
  LpVaultFetchError,
  canShowLpVaultAmounts,
  collateralHealthCopy,
  explorerUrl,
  fetchLpVault,
  formatBasisPoints,
  formatMicroUsdc,
  formatReconciliationAge,
  formatUsd,
  formatUtcCycleCutoff,
  getLpVaultDisplayState,
  shortHash,
  type LpVaultResponse
} from "./lpVault";

const readyVault: LpVaultResponse = {
  mode: "shadow",
  depositsEnabled: false,
  accounting: {
    scope: "rolling_lp_shadow",
    asOf: "2026-09-03T00:00:00.000Z",
    processedAt: "2026-09-03T00:00:01.000Z",
    cycleCutoffAt: "2026-09-03T00:00:00.000Z",
    reconciliationId: "00000000-0000-4000-8000-000000000003",
    bookVersion: "42",
    canonicalBlockNumber: "123",
    canonicalBlockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    economicNavMicroUnits: "700000000",
    sharePriceMicroUnits: "1000000",
    shareUnitsPerShare: "1000000000000000000",
    activeShareUnits: "700000000000000000000",
    pendingActivationMicroUnits: "25000000",
    estimatedPnlMicroUnits: "-5000000",
    finalizedPnlMicroUnits: "20000000",
    markedUnresolvedLiabilityMicroUnits: "200000000",
    fullLiabilityFallbackMicroUnits: "50000000",
    liabilityMarkCoverageBps: 7500
  },
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
  snapshot: {
    accountingScope: "global_house_book_not_lp_attributed",
    reconciliationId: "00000000-0000-4000-8000-000000000003",
    asOf: "2026-09-03T00:00:00.000Z",
    processedAt: "2026-09-03T00:00:01.000Z",
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

  it("withholds amounts when accounting is stale even if reserve evidence is fresh", () => {
    const now = Date.parse("2026-09-03T00:04:00.000Z");
    const accountingStale = {
      ...readyVault,
      snapshot: { ...readyVault.snapshot!, asOf: "2026-09-03T00:03:59.000Z" },
      accounting: { ...readyVault.accounting!, asOf: "2026-09-01T22:03:59.000Z", cycleCutoffAt: "2026-09-01T00:00:00.000Z" }
    };

    expect(getLpVaultDisplayState(accountingStale, now)).toBe("accounting_stale");
    expect(canShowLpVaultAmounts(accountingStale, now)).toBe(false);
  });

  it("formats evidence links and reconciliation age safely", () => {
    expect(explorerUrl("https://sepolia.etherscan.io/", "block/123")).toBe("https://sepolia.etherscan.io/block/123");
    expect(explorerUrl("not a url", "block/123")).toBeUndefined();
    expect(shortHash("0x123456789abcdef")).toBe("0x123456...abcdef");
    expect(formatReconciliationAge("2026-09-03T00:00:00.000Z", Date.parse("2026-09-03T01:30:00.000Z"))).toBe("1h ago");
    expect(formatUsd(0.000001)).toBe("$0.000001");
    expect(formatUsd(-0.000001)).toBe("-$0.000001");
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

  it("rejects reserve evidence processed before its source block", async () => {
    await expect(fetchLpVault("/api/lp-vault", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...readyVault,
        snapshot: {
          ...readyVault.snapshot,
          processedAt: "2026-09-02T23:59:59.999Z"
        }
      })
    }))).rejects.toBeInstanceOf(LpVaultFetchError);
  });

  it("rejects an available response without rolling accounting", async () => {
    await expect(fetchLpVault("/api/lp-vault", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...readyVault, accounting: null })
    }))).rejects.toBeInstanceOf(LpVaultFetchError);
  });

  it.each([
    ["reconciliation", { reconciliationId: "invalid" }],
    ["book", { bookVersion: "book-43" }],
    ["block number", { canonicalBlockNumber: "-1" }],
    ["block hash", { canonicalBlockHash: "bad" }]
  ])("rejects accounting with malformed %s evidence", async (_label, accountingChange) => {
    await expect(fetchLpVault("/api/lp-vault", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...readyVault, accounting: { ...readyVault.accounting!, ...accountingChange } })
    }))).rejects.toBeInstanceOf(LpVaultFetchError);
  });

  it("rejects malformed accounting arithmetic", async () => {
    await expect(fetchLpVault("/api/lp-vault", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...readyVault, accounting: { ...readyVault.accounting!, sharePriceMicroUnits: "999999" } })
    }))).rejects.toBeInstanceOf(LpVaultFetchError);
  });

  it("rejects positive economic NAV with zero active shares", async () => {
    await expect(fetchLpVault("/api/lp-vault", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...readyVault,
        accounting: {
          ...readyVault.accounting!,
          activeShareUnits: "0",
          economicNavMicroUnits: "1",
          sharePriceMicroUnits: "1000000"
        }
      })
    }))).rejects.toBeInstanceOf(LpVaultFetchError);
  });

  it("accepts an empty rolling book only at zero NAV and the genesis price", async () => {
    const response = await fetchLpVault("/api/lp-vault", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...readyVault,
        accounting: {
          ...readyVault.accounting!,
          activeShareUnits: "0",
          economicNavMicroUnits: "0",
          sharePriceMicroUnits: "1000000"
        }
      })
    }));

    expect(response.accounting?.economicNavMicroUnits).toBe("0");
  });

  it("formats micro-USDC and mark coverage without floating-point money conversion", () => {
    expect(formatMicroUsdc("1234567890123")).toBe("$1,234,567.890123");
    expect(formatMicroUsdc("-5000000", { signed: true })).toBe("-$5.00");
    expect(formatMicroUsdc("20000000", { signed: true })).toBe("+$20.00");
    expect(formatBasisPoints(7550)).toBe("75.5%");
    expect(formatUtcCycleCutoff("2026-09-03T00:00:00.000Z")).toBe("Sep 3, 2026 · 00:00 UTC");
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

describe("LP Vault shadow product copy", () => {
  it("states the approved shadow promise without implying public availability", () => {
    expect(LP_VAULT_SHADOW_COPY).toEqual({
      title: "LEGWORK LP Vault",
      promise: "Back LEGWORK tickets through a transparent, rolling economic NAV.",
      banner: "Founder-funded Sepolia shadow · Deposits unavailable"
    });
  });

  it("covers every rolling participation and redemption invariant", () => {
    const lifecycle = LP_VAULT_FUTURE_LIFECYCLE.map(({ detail }) => detail).join(" ");

    expect(lifecycle).toMatch(/enters custody immediately.*pending P&L.*00:00 UTC cycle.*canonical pre-deposit economic NAV price.*neither inherit prior P&L nor dilute/i);
    expect(lifecycle).toMatch(/fixed and non-transferable.*estimated USDC value.*unresolved-liability marks.*authoritative ticket settlements.*finalized P&L/i);
    expect(lifecycle).toMatch(/FIFO order.*admitted only.*redemption liquidity.*remain fully active/i);
    expect(lifecycle).toMatch(/dynamic P&L.*new exposure.*72 hours.*canonical economic-NAV price.*binding.*underlying P&L remains estimated/i);
    expect(LP_VAULT_LIQUIDITY_COPY).toMatch(/economic NAV.*Redemption liquidity.*separate.*FIFO admission/i);
    expect(lifecycle).not.toMatch(/fixed epoch|funding window|runoff/i);
  });
});
