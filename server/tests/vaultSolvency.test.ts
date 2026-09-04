import { describe, expect, it } from "vitest";
import { evaluateVaultSolvency } from "../vaultSolvency";

describe("vault solvency", () => {
  it("treats stake plus net liability as the full payout without double counting", () => {
    const stake = 10_000_000n;
    const netLiability = 50_000_000n;
    const result = evaluateVaultSolvency({
      eligibleAssetsMicroUnits: 100_000_000n,
      seniorUserObligationsMicroUnits: 0n,
      grossUnresolvedPayoutsMicroUnits: stake + netLiability
    });

    expect(result.hardSolvencyFloorMicroUnits).toBe(60_000_000n);
    expect(result.liveTicketCoverageBufferMicroUnits).toBe(15_000_000n);
    expect(result.operatingWithdrawalFloorMicroUnits).toBe(75_000_000n);
    expect(result.capitalAboveWithdrawalFloorMicroUnits).toBe(25_000_000n);
  });

  it("distinguishes the 100% incident boundary from the 125% operating boundary", () => {
    const input = {
      seniorUserObligationsMicroUnits: 20_000_000n,
      grossUnresolvedPayoutsMicroUnits: 40_000_000n
    };
    expect(evaluateVaultSolvency({ ...input, eligibleAssetsMicroUnits: 59_999_999n }).status).toBe("collateral_shortfall");
    expect(evaluateVaultSolvency({ ...input, eligibleAssetsMicroUnits: 60_000_000n }).status).toBe("operating_buffer_breached");
    expect(evaluateVaultSolvency({ ...input, eligibleAssetsMicroUnits: 69_999_999n }).status).toBe("operating_buffer_breached");
    expect(evaluateVaultSolvency({ ...input, eligibleAssetsMicroUnits: 70_000_000n }).status).toBe("healthy");
  });

  it("reserves pending basket capacity at 125% after expected stake", () => {
    const result = evaluateVaultSolvency({
      eligibleAssetsMicroUnits: 100_000_000n,
      seniorUserObligationsMicroUnits: 0n,
      grossUnresolvedPayoutsMicroUnits: 0n,
      pendingBasketStakeMicroUnits: 10_000_000n,
      pendingBasketMaxPayoutMicroUnits: 60_000_001n
    });

    expect(result.pendingBasketCapacityChargeMicroUnits).toBe(65_000_002n);
    expect(result.capitalAboveWithdrawalFloorMicroUnits).toBe(34_999_998n);
  });

  it("accepts an exact per-intent pending charge without losing micro-USDC rounding", () => {
    const result = evaluateVaultSolvency({
      eligibleAssetsMicroUnits: 1_000n,
      seniorUserObligationsMicroUnits: 0n,
      grossUnresolvedPayoutsMicroUnits: 0n,
      pendingBasketStakeMicroUnits: 2n,
      pendingBasketMaxPayoutMicroUnits: 202n,
      pendingBasketCapacityChargeMicroUnits: 252n
    });

    expect(result.pendingBasketCapacityChargeMicroUnits).toBe(252n);
    expect(result.operatingWithdrawalFloorMicroUnits).toBe(252n);
  });

  it("reserves operating payables without changing the hard user solvency floor", () => {
    const result = evaluateVaultSolvency({
      eligibleAssetsMicroUnits: 100n,
      seniorUserObligationsMicroUnits: 10n,
      grossUnresolvedPayoutsMicroUnits: 20n,
      protocolFeePayableMicroUnits: 3n,
      approvedExpensePayableMicroUnits: 2n,
      lpRedemptionPayableMicroUnits: 5n,
      fixedOperatingBufferMicroUnits: 4n
    });

    expect(result.hardSolvencyFloorMicroUnits).toBe(30n);
    expect(result.operatingWithdrawalFloorMicroUnits).toBe(49n);
    expect(result.capitalAboveSolvencyFloorMicroUnits).toBe(70n);
    expect(result.capitalAboveWithdrawalFloorMicroUnits).toBe(51n);
  });

  it("rejects negative accounting inputs", () => {
    expect(() => evaluateVaultSolvency({
      eligibleAssetsMicroUnits: 1n,
      seniorUserObligationsMicroUnits: -1n,
      grossUnresolvedPayoutsMicroUnits: 0n
    })).toThrow("negative_vault_solvency_input:senior_user_obligations");
  });
});
