import type { FeeModel, ParlayLeg } from "./types";

export const DEFAULT_FEE_MODEL: FeeModel = {
  houseEdgeBps: 1_000,
  operationFeePerLegUsd: 1
};

export function clampProbability(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.99, Math.max(0.01, value));
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2
  }).format(value);
}

export function formatPercent(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: value < 0.1 ? 2 : 1,
    maximumFractionDigits: value < 0.1 ? 2 : 1
  }).format(value);
}

export function formatCents(value: number) {
  if (!Number.isFinite(value)) return "0¢";
  const cents = value * 100;
  if (cents < 1) return `${cents.toFixed(2)}¢`;
  if (cents < 10) return `${cents.toFixed(1)}¢`;
  return `${Math.round(cents)}¢`;
}

export function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

export function calculateParlay(legs: ParlayLeg[], stake: number, feeModel = DEFAULT_FEE_MODEL) {
  const probabilities = legs.map((leg) => clampProbability(leg.price));
  const hasTicket = legs.length > 0;
  const impliedProbability = probabilities.reduce((acc, probability) => acc * probability, legs.length ? 1 : 0);
  const fairDecimalOdds = impliedProbability > 0 ? 1 / impliedProbability : 0;
  const houseEdge = feeModel.houseEdgeBps / 10_000;
  const offeredDecimalOdds = fairDecimalOdds > 0 ? fairDecimalOdds * (1 - houseEdge) : 0;
  const grossPayout = stake * offeredDecimalOdds;
  const operationFee = hasTicket ? feeModel.operationFeePerLegUsd * legs.length : 0;
  const netProfit = Math.max(0, grossPayout - (hasTicket ? stake : 0) - operationFee);
  const totalCost = hasTicket ? stake + operationFee : 0;
  const oracleReferenceCost = probabilities.reduce((acc, probability) => acc + probability, 0);

  return {
    impliedProbability,
    fairDecimalOdds,
    offeredDecimalOdds,
    grossPayout,
    netProfit,
    totalCost,
    operationFee,
    oracleReferenceCost,
    houseEdge
  };
}
