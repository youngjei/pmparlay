export const MICRO_USDC_PER_USDC = 1_000_000n;
export const SHARE_UNITS_PER_SHARE = 1_000_000_000_000_000_000n;
export const SHARE_PRICE_FIXED_SCALE = 1_000_000_000_000_000_000n;
export const GENESIS_SHARE_PRICE_FIXED = SHARE_PRICE_FIXED_SCALE;

export type EconomicNavInput = {
  eligibleReconciledAssetsMicroUsdc: bigint;
  pendingDepositsMicroUsdc: bigint;
  seniorUserObligationsMicroUsdc: bigint;
  markedUnresolvedTicketLiabilitiesMicroUsdc: bigint;
  maturedRedemptionPayablesMicroUsdc: bigint;
  protocolFeePayableMicroUnits: bigint;
  approvedAccruedVaultExpensesMicroUsdc: bigint;
  activeRedemptionReservesMicroUsdc?: bigint;
};

export type EconomicNavResult = EconomicNavInput & {
  activeRedemptionReservesMicroUsdc: bigint;
  totalNavDeductionsMicroUsdc: bigint;
  economicNavMicroUsdc: bigint;
};

export type TicketLiabilityMarkEvidence = {
  markedLiabilityMicroUsdc: bigint;
  asOfEpochMs: bigint;
  complete: boolean;
  reliable: boolean;
};

export type TicketLiabilityMarkInput = {
  grossPayoutMicroUsdc: bigint;
  valuationAsOfEpochMs: bigint;
  maxMarkAgeMs: bigint;
  evidence?: TicketLiabilityMarkEvidence | null;
};

export type TicketLiabilityMarkResult =
  | {
      markedLiabilityMicroUsdc: bigint;
      source: "reliable_mark";
      fallbackReason: null;
    }
  | {
      markedLiabilityMicroUsdc: bigint;
      source: "gross_payout_fallback";
      fallbackReason: "missing" | "incomplete" | "unreliable" | "stale" | "malformed";
    };

export type DepositMintRequest = {
  ownerId: string;
  depositMicroUsdc: bigint;
};

export type DepositMintAllocation = {
  ownerId: string;
  depositMicroUsdc: bigint;
  mintedShareUnits: bigint;
  exactRemainderNumerator: bigint;
};

export type MintSharesInput = {
  preDepositEconomicNavMicroUsdc: bigint;
  preDepositTotalShareUnits: bigint;
  deposits: readonly DepositMintRequest[];
};

export type MintSharesResult = {
  preDepositSharePriceFixed: bigint;
  totalDepositMicroUsdc: bigint;
  /** Floor of the batch's exact mint before per-identity floors are summed. */
  aggregateMintFloorShareUnits: bigint;
  /** Sum of owner mint floors; these are the only share units issued. */
  totalMintedShareUnits: bigint;
  postDepositTotalShareUnits: bigint;
  /** Whole share units withheld instead of assigning rounding priority to an identity. */
  vaultRetainedMintDustShareUnits: bigint;
  mintRemainderNumerator: bigint;
  mintRemainderDenominator: bigint;
  allocations: DepositMintAllocation[];
};

export type RedemptionRequest = {
  ownerId: string;
  shareUnits: bigint;
  availableShareUnits: bigint;
};

export type RedemptionAllocation = {
  ownerId: string;
  availableShareUnitsBeforeBurn: bigint;
  burnedShareUnits: bigint;
  payableMicroUsdc: bigint;
  exactRemainderNumerator: bigint;
};

export type FinalizeRedemptionsInput = {
  endPeriodEconomicNavMicroUsdc: bigint;
  totalShareUnits: bigint;
  redemptions: readonly RedemptionRequest[];
};

export type FinalizeRedemptionsResult = {
  endPeriodSharePriceFixed: bigint;
  totalBurnedShareUnits: bigint;
  endingTotalShareUnits: bigint;
  /** Floor of the batch's exact payout before per-identity floors are summed. */
  aggregatePayoutFloorMicroUsdc: bigint;
  /** Sum of owner payout floors and the amount booked to owner payables. */
  maturedRedemptionPayablesMicroUsdc: bigint;
  /** Whole micro-USDC not assigned to owners by identity-floor rounding. */
  vaultRetainedPayoutDustMicroUsdc: bigint;
  /** Rounding dust that remains attributable to active shares after a partial burn. */
  lpRetainedPayoutDustMicroUsdc: bigint;
  /** Final-supply rounding dust reclassified out of LP NAV for protocol payment. */
  protocolRoundingDustPayableMicroUsdc: bigint;
  lpEconomicNavAfterFinalizationMicroUsdc: bigint;
  payoutRemainderNumerator: bigint;
  payoutRemainderDenominator: bigint;
  allocations: RedemptionAllocation[];
};

export type EstimatedPositionPnl = {
  status: "estimated";
  shareUnits: bigint;
  estimatedValueMicroUsdc: bigint;
  costBasisMicroUsdc: bigint;
  estimatedPnlMicroUsdc: bigint;
};

export type FinalizedPositionPnl = {
  status: "finalized";
  proceedsMicroUsdc: bigint;
  costBasisMicroUsdc: bigint;
  finalizedPnlMicroUsdc: bigint;
};

/** Immutable original lot terms plus the cumulative burn cursor persisted between burns. */
export type PositionCostBasisLot = {
  originalShareUnits: bigint;
  originalCostBasisMicroUsdc: bigint;
  burnedShareUnits: bigint;
};

export type PositionCostBasisBurn = {
  allocatedCostBasisMicroUsdc: bigint;
  cumulativeAllocatedCostBasisMicroUsdc: bigint;
  remainingShareUnits: bigint;
  remainingCostBasisMicroUsdc: bigint;
  carriedRemainderNumerator: bigint;
  carriedRemainderDenominator: bigint;
  nextLot: PositionCostBasisLot;
};

type ProRataClaim = {
  ownerId: string;
  weight: bigint;
};

type ProRataAllocation = ProRataClaim & {
  amount: bigint;
  remainder: bigint;
};

type RedemptionClaim = ProRataClaim & {
  availableShareUnits: bigint;
};

function assertNonnegativeBigint(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`invalid_lp_vault_${field}`);
}

function assertPositiveBigint(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== "bigint" || value <= 0n) throw new Error(`invalid_lp_vault_${field}`);
}

function compareOwnerIds(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateOwnerId(ownerId: unknown, field: string): asserts ownerId is string {
  if (typeof ownerId !== "string" || ownerId.length === 0 || ownerId.trim() !== ownerId) {
    throw new Error(`invalid_lp_vault_${field}_owner_id`);
  }
}

function aggregateClaims<T>(
  entries: readonly T[],
  field: "deposit" | "redemption",
  ownerId: (entry: T) => unknown,
  amount: (entry: T) => unknown
): ProRataClaim[] {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`invalid_lp_vault_${field}s_empty`);

  const byOwner = new Map<string, bigint>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error(`invalid_lp_vault_${field}`);
    const id = ownerId(entry);
    const value = amount(entry);
    validateOwnerId(id, field);
    assertPositiveBigint(value, `${field}_amount`);
    byOwner.set(id, (byOwner.get(id) ?? 0n) + value);
  }

  return [...byOwner.entries()]
    .sort(([left], [right]) => compareOwnerIds(left, right))
    .map(([id, weight]) => ({ ownerId: id, weight }));
}

function allocateIdentityFloors(
  claims: readonly ProRataClaim[],
  multiplier: bigint,
  denominator: bigint
): {
  totalWeight: bigint;
  aggregateFloorAmount: bigint;
  allocatedAmount: bigint;
  vaultRetainedFloorDust: bigint;
  totalRemainder: bigint;
  allocations: ProRataAllocation[];
} {
  const totalWeight = claims.reduce((sum, claim) => sum + claim.weight, 0n);
  const totalNumerator = totalWeight * multiplier;
  const aggregateFloorAmount = totalNumerator / denominator;
  const totalRemainder = totalNumerator % denominator;
  const allocations = claims.map((claim) => {
    const numerator = claim.weight * multiplier;
    return {
      ...claim,
      amount: numerator / denominator,
      remainder: numerator % denominator
    };
  });
  const allocatedAmount = allocations.reduce((sum, allocation) => sum + allocation.amount, 0n);

  return {
    totalWeight,
    aggregateFloorAmount,
    allocatedAmount,
    vaultRetainedFloorDust: aggregateFloorAmount - allocatedAmount,
    totalRemainder,
    allocations
  };
}

function aggregateRedemptions(redemptions: readonly RedemptionRequest[]): RedemptionClaim[] {
  if (!Array.isArray(redemptions) || redemptions.length === 0) {
    throw new Error("invalid_lp_vault_redemptions_empty");
  }

  const byOwner = new Map<string, RedemptionClaim>();
  for (const redemption of redemptions) {
    if (!redemption || typeof redemption !== "object") throw new Error("invalid_lp_vault_redemption");
    validateOwnerId(redemption.ownerId, "redemption");
    assertPositiveBigint(redemption.shareUnits, "redemption_amount");
    assertPositiveBigint(redemption.availableShareUnits, "redemption_available_shares");
    const existing = byOwner.get(redemption.ownerId);
    if (existing && existing.availableShareUnits !== redemption.availableShareUnits) {
      throw new Error("lp_vault_inconsistent_redemption_holding");
    }
    byOwner.set(redemption.ownerId, {
      ownerId: redemption.ownerId,
      weight: (existing?.weight ?? 0n) + redemption.shareUnits,
      availableShareUnits: redemption.availableShareUnits
    });
  }

  const claims = [...byOwner.values()].sort((left, right) => compareOwnerIds(left.ownerId, right.ownerId));
  for (const claim of claims) {
    if (claim.weight > claim.availableShareUnits) throw new Error("lp_vault_redemption_exceeds_owner_holding");
  }
  return claims;
}

export function calculateEconomicNav(input: EconomicNavInput): EconomicNavResult {
  assertNonnegativeBigint(input.eligibleReconciledAssetsMicroUsdc, "eligible_reconciled_assets");
  assertNonnegativeBigint(input.pendingDepositsMicroUsdc, "pending_deposits");
  assertNonnegativeBigint(input.seniorUserObligationsMicroUsdc, "senior_user_obligations");
  assertNonnegativeBigint(
    input.markedUnresolvedTicketLiabilitiesMicroUsdc,
    "marked_unresolved_ticket_liabilities"
  );
  assertNonnegativeBigint(input.maturedRedemptionPayablesMicroUsdc, "matured_redemption_payables");
  assertNonnegativeBigint(input.protocolFeePayableMicroUnits, "protocol_fee_payable");
  assertNonnegativeBigint(input.approvedAccruedVaultExpensesMicroUsdc, "approved_accrued_vault_expenses");
  const activeRedemptionReservesMicroUsdc = input.activeRedemptionReservesMicroUsdc ?? 0n;
  assertNonnegativeBigint(activeRedemptionReservesMicroUsdc, "active_redemption_reserves");

  const totalNavDeductionsMicroUsdc =
    input.pendingDepositsMicroUsdc +
    input.seniorUserObligationsMicroUsdc +
    input.markedUnresolvedTicketLiabilitiesMicroUsdc +
    input.maturedRedemptionPayablesMicroUsdc +
    input.protocolFeePayableMicroUnits +
    input.approvedAccruedVaultExpensesMicroUsdc;
  if (totalNavDeductionsMicroUsdc > input.eligibleReconciledAssetsMicroUsdc) {
    throw new Error("lp_vault_economic_nav_negative");
  }

  return {
    ...input,
    activeRedemptionReservesMicroUsdc,
    totalNavDeductionsMicroUsdc,
    economicNavMicroUsdc: input.eligibleReconciledAssetsMicroUsdc - totalNavDeductionsMicroUsdc
  };
}

export function markUnresolvedTicketLiability(input: TicketLiabilityMarkInput): TicketLiabilityMarkResult {
  assertNonnegativeBigint(input.grossPayoutMicroUsdc, "gross_ticket_payout");
  assertNonnegativeBigint(input.valuationAsOfEpochMs, "valuation_as_of");
  assertNonnegativeBigint(input.maxMarkAgeMs, "max_mark_age");

  const fallback = (
    fallbackReason: Exclude<TicketLiabilityMarkResult["fallbackReason"], null>
  ): TicketLiabilityMarkResult => ({
    markedLiabilityMicroUsdc: input.grossPayoutMicroUsdc,
    source: "gross_payout_fallback",
    fallbackReason
  });
  const evidence = input.evidence;
  if (evidence === undefined || evidence === null) return fallback("missing");
  if (
    typeof evidence !== "object" ||
    typeof evidence.markedLiabilityMicroUsdc !== "bigint" ||
    evidence.markedLiabilityMicroUsdc < 0n ||
    evidence.markedLiabilityMicroUsdc > input.grossPayoutMicroUsdc ||
    typeof evidence.asOfEpochMs !== "bigint" ||
    evidence.asOfEpochMs < 0n ||
    typeof evidence.complete !== "boolean" ||
    typeof evidence.reliable !== "boolean" ||
    evidence.asOfEpochMs > input.valuationAsOfEpochMs
  ) {
    return fallback("malformed");
  }
  if (!evidence.complete) return fallback("incomplete");
  if (!evidence.reliable) return fallback("unreliable");
  if (input.valuationAsOfEpochMs - evidence.asOfEpochMs > input.maxMarkAgeMs) return fallback("stale");

  return {
    markedLiabilityMicroUsdc: evidence.markedLiabilityMicroUsdc,
    source: "reliable_mark",
    fallbackReason: null
  };
}

export function calculateSharePriceFixed(economicNavMicroUsdc: bigint, totalShareUnits: bigint): bigint {
  assertNonnegativeBigint(economicNavMicroUsdc, "economic_nav");
  assertNonnegativeBigint(totalShareUnits, "total_share_units");
  if (totalShareUnits === 0n) {
    if (economicNavMicroUsdc > 0n) throw new Error("lp_vault_nav_without_shares");
    return GENESIS_SHARE_PRICE_FIXED;
  }

  return (
    economicNavMicroUsdc * SHARE_UNITS_PER_SHARE * SHARE_PRICE_FIXED_SCALE /
    (MICRO_USDC_PER_USDC * totalShareUnits)
  );
}

export function mintSharesAtCommonPreDepositPrice(input: MintSharesInput): MintSharesResult {
  assertNonnegativeBigint(input.preDepositEconomicNavMicroUsdc, "pre_deposit_economic_nav");
  assertNonnegativeBigint(input.preDepositTotalShareUnits, "pre_deposit_total_share_units");
  if (input.preDepositTotalShareUnits === 0n && input.preDepositEconomicNavMicroUsdc !== 0n) {
    throw new Error("lp_vault_genesis_nav_without_shares");
  }
  if (input.preDepositTotalShareUnits > 0n && input.preDepositEconomicNavMicroUsdc === 0n) {
    throw new Error("lp_vault_deposit_at_zero_share_price");
  }

  const claims = aggregateClaims(
    input.deposits,
    "deposit",
    (deposit) => deposit.ownerId,
    (deposit) => deposit.depositMicroUsdc
  );
  const multiplier = input.preDepositTotalShareUnits === 0n
    ? SHARE_UNITS_PER_SHARE
    : input.preDepositTotalShareUnits;
  const denominator = input.preDepositTotalShareUnits === 0n
    ? MICRO_USDC_PER_USDC
    : input.preDepositEconomicNavMicroUsdc;
  const allocation = allocateIdentityFloors(claims, multiplier, denominator);
  if (allocation.allocatedAmount === 0n) throw new Error("lp_vault_deposit_mints_zero_shares");
  if (allocation.allocations.some((ownerAllocation) => ownerAllocation.amount === 0n)) {
    throw new Error("lp_vault_deposit_owner_mints_zero_shares");
  }

  return {
    preDepositSharePriceFixed: calculateSharePriceFixed(
      input.preDepositEconomicNavMicroUsdc,
      input.preDepositTotalShareUnits
    ),
    totalDepositMicroUsdc: allocation.totalWeight,
    aggregateMintFloorShareUnits: allocation.aggregateFloorAmount,
    totalMintedShareUnits: allocation.allocatedAmount,
    postDepositTotalShareUnits: input.preDepositTotalShareUnits + allocation.allocatedAmount,
    vaultRetainedMintDustShareUnits: allocation.vaultRetainedFloorDust,
    mintRemainderNumerator: allocation.totalRemainder,
    mintRemainderDenominator: denominator,
    allocations: allocation.allocations.map((ownerAllocation) => ({
      ownerId: ownerAllocation.ownerId,
      depositMicroUsdc: ownerAllocation.weight,
      mintedShareUnits: ownerAllocation.amount,
      exactRemainderNumerator: ownerAllocation.remainder
    }))
  };
}

export function calculatePositionValueMicroUsdc(
  shareUnits: bigint,
  totalShareUnits: bigint,
  economicNavMicroUsdc: bigint
): bigint {
  assertNonnegativeBigint(shareUnits, "position_share_units");
  assertPositiveBigint(totalShareUnits, "total_share_units");
  assertNonnegativeBigint(economicNavMicroUsdc, "economic_nav");
  if (shareUnits > totalShareUnits) throw new Error("lp_vault_position_shares_exceed_supply");
  return shareUnits * economicNavMicroUsdc / totalShareUnits;
}

export function allocatePositionCostBasisMicroUsdc(
  lot: PositionCostBasisLot,
  burnShareUnits: bigint
): PositionCostBasisBurn {
  assertPositiveBigint(lot.originalShareUnits, "original_position_share_units");
  assertNonnegativeBigint(lot.originalCostBasisMicroUsdc, "original_position_cost_basis");
  assertNonnegativeBigint(lot.burnedShareUnits, "previously_burned_share_units");
  assertPositiveBigint(burnShareUnits, "burned_share_units");
  if (lot.burnedShareUnits > lot.originalShareUnits) throw new Error("lp_vault_invalid_cost_basis_lot");
  const nextBurnedShareUnits = lot.burnedShareUnits + burnShareUnits;
  if (nextBurnedShareUnits > lot.originalShareUnits) throw new Error("lp_vault_burn_exceeds_position");

  const priorCumulativeCostBasis =
    lot.originalCostBasisMicroUsdc * lot.burnedShareUnits / lot.originalShareUnits;
  const nextCumulativeCostBasis = nextBurnedShareUnits === lot.originalShareUnits
    ? lot.originalCostBasisMicroUsdc
    : lot.originalCostBasisMicroUsdc * nextBurnedShareUnits / lot.originalShareUnits;
  return {
    allocatedCostBasisMicroUsdc: nextCumulativeCostBasis - priorCumulativeCostBasis,
    cumulativeAllocatedCostBasisMicroUsdc: nextCumulativeCostBasis,
    remainingShareUnits: lot.originalShareUnits - nextBurnedShareUnits,
    remainingCostBasisMicroUsdc: lot.originalCostBasisMicroUsdc - nextCumulativeCostBasis,
    carriedRemainderNumerator:
      lot.originalCostBasisMicroUsdc * nextBurnedShareUnits % lot.originalShareUnits,
    carriedRemainderDenominator: lot.originalShareUnits,
    nextLot: {
      ...lot,
      burnedShareUnits: nextBurnedShareUnits
    }
  };
}

export function estimatePositionPnl(input: {
  shareUnits: bigint;
  totalShareUnits: bigint;
  economicNavMicroUsdc: bigint;
  costBasisMicroUsdc: bigint;
}): EstimatedPositionPnl {
  assertNonnegativeBigint(input.costBasisMicroUsdc, "position_cost_basis");
  const estimatedValueMicroUsdc = calculatePositionValueMicroUsdc(
    input.shareUnits,
    input.totalShareUnits,
    input.economicNavMicroUsdc
  );
  return {
    status: "estimated",
    shareUnits: input.shareUnits,
    estimatedValueMicroUsdc,
    costBasisMicroUsdc: input.costBasisMicroUsdc,
    estimatedPnlMicroUsdc: estimatedValueMicroUsdc - input.costBasisMicroUsdc
  };
}

export function finalizePositionPnl(proceedsMicroUsdc: bigint, costBasisMicroUsdc: bigint): FinalizedPositionPnl {
  assertNonnegativeBigint(proceedsMicroUsdc, "position_proceeds");
  assertNonnegativeBigint(costBasisMicroUsdc, "position_cost_basis");
  return {
    status: "finalized",
    proceedsMicroUsdc,
    costBasisMicroUsdc,
    finalizedPnlMicroUsdc: proceedsMicroUsdc - costBasisMicroUsdc
  };
}

export function finalizeRedemptionsAtEndPeriodPrice(
  input: FinalizeRedemptionsInput
): FinalizeRedemptionsResult {
  assertNonnegativeBigint(input.endPeriodEconomicNavMicroUsdc, "end_period_economic_nav");
  assertPositiveBigint(input.totalShareUnits, "total_share_units");
  const claims = aggregateRedemptions(input.redemptions);
  for (const claim of claims) {
    if (claim.availableShareUnits > input.totalShareUnits) {
      throw new Error("lp_vault_redemption_holding_exceeds_supply");
    }
  }
  const declaredHoldings = claims.reduce((sum, claim) => sum + claim.availableShareUnits, 0n);
  if (declaredHoldings > input.totalShareUnits) {
    throw new Error("lp_vault_redemption_holdings_exceed_supply");
  }
  const allocation = allocateIdentityFloors(
    claims,
    input.endPeriodEconomicNavMicroUsdc,
    input.totalShareUnits
  );
  if (allocation.totalWeight > input.totalShareUnits) throw new Error("lp_vault_redemptions_exceed_supply");
  const isFullSupplyBurn = allocation.totalWeight === input.totalShareUnits;
  const protocolRoundingDustPayableMicroUsdc = isFullSupplyBurn
    ? allocation.vaultRetainedFloorDust
    : 0n;

  return {
    endPeriodSharePriceFixed: calculateSharePriceFixed(
      input.endPeriodEconomicNavMicroUsdc,
      input.totalShareUnits
    ),
    totalBurnedShareUnits: allocation.totalWeight,
    endingTotalShareUnits: input.totalShareUnits - allocation.totalWeight,
    aggregatePayoutFloorMicroUsdc: allocation.aggregateFloorAmount,
    maturedRedemptionPayablesMicroUsdc: allocation.allocatedAmount,
    vaultRetainedPayoutDustMicroUsdc: allocation.vaultRetainedFloorDust,
    lpRetainedPayoutDustMicroUsdc: isFullSupplyBurn ? 0n : allocation.vaultRetainedFloorDust,
    protocolRoundingDustPayableMicroUsdc,
    lpEconomicNavAfterFinalizationMicroUsdc:
      input.endPeriodEconomicNavMicroUsdc -
      allocation.allocatedAmount -
      protocolRoundingDustPayableMicroUsdc,
    payoutRemainderNumerator: allocation.totalRemainder,
    payoutRemainderDenominator: input.totalShareUnits,
    allocations: allocation.allocations.map((ownerAllocation) => {
      const claim = claims.find((candidate) => candidate.ownerId === ownerAllocation.ownerId);
      if (!claim) throw new Error("invalid_lp_vault_redemption_allocation");
      return {
        ownerId: ownerAllocation.ownerId,
        availableShareUnitsBeforeBurn: claim.availableShareUnits,
        burnedShareUnits: ownerAllocation.weight,
        payableMicroUsdc: ownerAllocation.amount,
        exactRemainderNumerator: ownerAllocation.remainder
      };
    })
  };
}
