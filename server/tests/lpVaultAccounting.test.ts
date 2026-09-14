import { describe, expect, it } from "vitest";
import {
  GENESIS_SHARE_PRICE_FIXED,
  MICRO_USDC_PER_USDC,
  SHARE_PRICE_FIXED_SCALE,
  SHARE_UNITS_PER_SHARE,
  allocatePositionCostBasisMicroUsdc,
  calculateEconomicNav,
  calculatePositionValueMicroUsdc,
  calculateSharePriceFixed,
  estimatePositionPnl,
  finalizePositionPnl,
  finalizeRedemptionsAtEndPeriodPrice,
  markUnresolvedTicketLiability,
  mintSharesAtCommonPreDepositPrice
} from "../lpVaultAccounting";

const usdc = (whole: bigint) => whole * MICRO_USDC_PER_USDC;
const shares = (whole: bigint) => whole * SHARE_UNITS_PER_SHARE;

describe("LP vault economic NAV", () => {
  it("subtracts every approved economic liability and excludes active redemption reserves", () => {
    const result = calculateEconomicNav({
      eligibleReconciledAssetsMicroUsdc: usdc(200n),
      pendingDepositsMicroUsdc: usdc(10n),
      seniorUserObligationsMicroUsdc: usdc(20n),
      markedUnresolvedTicketLiabilitiesMicroUsdc: usdc(30n),
      maturedRedemptionPayablesMicroUsdc: usdc(15n),
      protocolFeePayableMicroUnits: usdc(7n),
      approvedAccruedVaultExpensesMicroUsdc: usdc(5n),
      activeRedemptionReservesMicroUsdc: usdc(99n)
    });

    expect(result.totalNavDeductionsMicroUsdc).toBe(usdc(87n));
    expect(result.economicNavMicroUsdc).toBe(usdc(113n));
    expect(result.protocolFeePayableMicroUnits).toBe(usdc(7n));
    expect(result.activeRedemptionReservesMicroUsdc).toBe(usdc(99n));
  });

  it("permits an exact zero NAV but rejects a negative NAV", () => {
    expect(calculateEconomicNav({
      eligibleReconciledAssetsMicroUsdc: 1n,
      pendingDepositsMicroUsdc: 1n,
      seniorUserObligationsMicroUsdc: 0n,
      markedUnresolvedTicketLiabilitiesMicroUsdc: 0n,
      maturedRedemptionPayablesMicroUsdc: 0n,
      protocolFeePayableMicroUnits: 0n,
      approvedAccruedVaultExpensesMicroUsdc: 0n
    }).economicNavMicroUsdc).toBe(0n);

    expect(() => calculateEconomicNav({
      eligibleReconciledAssetsMicroUsdc: 0n,
      pendingDepositsMicroUsdc: 1n,
      seniorUserObligationsMicroUsdc: 0n,
      markedUnresolvedTicketLiabilitiesMicroUsdc: 0n,
      maturedRedemptionPayablesMicroUsdc: 0n,
      protocolFeePayableMicroUnits: 0n,
      approvedAccruedVaultExpensesMicroUsdc: 0n
    })).toThrowError("lp_vault_economic_nav_negative");
  });

  it("rejects negative and non-bigint inputs with field-specific errors", () => {
    expect(() => calculateEconomicNav({
      eligibleReconciledAssetsMicroUsdc: -1n,
      pendingDepositsMicroUsdc: 0n,
      seniorUserObligationsMicroUsdc: 0n,
      markedUnresolvedTicketLiabilitiesMicroUsdc: 0n,
      maturedRedemptionPayablesMicroUsdc: 0n,
      protocolFeePayableMicroUnits: 0n,
      approvedAccruedVaultExpensesMicroUsdc: 0n
    })).toThrowError("invalid_lp_vault_eligible_reconciled_assets");
    expect(() => calculateEconomicNav({
      eligibleReconciledAssetsMicroUsdc: 1n,
      pendingDepositsMicroUsdc: 0 as unknown as bigint,
      seniorUserObligationsMicroUsdc: 0n,
      markedUnresolvedTicketLiabilitiesMicroUsdc: 0n,
      maturedRedemptionPayablesMicroUsdc: 0n,
      protocolFeePayableMicroUnits: 0n,
      approvedAccruedVaultExpensesMicroUsdc: 0n
    })).toThrowError("invalid_lp_vault_pending_deposits");
  });
});

describe("unresolved ticket liability marks", () => {
  const base = {
    grossPayoutMicroUsdc: usdc(100n),
    valuationAsOfEpochMs: 10_000n,
    maxMarkAgeMs: 1_000n
  };

  it("uses a reliable, complete, fresh mark", () => {
    expect(markUnresolvedTicketLiability({
      ...base,
      evidence: {
        markedLiabilityMicroUsdc: usdc(37n),
        asOfEpochMs: 9_000n,
        complete: true,
        reliable: true
      }
    })).toEqual({
      markedLiabilityMicroUsdc: usdc(37n),
      source: "reliable_mark",
      fallbackReason: null
    });
  });

  it.each([
    ["missing", undefined],
    ["incomplete", { markedLiabilityMicroUsdc: 1n, asOfEpochMs: 10_000n, complete: false, reliable: true }],
    ["unreliable", { markedLiabilityMicroUsdc: 1n, asOfEpochMs: 10_000n, complete: true, reliable: false }],
    ["stale", { markedLiabilityMicroUsdc: 1n, asOfEpochMs: 8_999n, complete: true, reliable: true }],
    ["malformed", { markedLiabilityMicroUsdc: -1n, asOfEpochMs: 10_000n, complete: true, reliable: true }],
    ["malformed", { markedLiabilityMicroUsdc: usdc(101n), asOfEpochMs: 10_000n, complete: true, reliable: true }],
    ["malformed", { markedLiabilityMicroUsdc: 1n, asOfEpochMs: 10_001n, complete: true, reliable: true }],
    ["malformed", { markedLiabilityMicroUsdc: 1 as unknown as bigint, asOfEpochMs: 10_000n, complete: true, reliable: true }]
  ] as const)("falls back to gross payout for %s evidence", (fallbackReason, evidence) => {
    expect(markUnresolvedTicketLiability({ ...base, evidence })).toEqual({
      markedLiabilityMicroUsdc: usdc(100n),
      source: "gross_payout_fallback",
      fallbackReason
    });
  });

  it("strictly validates the fallback and freshness policy inputs", () => {
    expect(() => markUnresolvedTicketLiability({ ...base, grossPayoutMicroUsdc: -1n })).toThrowError(
      "invalid_lp_vault_gross_ticket_payout"
    );
    expect(() => markUnresolvedTicketLiability({ ...base, maxMarkAgeMs: -1n })).toThrowError(
      "invalid_lp_vault_max_mark_age"
    );
  });
});

describe("share pricing and deposit minting", () => {
  it("uses a $1.00 genesis price and mints fixed-point shares for 1 micro-USDC", () => {
    expect(calculateSharePriceFixed(0n, 0n)).toBe(GENESIS_SHARE_PRICE_FIXED);

    const mint = mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: 0n,
      preDepositTotalShareUnits: 0n,
      deposits: [{ ownerId: "owner-a", depositMicroUsdc: 1n }]
    });

    expect(mint.preDepositSharePriceFixed).toBe(SHARE_PRICE_FIXED_SCALE);
    expect(mint.aggregateMintFloorShareUnits).toBe(1_000_000_000_000n);
    expect(mint.totalMintedShareUnits).toBe(1_000_000_000_000n);
    expect(mint.vaultRetainedMintDustShareUnits).toBe(0n);
    expect(mint.mintRemainderNumerator).toBe(0n);
  });

  it("calculates exact fixed-point prices after gains and losses", () => {
    expect(calculateSharePriceFixed(usdc(150n), shares(100n))).toBe(SHARE_PRICE_FIXED_SCALE * 3n / 2n);
    expect(calculateSharePriceFixed(usdc(25n), shares(100n))).toBe(SHARE_PRICE_FIXED_SCALE / 4n);
    expect(() => calculateSharePriceFixed(1n, 0n)).toThrowError("lp_vault_nav_without_shares");
  });

  it("mints every owner at one pre-deposit price and leaves identity-neutral dust unissued", () => {
    const mint = mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: 3n,
      preDepositTotalShareUnits: 5n,
      deposits: [
        { ownerId: "owner-b", depositMicroUsdc: 1n },
        { ownerId: "owner-a", depositMicroUsdc: 1n }
      ]
    });

    expect(mint.aggregateMintFloorShareUnits).toBe(3n);
    expect(mint.totalMintedShareUnits).toBe(2n);
    expect(mint.vaultRetainedMintDustShareUnits).toBe(1n);
    expect(mint.mintRemainderNumerator).toBe(1n);
    expect(mint.allocations).toEqual([
      {
        ownerId: "owner-a",
        depositMicroUsdc: 1n,
        mintedShareUnits: 1n,
        exactRemainderNumerator: 2n
      },
      {
        ownerId: "owner-b",
        depositMicroUsdc: 1n,
        mintedShareUnits: 1n,
        exactRemainderNumerator: 2n
      }
    ]);
  });

  it("is invariant to deposit order and splitting by the same owner", () => {
    const common = { preDepositEconomicNavMicroUsdc: 5n, preDepositTotalShareUnits: 7n };
    const unsplit = mintSharesAtCommonPreDepositPrice({
      ...common,
      deposits: [
        { ownerId: "owner-a", depositMicroUsdc: 3n },
        { ownerId: "owner-b", depositMicroUsdc: 2n }
      ]
    });
    const splitAndReordered = mintSharesAtCommonPreDepositPrice({
      ...common,
      deposits: [
        { ownerId: "owner-b", depositMicroUsdc: 2n },
        { ownerId: "owner-a", depositMicroUsdc: 1n },
        { ownerId: "owner-a", depositMicroUsdc: 2n }
      ]
    });

    expect(splitAndReordered).toEqual(unsplit);
    expect(unsplit.allocations.map(({ ownerId, mintedShareUnits }) => [ownerId, mintedShareUnits])).toEqual([
      ["owner-a", 4n],
      ["owner-b", 2n]
    ]);
    expect(unsplit.aggregateMintFloorShareUnits).toBe(7n);
    expect(unsplit.vaultRetainedMintDustShareUnits).toBe(1n);
  });

  it("never improves a controlled balance by splitting it across identities", () => {
    const common = { preDepositEconomicNavMicroUsdc: 5n, preDepositTotalShareUnits: 7n };
    const combined = mintSharesAtCommonPreDepositPrice({
      ...common,
      deposits: [{ ownerId: "controlled", depositMicroUsdc: 4n }]
    });
    const split = mintSharesAtCommonPreDepositPrice({
      ...common,
      deposits: [
        { ownerId: "wallet-a", depositMicroUsdc: 2n },
        { ownerId: "wallet-b", depositMicroUsdc: 2n }
      ]
    });

    expect(split.totalMintedShareUnits).toBeLessThanOrEqual(combined.totalMintedShareUnits);
    expect(combined.totalMintedShareUnits).toBe(5n);
    expect(split.totalMintedShareUnits).toBe(4n);
  });

  it("excludes pending deposits from pre-deposit NAV and preserves incumbent value after mint", () => {
    const nav = calculateEconomicNav({
      eligibleReconciledAssetsMicroUsdc: usdc(110n),
      pendingDepositsMicroUsdc: usdc(10n),
      seniorUserObligationsMicroUsdc: 0n,
      markedUnresolvedTicketLiabilitiesMicroUsdc: 0n,
      maturedRedemptionPayablesMicroUsdc: 0n,
      protocolFeePayableMicroUnits: 0n,
      approvedAccruedVaultExpensesMicroUsdc: 0n
    });
    const mint = mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: nav.economicNavMicroUsdc,
      preDepositTotalShareUnits: shares(100n),
      deposits: [{ ownerId: "new-owner", depositMicroUsdc: usdc(10n) }]
    });

    expect(mint.totalMintedShareUnits).toBe(shares(10n));
    expect(calculatePositionValueMicroUsdc(shares(100n), mint.postDepositTotalShareUnits, usdc(110n))).toBe(usdc(100n));
    expect(calculatePositionValueMicroUsdc(shares(10n), mint.postDepositTotalShareUnits, usdc(110n))).toBe(usdc(10n));
  });

  it("rejects inconsistent genesis state, zero-price minting, and malformed requests", () => {
    expect(() => mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: 1n,
      preDepositTotalShareUnits: 0n,
      deposits: [{ ownerId: "owner-a", depositMicroUsdc: 1n }]
    })).toThrowError("lp_vault_genesis_nav_without_shares");
    expect(() => mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: 0n,
      preDepositTotalShareUnits: 1n,
      deposits: [{ ownerId: "owner-a", depositMicroUsdc: 1n }]
    })).toThrowError("lp_vault_deposit_at_zero_share_price");
    expect(() => mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: 1n,
      preDepositTotalShareUnits: 1n,
      deposits: []
    })).toThrowError("invalid_lp_vault_deposits_empty");
    expect(() => mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: 1n,
      preDepositTotalShareUnits: 1n,
      deposits: [{ ownerId: " owner-a", depositMicroUsdc: 1n }]
    })).toThrowError("invalid_lp_vault_deposit_owner_id");
    expect(() => mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: 4n,
      preDepositTotalShareUnits: 3n,
      deposits: [
        { ownerId: "owner-a", depositMicroUsdc: 1n },
        { ownerId: "owner-b", depositMicroUsdc: 2n }
      ]
    })).toThrowError("lp_vault_deposit_owner_mints_zero_shares");
  });
});

describe("position value, cost, and P&L", () => {
  it("reports gains and losses as estimated until proceeds are finalized", () => {
    expect(estimatePositionPnl({
      shareUnits: shares(25n),
      totalShareUnits: shares(100n),
      economicNavMicroUsdc: usdc(120n),
      costBasisMicroUsdc: usdc(25n)
    })).toEqual({
      status: "estimated",
      shareUnits: shares(25n),
      estimatedValueMicroUsdc: usdc(30n),
      costBasisMicroUsdc: usdc(25n),
      estimatedPnlMicroUsdc: usdc(5n)
    });
    expect(finalizePositionPnl(usdc(20n), usdc(25n))).toEqual({
      status: "finalized",
      proceedsMicroUsdc: usdc(20n),
      costBasisMicroUsdc: usdc(25n),
      finalizedPnlMicroUsdc: -usdc(5n)
    });
  });

  it("allocates cost from a persistent lot and consumes all remaining basis on full burn", () => {
    const lot = { originalShareUnits: 3n, originalCostBasisMicroUsdc: 10n, burnedShareUnits: 0n };
    const partial = allocatePositionCostBasisMicroUsdc(lot, 1n);
    expect(partial).toMatchObject({
      allocatedCostBasisMicroUsdc: 3n,
      cumulativeAllocatedCostBasisMicroUsdc: 3n,
      remainingShareUnits: 2n,
      remainingCostBasisMicroUsdc: 7n,
      carriedRemainderNumerator: 1n,
      carriedRemainderDenominator: 3n
    });
    expect(allocatePositionCostBasisMicroUsdc(partial.nextLot, 2n)).toMatchObject({
      allocatedCostBasisMicroUsdc: 7n,
      cumulativeAllocatedCostBasisMicroUsdc: 10n,
      remainingShareUnits: 0n,
      remainingCostBasisMicroUsdc: 0n,
      carriedRemainderNumerator: 0n
    });
    expect(() => allocatePositionCostBasisMicroUsdc(lot, 4n)).toThrowError(
      "lp_vault_burn_exceeds_position"
    );
  });

  it("allocates the same cumulative basis for sequential and combined burns", () => {
    const lot = { originalShareUnits: 11n, originalCostBasisMicroUsdc: 17n, burnedShareUnits: 0n };
    const first = allocatePositionCostBasisMicroUsdc(lot, 3n);
    const second = allocatePositionCostBasisMicroUsdc(first.nextLot, 4n);
    const combined = allocatePositionCostBasisMicroUsdc(lot, 7n);

    expect(first.allocatedCostBasisMicroUsdc + second.allocatedCostBasisMicroUsdc).toBe(
      combined.allocatedCostBasisMicroUsdc
    );
    expect(second.cumulativeAllocatedCostBasisMicroUsdc).toBe(combined.cumulativeAllocatedCostBasisMicroUsdc);
    expect(second.remainingCostBasisMicroUsdc).toBe(combined.remainingCostBasisMicroUsdc);
    expect(second.nextLot).toEqual(combined.nextLot);
  });

  it("enforces position and supply bounds", () => {
    expect(() => calculatePositionValueMicroUsdc(2n, 1n, 1n)).toThrowError(
      "lp_vault_position_shares_exceed_supply"
    );
    expect(() => calculatePositionValueMicroUsdc(0n, 0n, 0n)).toThrowError(
      "invalid_lp_vault_total_share_units"
    );
  });
});

describe("redemption finalization", () => {
  it("burns shares at the end-period price and creates matured payables", () => {
    const result = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: usdc(120n),
      totalShareUnits: shares(100n),
      redemptions: [{ ownerId: "owner-a", shareUnits: shares(10n), availableShareUnits: shares(10n) }]
    });

    expect(result.endPeriodSharePriceFixed).toBe(SHARE_PRICE_FIXED_SCALE * 12n / 10n);
    expect(result.totalBurnedShareUnits).toBe(shares(10n));
    expect(result.endingTotalShareUnits).toBe(shares(90n));
    expect(result.aggregatePayoutFloorMicroUsdc).toBe(usdc(12n));
    expect(result.maturedRedemptionPayablesMicroUsdc).toBe(usdc(12n));
    expect(result.vaultRetainedPayoutDustMicroUsdc).toBe(0n);
    expect(result.lpRetainedPayoutDustMicroUsdc).toBe(0n);
    expect(result.protocolRoundingDustPayableMicroUsdc).toBe(0n);
    expect(result.lpEconomicNavAfterFinalizationMicroUsdc).toBe(usdc(108n));
    expect(calculateSharePriceFixed(
      result.lpEconomicNavAfterFinalizationMicroUsdc,
      result.endingTotalShareUnits
    )).toBe(result.endPeriodSharePriceFixed);
  });

  it("fully burns a zero-value vault and pays zero after a total loss", () => {
    const result = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 0n,
      totalShareUnits: shares(1n),
      redemptions: [{ ownerId: "owner-a", shareUnits: shares(1n), availableShareUnits: shares(1n) }]
    });

    expect(result.endPeriodSharePriceFixed).toBe(0n);
    expect(result.endingTotalShareUnits).toBe(0n);
    expect(result.maturedRedemptionPayablesMicroUsdc).toBe(0n);
    expect(result.protocolRoundingDustPayableMicroUsdc).toBe(0n);
    expect(result.lpEconomicNavAfterFinalizationMicroUsdc).toBe(0n);
  });

  it("leaves payout floor dust in the vault and is split/order invariant per owner", () => {
    const unsplit = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 5n,
      totalShareUnits: 7n,
      redemptions: [
        { ownerId: "owner-a", shareUnits: 3n, availableShareUnits: 3n },
        { ownerId: "owner-b", shareUnits: 2n, availableShareUnits: 2n },
        { ownerId: "owner-c", shareUnits: 1n, availableShareUnits: 1n }
      ]
    });
    const splitAndReordered = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 5n,
      totalShareUnits: 7n,
      redemptions: [
        { ownerId: "owner-c", shareUnits: 1n, availableShareUnits: 1n },
        { ownerId: "owner-a", shareUnits: 1n, availableShareUnits: 3n },
        { ownerId: "owner-b", shareUnits: 2n, availableShareUnits: 2n },
        { ownerId: "owner-a", shareUnits: 2n, availableShareUnits: 3n }
      ]
    });

    expect(splitAndReordered).toEqual(unsplit);
    expect(unsplit.aggregatePayoutFloorMicroUsdc).toBe(4n);
    expect(unsplit.maturedRedemptionPayablesMicroUsdc).toBe(3n);
    expect(unsplit.vaultRetainedPayoutDustMicroUsdc).toBe(1n);
    expect(unsplit.lpRetainedPayoutDustMicroUsdc).toBe(1n);
    expect(unsplit.protocolRoundingDustPayableMicroUsdc).toBe(0n);
    expect(unsplit.lpEconomicNavAfterFinalizationMicroUsdc).toBe(2n);
    expect(unsplit.allocations.map(({ ownerId, payableMicroUsdc }) => [ownerId, payableMicroUsdc])).toEqual([
      ["owner-a", 2n],
      ["owner-b", 1n],
      ["owner-c", 0n]
    ]);
  });

  it("reclassifies full-supply multi-owner dust as a protocol payable and closes LP NAV", () => {
    const result = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 5n,
      totalShareUnits: 2n,
      redemptions: [
        { ownerId: "owner-a", shareUnits: 1n, availableShareUnits: 1n },
        { ownerId: "owner-b", shareUnits: 1n, availableShareUnits: 1n }
      ]
    });

    expect(result.endingTotalShareUnits).toBe(0n);
    expect(result.aggregatePayoutFloorMicroUsdc).toBe(5n);
    expect(result.maturedRedemptionPayablesMicroUsdc).toBe(4n);
    expect(result.vaultRetainedPayoutDustMicroUsdc).toBe(1n);
    expect(result.lpRetainedPayoutDustMicroUsdc).toBe(0n);
    expect(result.protocolRoundingDustPayableMicroUsdc).toBe(1n);
    expect(result.lpEconomicNavAfterFinalizationMicroUsdc).toBe(0n);
    expect(
      result.maturedRedemptionPayablesMicroUsdc + result.protocolRoundingDustPayableMicroUsdc
    ).toBe(5n);
  });

  it("never improves redemption proceeds by splitting a holding across identities", () => {
    const combined = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 5n,
      totalShareUnits: 7n,
      redemptions: [{ ownerId: "controlled", shareUnits: 2n, availableShareUnits: 2n }]
    });
    const split = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 5n,
      totalShareUnits: 7n,
      redemptions: [
        { ownerId: "wallet-a", shareUnits: 1n, availableShareUnits: 1n },
        { ownerId: "wallet-b", shareUnits: 1n, availableShareUnits: 1n }
      ]
    });

    expect(split.maturedRedemptionPayablesMicroUsdc).toBeLessThanOrEqual(
      combined.maturedRedemptionPayablesMicroUsdc
    );
    expect(combined.maturedRedemptionPayablesMicroUsdc).toBe(1n);
    expect(split.maturedRedemptionPayablesMicroUsdc).toBe(0n);
  });

  it("rejects zero supply, over-redemption, empty batches, and nonpositive requests", () => {
    expect(() => finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 0n,
      totalShareUnits: 0n,
      redemptions: [{ ownerId: "owner-a", shareUnits: 1n, availableShareUnits: 1n }]
    })).toThrowError("invalid_lp_vault_total_share_units");
    expect(() => finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 1n,
      totalShareUnits: 1n,
      redemptions: [
        { ownerId: "owner-a", shareUnits: 1n, availableShareUnits: 1n },
        { ownerId: "owner-b", shareUnits: 1n, availableShareUnits: 1n }
      ]
    })).toThrowError("lp_vault_redemption_holdings_exceed_supply");
    expect(() => finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 1n,
      totalShareUnits: 1n,
      redemptions: []
    })).toThrowError("invalid_lp_vault_redemptions_empty");
    expect(() => finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 1n,
      totalShareUnits: 1n,
      redemptions: [{ ownerId: "owner-a", shareUnits: 0n, availableShareUnits: 1n }]
    })).toThrowError("invalid_lp_vault_redemption_amount");
  });

  it("validates each owner's available holding and duplicate holding evidence", () => {
    expect(() => finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 10n,
      totalShareUnits: 10n,
      redemptions: [{ ownerId: "owner-a", shareUnits: 4n, availableShareUnits: 3n }]
    })).toThrowError("lp_vault_redemption_exceeds_owner_holding");
    expect(() => finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 10n,
      totalShareUnits: 10n,
      redemptions: [
        { ownerId: "owner-a", shareUnits: 1n, availableShareUnits: 3n },
        { ownerId: "owner-a", shareUnits: 1n, availableShareUnits: 4n }
      ]
    })).toThrowError("lp_vault_inconsistent_redemption_holding");
    expect(() => finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 10n,
      totalShareUnits: 10n,
      redemptions: [{ ownerId: "owner-a", shareUnits: 1n, availableShareUnits: 11n }]
    })).toThrowError("lp_vault_redemption_holding_exceeds_supply");
    expect(() => finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: 10n,
      totalShareUnits: 10n,
      redemptions: [
        { ownerId: "owner-a", shareUnits: 1n, availableShareUnits: 6n },
        { ownerId: "owner-b", shareUnits: 1n, availableShareUnits: 5n }
      ]
    })).toThrowError("lp_vault_redemption_holdings_exceed_supply");
  });
});

describe("randomized accounting invariants", () => {
  function randomSource(initial: bigint) {
    let state = initial;
    return () => {
      state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % (2n ** 64n);
      return state;
    };
  }

  it("conserves aggregate mint floors and vault-retained share dust", () => {
    const random = randomSource(0x5eedn);
    const ownerIds = ["owner-a", "owner-b", "owner-c", "owner-d"];

    for (let scenario = 0; scenario < 128; scenario += 1) {
      const nav = random() % 100_000n + 1n;
      const supply = nav + random() % (nav * 9n + 1n);
      const deposits = ownerIds.map((ownerId) => ({
        ownerId,
        depositMicroUsdc: random() % 10_000n + 1n
      }));
      const result = mintSharesAtCommonPreDepositPrice({
        preDepositEconomicNavMicroUsdc: nav,
        preDepositTotalShareUnits: supply,
        deposits
      });
      const totalDeposit = deposits.reduce((sum, deposit) => sum + deposit.depositMicroUsdc, 0n);
      const allocated = result.allocations.reduce((sum, allocation) => sum + allocation.mintedShareUnits, 0n);

      expect(result.totalDepositMicroUsdc).toBe(totalDeposit);
      expect(result.aggregateMintFloorShareUnits).toBe(totalDeposit * supply / nav);
      expect(result.mintRemainderNumerator).toBe(totalDeposit * supply % nav);
      expect(result.totalMintedShareUnits).toBe(allocated);
      expect(result.totalMintedShareUnits + result.vaultRetainedMintDustShareUnits).toBe(
        result.aggregateMintFloorShareUnits
      );
      expect(result.postDepositTotalShareUnits).toBe(supply + allocated);
      for (const allocation of result.allocations) {
        expect(allocation.mintedShareUnits).toBe(allocation.depositMicroUsdc * supply / nav);
        expect(allocation.exactRemainderNumerator).toBe(allocation.depositMicroUsdc * supply % nav);
      }
    }
  });

  it("conserves partial-redemption payables while leaving floor dust in LP NAV", () => {
    const random = randomSource(0xc0ffen);
    const ownerIds = ["owner-a", "owner-b", "owner-c", "owner-d"];

    for (let scenario = 0; scenario < 128; scenario += 1) {
      const nav = random() % 100_000n;
      const redemptions = ownerIds.map((ownerId) => {
        const holding = random() % 10_000n + 1n;
        return { ownerId, shareUnits: holding, availableShareUnits: holding };
      });
      const totalBurn = redemptions.reduce((sum, redemption) => sum + redemption.shareUnits, 0n);
      const supply = totalBurn + random() % 10_000n + 1n;
      const result = finalizeRedemptionsAtEndPeriodPrice({
        endPeriodEconomicNavMicroUsdc: nav,
        totalShareUnits: supply,
        redemptions
      });
      const ownerPayables = result.allocations.reduce((sum, allocation) => sum + allocation.payableMicroUsdc, 0n);

      expect(result.totalBurnedShareUnits).toBe(totalBurn);
      expect(result.aggregatePayoutFloorMicroUsdc).toBe(totalBurn * nav / supply);
      expect(result.payoutRemainderNumerator).toBe(totalBurn * nav % supply);
      expect(result.maturedRedemptionPayablesMicroUsdc).toBe(ownerPayables);
      expect(ownerPayables + result.vaultRetainedPayoutDustMicroUsdc).toBe(
        result.aggregatePayoutFloorMicroUsdc
      );
      expect(result.lpRetainedPayoutDustMicroUsdc).toBe(result.vaultRetainedPayoutDustMicroUsdc);
      expect(result.protocolRoundingDustPayableMicroUsdc).toBe(0n);
      expect(result.lpEconomicNavAfterFinalizationMicroUsdc + ownerPayables).toBe(nav);
    }
  });

  it("closes LP NAV and reconciles protocol dust on randomized full-supply multi-owner burns", () => {
    const random = randomSource(0xf011n);
    const ownerIds = ["owner-a", "owner-b", "owner-c", "owner-d"];

    for (let scenario = 0; scenario < 128; scenario += 1) {
      const nav = random() % 100_000n;
      const redemptions = ownerIds.map((ownerId) => {
        const holding = random() % 10_000n + 1n;
        return { ownerId, shareUnits: holding, availableShareUnits: holding };
      });
      const supply = redemptions.reduce((sum, redemption) => sum + redemption.shareUnits, 0n);
      const result = finalizeRedemptionsAtEndPeriodPrice({
        endPeriodEconomicNavMicroUsdc: nav,
        totalShareUnits: supply,
        redemptions
      });
      const ownerPayables = result.allocations.reduce((sum, allocation) => sum + allocation.payableMicroUsdc, 0n);

      expect(result.totalBurnedShareUnits).toBe(supply);
      expect(result.endingTotalShareUnits).toBe(0n);
      expect(result.aggregatePayoutFloorMicroUsdc).toBe(nav);
      expect(result.payoutRemainderNumerator).toBe(0n);
      expect(result.maturedRedemptionPayablesMicroUsdc).toBe(ownerPayables);
      expect(result.vaultRetainedPayoutDustMicroUsdc).toBe(nav - ownerPayables);
      expect(result.lpRetainedPayoutDustMicroUsdc).toBe(0n);
      expect(result.protocolRoundingDustPayableMicroUsdc).toBe(nav - ownerPayables);
      expect(
        ownerPayables + result.protocolRoundingDustPayableMicroUsdc
      ).toBe(nav);
      expect(result.lpEconomicNavAfterFinalizationMicroUsdc).toBe(0n);
      expect(calculateSharePriceFixed(
        result.lpEconomicNavAfterFinalizationMicroUsdc,
        result.endingTotalShareUnits
      )).toBe(GENESIS_SHARE_PRICE_FIXED);
    }
  });
});

describe("bigint range safety", () => {
  it("keeps exact behavior far beyond Number.MAX_SAFE_INTEGER without overflow", () => {
    const huge = 2n ** 512n;
    const nav = calculateEconomicNav({
      eligibleReconciledAssetsMicroUsdc: huge * 9n,
      pendingDepositsMicroUsdc: huge,
      seniorUserObligationsMicroUsdc: huge,
      markedUnresolvedTicketLiabilitiesMicroUsdc: huge,
      maturedRedemptionPayablesMicroUsdc: huge,
      protocolFeePayableMicroUnits: huge,
      approvedAccruedVaultExpensesMicroUsdc: huge
    });
    expect(nav.economicNavMicroUsdc).toBe(huge * 3n);

    const mint = mintSharesAtCommonPreDepositPrice({
      preDepositEconomicNavMicroUsdc: huge * 3n,
      preDepositTotalShareUnits: huge * 8n,
      deposits: [{ ownerId: "owner-a", depositMicroUsdc: huge * 3n }]
    });
    expect(mint.totalMintedShareUnits).toBe(huge * 8n);

    const redemption = finalizeRedemptionsAtEndPeriodPrice({
      endPeriodEconomicNavMicroUsdc: huge * 7n,
      totalShareUnits: huge * 14n,
      redemptions: [{
        ownerId: "owner-a",
        shareUnits: huge * 6n,
        availableShareUnits: huge * 6n
      }]
    });
    expect(redemption.maturedRedemptionPayablesMicroUsdc).toBe(huge * 3n);
  });
});
