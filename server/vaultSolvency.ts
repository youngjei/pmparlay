export type VaultSolvencyInput = {
  eligibleAssetsMicroUnits: bigint;
  seniorUserObligationsMicroUnits: bigint;
  grossUnresolvedPayoutsMicroUnits: bigint;
  pendingBasketStakeMicroUnits?: bigint;
  pendingBasketMaxPayoutMicroUnits?: bigint;
  pendingBasketCapacityChargeMicroUnits?: bigint;
  protocolFeePayableMicroUnits?: bigint;
  approvedExpensePayableMicroUnits?: bigint;
  lpRedemptionPayableMicroUnits?: bigint;
  fixedOperatingBufferMicroUnits?: bigint;
};

export type VaultSolvency = {
  hardSolvencyFloorMicroUnits: bigint;
  liveTicketCoverageBufferMicroUnits: bigint;
  pendingBasketCapacityChargeMicroUnits: bigint;
  operatingWithdrawalFloorMicroUnits: bigint;
  capitalAboveSolvencyFloorMicroUnits: bigint;
  capitalAboveWithdrawalFloorMicroUnits: bigint;
  status: "healthy" | "operating_buffer_breached" | "collateral_shortfall";
};

function nonnegative(value: bigint | undefined, label: string) {
  const normalized = value ?? 0n;
  if (normalized < 0n) throw new Error(`negative_vault_solvency_input:${label}`);
  return normalized;
}

export function ceilRatio(value: bigint, numerator: bigint, denominator: bigint) {
  if (value < 0n || numerator < 0n || denominator <= 0n) throw new Error("invalid_vault_solvency_ratio");
  return (value * numerator + denominator - 1n) / denominator;
}

export function evaluateVaultSolvency(input: VaultSolvencyInput): VaultSolvency {
  const assets = nonnegative(input.eligibleAssetsMicroUnits, "eligible_assets");
  const seniorUserObligations = nonnegative(input.seniorUserObligationsMicroUnits, "senior_user_obligations");
  const grossUnresolvedPayouts = nonnegative(input.grossUnresolvedPayoutsMicroUnits, "gross_unresolved_payouts");
  const pendingBasketStake = nonnegative(input.pendingBasketStakeMicroUnits, "pending_basket_stake");
  const pendingBasketMaxPayout = nonnegative(input.pendingBasketMaxPayoutMicroUnits, "pending_basket_max_payout");
  const protocolFeePayable = nonnegative(input.protocolFeePayableMicroUnits, "protocol_fee_payable");
  const approvedExpensePayable = nonnegative(input.approvedExpensePayableMicroUnits, "approved_expense_payable");
  const lpRedemptionPayable = nonnegative(input.lpRedemptionPayableMicroUnits, "lp_redemption_payable");
  const fixedOperatingBuffer = nonnegative(input.fixedOperatingBufferMicroUnits, "fixed_operating_buffer");

  const hardSolvencyFloorMicroUnits = seniorUserObligations + grossUnresolvedPayouts;
  const operatingPayablesMicroUnits =
    protocolFeePayable + approvedExpensePayable + lpRedemptionPayable;
  const liveTicketCoverageBufferMicroUnits = ceilRatio(grossUnresolvedPayouts, 25n, 100n);
  const exactPendingBasketCapacityCharge = input.pendingBasketCapacityChargeMicroUnits === undefined
    ? undefined
    : nonnegative(input.pendingBasketCapacityChargeMicroUnits, "pending_basket_capacity_charge");
  const pendingBasketOperatingRequirement = ceilRatio(pendingBasketMaxPayout, 125n, 100n);
  const aggregatePendingBasketCapacityCharge = pendingBasketOperatingRequirement > pendingBasketStake
    ? pendingBasketOperatingRequirement - pendingBasketStake
    : 0n;
  const pendingBasketCapacityChargeMicroUnits =
    exactPendingBasketCapacityCharge ?? aggregatePendingBasketCapacityCharge;
  const operatingWithdrawalFloorMicroUnits =
    hardSolvencyFloorMicroUnits +
    liveTicketCoverageBufferMicroUnits +
    pendingBasketCapacityChargeMicroUnits +
    operatingPayablesMicroUnits +
    fixedOperatingBuffer;
  const capitalAboveSolvencyFloorMicroUnits = assets - hardSolvencyFloorMicroUnits;
  const capitalAboveWithdrawalFloorMicroUnits = assets > operatingWithdrawalFloorMicroUnits
    ? assets - operatingWithdrawalFloorMicroUnits
    : 0n;

  return {
    hardSolvencyFloorMicroUnits,
    liveTicketCoverageBufferMicroUnits,
    pendingBasketCapacityChargeMicroUnits,
    operatingWithdrawalFloorMicroUnits,
    capitalAboveSolvencyFloorMicroUnits,
    capitalAboveWithdrawalFloorMicroUnits,
    status: assets < hardSolvencyFloorMicroUnits
      ? "collateral_shortfall"
      : assets < operatingWithdrawalFloorMicroUnits
        ? "operating_buffer_breached"
        : "healthy"
  };
}
