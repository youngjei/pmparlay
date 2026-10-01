import { describe, expect, it, vi } from "vitest";
import {
  deriveLpVaultPublicView,
  FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
  FOUNDER_SEPOLIA_SHADOW_VAULT_KEY,
  provisionFounderSepoliaShadowVault,
  type ConfiguredShadowVault,
  type GlobalHouseBookReconciliation
} from "../db/lpVaultRepository";
import type { VerifiedLpVaultAccounting } from "../db/lpVaultAccountingRepository";

const treasuryAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const tokenAddress = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const reconciliationId = "00000000-0000-4000-8000-000000000010";

function vaultFixture(): ConfiguredShadowVault {
  return {
    id: FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
    vaultKey: FOUNDER_SEPOLIA_SHADOW_VAULT_KEY,
    displayName: "LEGWORK Founder Shadow Vault",
    mode: "shadow",
    chainId: 11155111,
    currency: "USDC",
    treasuryAddress,
    tokenAddress,
    capitalSource: "founder",
    custodyModel: "logical_operating_treasury",
    communityCustody: false,
    depositsEnabled: false,
    createdAt: "2026-09-03T00:00:00.000Z"
  };
}

function reconciliationFixture(
  overrides: Partial<GlobalHouseBookReconciliation> = {}
): GlobalHouseBookReconciliation {
  const { treasuryAssets: treasuryAssetOverrides, metrics: metricOverrides, ...scalarOverrides } = overrides;
  const processedAt = scalarOverrides.createdAt ?? "2026-09-03T00:02:01.000Z";
  const sourceTimestamp = BigInt(Math.floor(Date.parse(
    scalarOverrides.createdAt ?? "2026-09-03T00:02:00.000Z"
  ) / 1_000));
  const treasuryAssets = (treasuryAssetOverrides ?? [
    {
      chainId: 11155111,
      treasuryAddress,
      tokenAddress,
      balanceMicroUnits: "100000000",
      blockNumber: 123456n,
      blockHash,
      source: "onchain" as const
    }
  ]).map((asset) => ({ ...asset, blockTimestamp: asset.blockTimestamp ?? sourceTimestamp }));
  return {
    id: reconciliationId,
    chainId: 11155111,
    currency: "USDC",
    treasuryAssetsMicroUnits: "100000000",
    internalCustodyMicroUnits: "99000000",
    userAvailableMicroUnits: "10000000",
    userClaimableMicroUnits: "5000000",
    userCheckoutMicroUnits: "2000000",
    openStakeMicroUnits: "10000000",
    openReserveMicroUnits: "20000000",
    pendingWithdrawalMicroUnits: "3000000",
    houseEquityMicroUnits: "50000000",
    unexplainedDeltaMicroUnits: "1000000",
    launchGate: "blocked",
    operationGate: "restricted",
    gateReasons: ["treasury_internal_delta"],
    treasuryAssets,
    metrics: {
      softReservationCount: "1",
      softReservationStakeMicroUnits: "1000000",
      softReservationGrossPayoutMicroUnits: "4000000",
      softReservationOperatingChargeMicroUnits: "4000000",
      observedBlockTimestamp: sourceTimestamp.toString(),
      ...metricOverrides
    },
    observedBlockNumber: "123456",
    observedBlockHash: blockHash,
    source: "worker",
    scopeTreasuryAddress: treasuryAddress,
    scopeTokenAddress: tokenAddress,
    createdAt: processedAt,
    ...scalarOverrides
  };
}

function accountingFixture(overrides: Partial<VerifiedLpVaultAccounting> = {}): VerifiedLpVaultAccounting {
  return {
    vaultId: FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
    cycleId: "00000000-0000-4000-8000-000000000011",
    cutoffDate: "2026-09-03",
    closeMode: "on_time",
    sourceDelayMs: 120_000n,
    asOf: new Date("2026-09-03T00:02:00.000Z"),
    processedAt: new Date("2026-09-03T00:02:01.000Z"),
    reconciliationId,
    bookVersion: 12n,
    canonicalBlockNumber: 123456n,
    canonicalBlockHash: blockHash,
    grossAssetsMicroUnits: 100_000_000n,
    economicNavMicroUnits: 50_000_000n,
    activeShareUnits: 50_000_000_000_000_000_000n,
    sharePriceNumeratorMicroUnits: 50_000_000n,
    sharePriceDenominatorUnits: 50_000_000_000_000_000_000n,
    pendingActivationMicroUnits: 0n,
    estimatedPnlMicroUnits: -20_000_000n,
    finalizedPnlMicroUnits: 0n,
    markedUnresolvedLiabilityMicroUnits: 30_000_000n,
    grossUnresolvedPayoutsMicroUnits: 30_000_000n,
    fullLiabilityFallbackMicroUnits: 30_000_000n,
    liabilityMarkCoverageBps: 0,
    activeRedemptionReserveMicroUnits: 0n,
    collateralRequirementsMicroUnits: 50_000_000n,
    freeLiquidityMicroUnits: 50_000_000n,
    ...overrides
  };
}

describe("LP vault public read model", () => {
  it("derives only globally reconciled hard-capital facts at the API boundary", () => {
    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation: reconciliationFixture(),
      accounting: accountingFixture(),
      now: new Date("2026-09-03T00:04:00.000Z")
    });

    expect(view).toEqual({
      mode: "shadow",
      network: { chainId: 11155111, name: "Sepolia", currency: "USDC" },
      depositsEnabled: false,
      accounting: {
        scope: "rolling_lp_shadow",
        asOf: "2026-09-03T00:02:00.000Z",
        processedAt: "2026-09-03T00:02:01.000Z",
        cycleCutoffAt: "2026-09-03T00:00:00.000Z",
        closeMode: "on_time",
        sourceDelayMs: "120000",
        reconciliationId,
        bookVersion: "12",
        canonicalBlockNumber: "123456",
        canonicalBlockHash: blockHash,
        economicNavMicroUnits: "50000000",
        sharePriceMicroUnits: "1000000",
        shareUnitsPerShare: "1000000000000000000",
        activeShareUnits: "50000000000000000000",
        pendingActivationMicroUnits: "0",
        estimatedPnlMicroUnits: "-20000000",
        finalizedPnlMicroUnits: "0",
        markedUnresolvedLiabilityMicroUnits: "30000000",
        fullLiabilityFallbackMicroUnits: "30000000",
        liabilityMarkCoverageBps: 0
      },
      availability: "available",
      vault: {
        id: FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
        key: FOUNDER_SEPOLIA_SHADOW_VAULT_KEY,
        name: "LEGWORK Founder Shadow Vault",
        capitalSource: "founder",
        custodyModel: "logical_operating_treasury",
        communityCustody: false,
        treasuryAddress,
        tokenAddress
      },
      snapshot: {
        accountingScope: "global_house_book_not_lp_attributed",
        reconciliationId,
        asOf: "2026-09-03T00:02:00.000Z",
        processedAt: "2026-09-03T00:02:01.000Z",
        blockNumber: "123456",
        blockHash,
        treasuryAssetsUsd: 100,
        seniorUserObligationsUsd: 20,
        grossUnresolvedPayoutsUsd: 30,
        reservedNetLiabilityUsd: 20,
        hardCapitalUsd: 50,
        hardSolvencyFloorUsd: 50,
        operatingCoverageBufferUsd: 7.5,
        pendingBasketStakeUsd: 1,
        pendingBasketMaxPayoutUsd: 4,
        pendingBasketCount: 1,
        pendingBasketCapacityChargeUsd: 4,
        operatingWithdrawalFloorUsd: 61.5,
        capitalAboveWithdrawalFloorUsd: 38.5,
        grossCoverage: 2.666667,
        custodyDeltaUsd: 1,
        solvencyStatus: "healthy",
        gate: { underwriting: "paused", seniorOperations: "restricted", lpWithdrawals: "not_live" }
      }
    });
    expect(view.snapshot).not.toHaveProperty("apy");
    expect(view.snapshot).not.toHaveProperty("nav");
    expect(view).not.toHaveProperty("position");
  });

  it.each([
    ["reconciliation_absent", undefined],
    ["reconciliation_malformed", reconciliationFixture({ houseEquityMicroUnits: "50000001" })],
    ["reconciliation_untrusted", reconciliationFixture({ source: "legacy" })],
    ["reconciliation_wrong_scope", reconciliationFixture({ scopeTreasuryAddress: "0x1111111111111111111111111111111111111111" })],
    ["reconciliation_future", reconciliationFixture({ createdAt: "2026-09-03T00:05:01.000Z" })],
    ["reconciliation_stale", reconciliationFixture({ createdAt: "2026-09-02T23:59:59.999Z" })]
  ] as const)("returns snapshot:null for %s", (availability, globalReconciliation) => {
    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation,
      now: new Date("2026-09-03T00:05:00.000Z")
    });

    expect(view.availability).toBe(availability);
    expect(view.snapshot).toBeNull();
  });

  it("does not let a fresh worker write revive stale chain evidence", () => {
    const staleSourceTimestamp = BigInt(Date.parse("2026-09-02T23:59:59.000Z") / 1_000);
    const reconciliation = reconciliationFixture({
      createdAt: "2026-09-03T00:04:59.000Z"
    });
    reconciliation.treasuryAssets = reconciliation.treasuryAssets.map((asset) => ({
      ...asset,
      blockTimestamp: staleSourceTimestamp
    }));
    reconciliation.metrics = {
      ...reconciliation.metrics,
      observedBlockTimestamp: staleSourceTimestamp.toString()
    };

    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation: reconciliation,
      accounting: accountingFixture(),
      now: new Date("2026-09-03T00:05:00.000Z")
    });

    expect(view.availability).toBe("reconciliation_stale");
    expect(view.snapshot).toBeNull();
  });

  it.each([
    ["accounting_absent", undefined],
    ["accounting_stale", accountingFixture({ asOf: new Date("2026-09-01T22:04:59.999Z") })],
    ["accounting_malformed", accountingFixture({ activeShareUnits: 0n, economicNavMicroUnits: 1n })]
  ] as const)("withholds all financial values for %s", (availability, accounting) => {
    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation: reconciliationFixture(),
      accounting,
      now: new Date("2026-09-03T00:05:00.000Z")
    });

    expect(view.availability).toBe(availability);
    expect(view.snapshot).toBeNull();
    expect(view.accounting).toBeNull();
  });

  it("returns null gross coverage when there is no unresolved-payout denominator", () => {
    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation: reconciliationFixture({
        treasuryAssetsMicroUnits: "20000000",
        internalCustodyMicroUnits: "20000000",
        openStakeMicroUnits: "0",
        openReserveMicroUnits: "0",
        houseEquityMicroUnits: "0",
        unexplainedDeltaMicroUnits: "0",
        metrics: {
          softReservationCount: "0",
          softReservationStakeMicroUnits: "0",
          softReservationGrossPayoutMicroUnits: "0",
          softReservationOperatingChargeMicroUnits: "0"
        },
        treasuryAssets: [
          {
            chainId: 11155111,
            treasuryAddress,
            tokenAddress,
            balanceMicroUnits: "20000000",
            blockNumber: 123456n,
            blockHash,
            source: "onchain"
          }
        ]
      }),
      accounting: accountingFixture({
        grossAssetsMicroUnits: 20_000_000n,
        economicNavMicroUnits: 0n,
        activeShareUnits: 0n,
        sharePriceNumeratorMicroUnits: 0n,
        sharePriceDenominatorUnits: 0n,
        estimatedPnlMicroUnits: 0n,
        markedUnresolvedLiabilityMicroUnits: 0n,
        grossUnresolvedPayoutsMicroUnits: 0n,
        fullLiabilityFallbackMicroUnits: 0n,
        liabilityMarkCoverageBps: 10_000,
        collateralRequirementsMicroUnits: 20_000_000n,
        freeLiquidityMicroUnits: 0n
      }),
      now: new Date("2026-09-03T00:04:00.000Z")
    });

    expect(view.availability).toBe("available");
    expect(view.snapshot?.grossCoverage).toBeNull();
    expect(view.snapshot).toMatchObject({
      hardSolvencyFloorUsd: 20,
      operatingCoverageBufferUsd: 0,
      pendingBasketStakeUsd: 0,
      pendingBasketMaxPayoutUsd: 0,
      pendingBasketCount: 0,
      pendingBasketCapacityChargeUsd: 0,
      operatingWithdrawalFloorUsd: 20,
      capitalAboveWithdrawalFloorUsd: 0
    });
  });

  it("rounds the 25% operating buffer up to the micro-USDC", () => {
    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation: reconciliationFixture({
        treasuryAssetsMicroUnits: "20000004",
        internalCustodyMicroUnits: "20000004",
        userAvailableMicroUnits: "0",
        userClaimableMicroUnits: "0",
        userCheckoutMicroUnits: "0",
        pendingWithdrawalMicroUnits: "0",
        openStakeMicroUnits: "1",
        openReserveMicroUnits: "0",
        houseEquityMicroUnits: "20000003",
        unexplainedDeltaMicroUnits: "0",
        metrics: {
          softReservationCount: "0",
          softReservationStakeMicroUnits: "0",
          softReservationGrossPayoutMicroUnits: "0",
          softReservationOperatingChargeMicroUnits: "0"
        },
        treasuryAssets: [{
          chainId: 11155111,
          treasuryAddress,
          tokenAddress,
          balanceMicroUnits: "20000004",
          blockNumber: 123456n,
          blockHash,
          source: "onchain"
        }]
      }),
      accounting: accountingFixture({
        grossAssetsMicroUnits: 20_000_004n,
        economicNavMicroUnits: 20_000_003n,
        activeShareUnits: 20_000_003_000_000_000_000n,
        sharePriceNumeratorMicroUnits: 20_000_003n,
        sharePriceDenominatorUnits: 20_000_003_000_000_000_000n,
        estimatedPnlMicroUnits: 0n,
        markedUnresolvedLiabilityMicroUnits: 1n,
        grossUnresolvedPayoutsMicroUnits: 1n,
        fullLiabilityFallbackMicroUnits: 1n,
        collateralRequirementsMicroUnits: 1n,
        freeLiquidityMicroUnits: 20_000_003n
      }),
      now: new Date("2026-09-03T00:04:00.000Z")
    });

    expect(view.snapshot).toMatchObject({
      hardSolvencyFloorUsd: 0.000001,
      operatingCoverageBufferUsd: 0.000001,
      operatingWithdrawalFloorUsd: 0.000002,
      capitalAboveWithdrawalFloorUsd: 20.000002
    });
  });

  it("accepts the sum of per-intent pending capacity charges", () => {
    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation: reconciliationFixture({
        metrics: {
          softReservationCount: "2",
          softReservationStakeMicroUnits: "2",
          softReservationGrossPayoutMicroUnits: "202",
          softReservationOperatingChargeMicroUnits: "252"
        }
      }),
      accounting: accountingFixture(),
      now: new Date("2026-09-03T00:04:00.000Z")
    });

    expect(view.availability).toBe("available");
    expect(view.snapshot).toMatchObject({
      pendingBasketCount: 2,
      pendingBasketStakeUsd: 0.000002,
      pendingBasketMaxPayoutUsd: 0.000202,
      pendingBasketCapacityChargeUsd: 0.000252
    });
  });

  it("fails closed when a pending charge cannot be a per-intent sum", () => {
    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation: reconciliationFixture({
        metrics: {
          softReservationCount: "2",
          softReservationStakeMicroUnits: "2",
          softReservationGrossPayoutMicroUnits: "202",
          softReservationOperatingChargeMicroUnits: "250"
        }
      }),
      now: new Date("2026-09-03T00:04:00.000Z")
    });

    expect(view.availability).toBe("reconciliation_malformed");
    expect(view.snapshot).toBeNull();
  });

  it("combines an active global control gate with the reconciled vault view", () => {
    const view = deriveLpVaultPublicView({
      vault: vaultFixture(),
      globalReconciliation: reconciliationFixture({
        internalCustodyMicroUnits: "100000000",
        unexplainedDeltaMicroUnits: "0",
        launchGate: "ready",
        operationGate: "open",
        gateReasons: []
      }),
      accounting: accountingFixture(),
      financialControlGate: {
        scope: "global",
        operationGate: "restricted",
        reason: "supervised_pause",
        metadata: {},
        setAt: "2026-09-03T00:03:00.000Z"
      },
      now: new Date("2026-09-03T00:04:00.000Z")
    });

    expect(view.snapshot?.gate).toEqual({
      underwriting: "paused",
      seniorOperations: "restricted",
      lpWithdrawals: "not_live"
    });
  });

  it("provisions the deterministic singleton idempotently and verifies its immutable scope", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...vaultFixture(), createdAt: new Date("2026-09-03T00:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...vaultFixture(), createdAt: new Date("2026-09-03T00:00:00.000Z") }] });
    const queryable = { query } as never;

    await expect(provisionFounderSepoliaShadowVault({ treasuryAddress, queryable })).resolves.toMatchObject({
      id: FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
      depositsEnabled: false,
      communityCustody: false
    });
    await expect(provisionFounderSepoliaShadowVault({ treasuryAddress, queryable })).resolves.toMatchObject({
      id: FOUNDER_SEPOLIA_SHADOW_VAULT_ID
    });

    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO lp_vaults"))).toHaveLength(2);
    expect(query.mock.calls[0][1]).toContain(FOUNDER_SEPOLIA_SHADOW_VAULT_ID);
  });
});
