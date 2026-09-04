export const SETTLEMENT_PAYOUT_CALCULATION_VERSION = "partial-void-v1" as const;

const BASIS_POINTS_SCALE = 10_000n;

export type SettlementPayoutLegStatus = "won" | "voided" | "lost" | "pending" | "disputed";

export type SettlementPayoutLeg = {
  id: string;
  frozenPriceBps: bigint;
  status: SettlementPayoutLegStatus;
};

export type SettlementPayoutInput = {
  stakeMicroUsdc: bigint;
  originalOfferedPayoutMicroUsdc: bigint;
  legs: readonly SettlementPayoutLeg[];
};

export type SettlementPayoutEvidence = {
  version: typeof SETTLEMENT_PAYOUT_CALCULATION_VERSION;
  isFinal: boolean;
  finalStatus: "pending" | "lost" | "voided" | "won";
  stakeMicroUsdc: string;
  originalOfferedPayoutMicroUsdc: string;
  finalPayoutMicroUsdc: string | null;
  wonLegIds: string[];
  voidedLegIds: string[];
  lostLegIds: string[];
  pendingLegIds: string[];
  disputedLegIds: string[];
  frozenPricesBps: Array<{ legId: string; priceBps: string }>;
  roundingPolicy: "floor-after-combined-void-factor-then-stake-floor";
  operationFeePolicy: "excluded-from-payout-and-retained";
};

const validStatuses = new Set<SettlementPayoutLegStatus>(["won", "voided", "lost", "pending", "disputed"]);

function assertBigint(value: unknown, errorCode: string): asserts value is bigint {
  if (typeof value !== "bigint") throw new Error(errorCode);
}

function validateInput(input: SettlementPayoutInput) {
  assertBigint(input.stakeMicroUsdc, "invalid_settlement_stake");
  assertBigint(input.originalOfferedPayoutMicroUsdc, "invalid_settlement_original_payout");
  if (input.stakeMicroUsdc <= 0n) throw new Error("invalid_settlement_stake");
  if (input.originalOfferedPayoutMicroUsdc < 0n) throw new Error("invalid_settlement_original_payout");
  if (!Array.isArray(input.legs) || input.legs.length === 0) throw new Error("invalid_settlement_legs_empty");

  const legIds = new Set<string>();
  for (const leg of input.legs) {
    if (!leg || typeof leg !== "object") throw new Error("invalid_settlement_leg");
    if (typeof leg.id !== "string" || leg.id.trim().length === 0) throw new Error("invalid_settlement_leg_id");
    if (legIds.has(leg.id)) throw new Error("duplicate_settlement_leg_id");
    legIds.add(leg.id);
    if (!validStatuses.has(leg.status)) throw new Error("invalid_settlement_leg_status");
    assertBigint(leg.frozenPriceBps, "invalid_settlement_leg_price");
    if (leg.frozenPriceBps < 0n || leg.frozenPriceBps > BASIS_POINTS_SCALE) {
      throw new Error("invalid_settlement_leg_price");
    }
  }
}

export function calculateSettlementPayout(input: SettlementPayoutInput): SettlementPayoutEvidence {
  validateInput(input);

  const wonLegIds: string[] = [];
  const voidedLegIds: string[] = [];
  const lostLegIds: string[] = [];
  const pendingLegIds: string[] = [];
  const disputedLegIds: string[] = [];
  const frozenPricesBps = input.legs.map((leg) => ({
    legId: leg.id,
    priceBps: leg.frozenPriceBps.toString()
  }));

  for (const leg of input.legs) {
    if (leg.status === "won") wonLegIds.push(leg.id);
    else if (leg.status === "voided") voidedLegIds.push(leg.id);
    else if (leg.status === "lost") lostLegIds.push(leg.id);
    else if (leg.status === "pending") pendingLegIds.push(leg.id);
    else disputedLegIds.push(leg.id);
  }

  const evidence = {
    version: SETTLEMENT_PAYOUT_CALCULATION_VERSION,
    stakeMicroUsdc: input.stakeMicroUsdc.toString(),
    originalOfferedPayoutMicroUsdc: input.originalOfferedPayoutMicroUsdc.toString(),
    wonLegIds,
    voidedLegIds,
    lostLegIds,
    pendingLegIds,
    disputedLegIds,
    frozenPricesBps,
    roundingPolicy: "floor-after-combined-void-factor-then-stake-floor" as const,
    operationFeePolicy: "excluded-from-payout-and-retained" as const
  };

  if (lostLegIds.length > 0) {
    return { ...evidence, isFinal: true, finalStatus: "lost", finalPayoutMicroUsdc: "0" };
  }

  if (pendingLegIds.length > 0 || disputedLegIds.length > 0) {
    return { ...evidence, isFinal: false, finalStatus: "pending", finalPayoutMicroUsdc: null };
  }

  if (voidedLegIds.length === input.legs.length) {
    return {
      ...evidence,
      isFinal: true,
      finalStatus: "voided",
      finalPayoutMicroUsdc: input.stakeMicroUsdc.toString()
    };
  }

  let adjustedPayoutNumerator = input.originalOfferedPayoutMicroUsdc;
  let adjustedPayoutDenominator = 1n;
  for (const leg of input.legs) {
    if (leg.status !== "voided") continue;
    adjustedPayoutNumerator *= leg.frozenPriceBps;
    adjustedPayoutDenominator *= BASIS_POINTS_SCALE;
  }

  const adjustedPayout = adjustedPayoutNumerator / adjustedPayoutDenominator;
  const finalPayout = adjustedPayout < input.stakeMicroUsdc ? input.stakeMicroUsdc : adjustedPayout;

  return {
    ...evidence,
    isFinal: true,
    finalStatus: "won",
    finalPayoutMicroUsdc: finalPayout.toString()
  };
}
