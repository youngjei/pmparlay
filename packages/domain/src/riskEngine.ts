import type { FeeModel, ParlayLeg } from "./types";

export type RiskDecision = "accept" | "review" | "reject";

export type RiskCheck = {
  level: "ok" | "warn" | "block";
  label: string;
  detail: string;
};

export type RiskAssessment = {
  decision: RiskDecision;
  feeModel: FeeModel;
  spreadBps: number;
  rawSpreadBps: number;
  maxSpreadBps: number;
  spreadWasCapped: boolean;
  correlationSurchargeBps: number;
  liquiditySurchargeBps: number;
  legSurchargeBps: number;
  maxGrossPayoutUsd: number;
  grossPayoutBeforeSpread: number;
  worstCaseNetLiabilityUsd: number;
  checks: RiskCheck[];
};

export type RiskPolicy = {
  baseSpreadBps: number;
  operationFeePerLegUsd: number;
  maxStakeUsd: number;
  maxLegs: number;
  maxGrossPayoutUsd: number;
  maxPayoutMultiple: number;
  minVolumeUsd: number;
  minLiquidityUsd: number;
  maxSameCorrelationGroupLegs: number;
  manualReviewStakeUsd: number;
  manualReviewLegs: number;
  manualReviewPayoutShare: number;
  maxSpreadBps: number;
};

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  baseSpreadBps: 700,
  operationFeePerLegUsd: 0.5,
  maxStakeUsd: 5,
  maxLegs: 8,
  maxGrossPayoutUsd: 50,
  maxPayoutMultiple: 250,
  minVolumeUsd: 50_000,
  minLiquidityUsd: 10_000,
  maxSameCorrelationGroupLegs: 4,
  manualReviewStakeUsd: 5,
  manualReviewLegs: 5,
  manualReviewPayoutShare: 0.8,
  maxSpreadBps: 1_200
};

const keywordGroups = [
  { group: "btc", pattern: /\b(bitcoin|btc)\b/i },
  { group: "eth", pattern: /\b(ethereum|eth)\b/i },
  { group: "hype", pattern: /\b(hype|hyperliquid)\b/i },
  { group: "rates", pattern: /\b(fed|fomc|rate|rates|inflation|cpi)\b/i },
  { group: "weather", pattern: /\b(rain|temperature|weather|storm|hurricane|snow)\b/i },
  { group: "world-cup", pattern: /\b(world cup|fifa)\b/i },
  { group: "election", pattern: /\b(election|president|senate|congress|trump|biden)\b/i },
  { group: "ai", pattern: /\b(ai|openai|anthropic|model|frontier)\b/i }
];

function clampProbability(value: number) {
  if (!Number.isFinite(value)) return 0.01;
  return Math.min(0.99, Math.max(0.01, value));
}

function correlationGroup(leg: ParlayLeg) {
  const haystack = `${leg.category} ${leg.question} ${leg.marketUrl || ""}`;
  const keywordGroup = keywordGroups.find((item) => item.pattern.test(haystack));
  return keywordGroup ? `${leg.category}:${keywordGroup.group}` : leg.category || "General";
}

function countBy<T>(items: T[], getKey: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function impliedProbability(legs: ParlayLeg[]) {
  return legs.reduce((acc, leg) => acc * clampProbability(leg.price), legs.length ? 1 : 0);
}

function maxGroupCount(legs: ParlayLeg[]) {
  const counts = countBy(legs, correlationGroup);
  return Math.max(0, ...counts.values());
}

function liquiditySurcharge(legs: ParlayLeg[], policy: RiskPolicy) {
  const weakLegs = legs.filter((leg) => {
    const volume = leg.volume || 0;
    const liquidity = leg.liquidity ?? volume;
    return volume < policy.minVolumeUsd && liquidity < policy.minLiquidityUsd;
  });
  return weakLegs.length * 250;
}

function correlationSurcharge(legs: ParlayLeg[], policy: RiskPolicy) {
  const largestGroup = maxGroupCount(legs);
  return Math.max(0, largestGroup - 1) * 350 + Math.max(0, largestGroup - policy.maxSameCorrelationGroupLegs) * 750;
}

function legSurcharge(legs: ParlayLeg[]) {
  return Math.max(0, legs.length - 3) * 100;
}

export function assessTicketRisk(legs: ParlayLeg[], stakeUsd: number, policy = DEFAULT_RISK_POLICY): RiskAssessment {
  const checks: RiskCheck[] = [];
  const probability = impliedProbability(legs);
  const fairDecimalOdds = probability > 0 ? 1 / probability : 0;
  const grossPayoutBeforeSpread = stakeUsd * fairDecimalOdds;
  const liquiditySurchargeBps = liquiditySurcharge(legs, policy);
  const correlationSurchargeBps = correlationSurcharge(legs, policy);
  const legSurchargeBps = legSurcharge(legs);
  const rawSpreadBps = policy.baseSpreadBps + liquiditySurchargeBps + correlationSurchargeBps + legSurchargeBps;
  const spreadBps = Math.min(policy.maxSpreadBps, rawSpreadBps);
  const offeredGrossPayout = grossPayoutBeforeSpread * (1 - spreadBps / 10_000);
  const worstCaseNetLiabilityUsd = Math.max(0, offeredGrossPayout - stakeUsd);
  const payoutLimitUsd = Math.min(policy.maxGrossPayoutUsd, stakeUsd * policy.maxPayoutMultiple);
  const largestGroup = maxGroupCount(legs);
  const weakLiquidityCount = legs.filter((leg) => {
    const volume = leg.volume || 0;
    const liquidity = leg.liquidity ?? volume;
    return volume < policy.minVolumeUsd && liquidity < policy.minLiquidityUsd;
  }).length;

  if (legs.length === 0) {
    checks.push({ level: "ok", label: "No exposure", detail: "Select markets to run risk checks." });
  }

  if (stakeUsd > policy.maxStakeUsd) {
    checks.push({
      level: "block",
      label: "Stake limit",
      detail: `Buy amount exceeds the ${policy.maxStakeUsd} USD risk cap.`
    });
  } else if (stakeUsd > policy.manualReviewStakeUsd) {
    checks.push({ level: "warn", label: "Stake size", detail: "Buy amount is close to the current risk cap." });
  }

  if (legs.length > policy.maxLegs) {
    checks.push({ level: "block", label: "Leg limit", detail: `Baskets are capped at ${policy.maxLegs} legs before manual approval.` });
  } else if (legs.length > policy.manualReviewLegs) {
    checks.push({ level: "warn", label: "Leg count", detail: "Long baskets carry higher tail and pricing risk." });
  }

  if (offeredGrossPayout > payoutLimitUsd) {
    checks.push({
      level: "block",
      label: "Payout cap",
      detail: `Potential payout exceeds the ${payoutLimitUsd} USD launch cap.`
    });
  } else if (offeredGrossPayout > payoutLimitUsd * policy.manualReviewPayoutShare) {
    checks.push({ level: "warn", label: "Payout watch", detail: "Potential payout is close to the current launch cap." });
  }

  if (legs.length >= 2 && offeredGrossPayout <= stakeUsd + policy.operationFeePerLegUsd * legs.length) {
    checks.push({
      level: "block",
      label: "No upside",
      detail: "This basket would pay less than or equal to the amount due, so LEGWORK will not quote it."
    });
  }

  if (rawSpreadBps > policy.maxSpreadBps) {
    checks.push({
      level: "warn",
      label: "Spread cap",
      detail: `Risk exceeded the ${policy.maxSpreadBps / 100}% spread cap, so LEGWORK capped the spread instead of worsening the payout.`
    });
  }

  if (largestGroup > policy.maxSameCorrelationGroupLegs + 2) {
    checks.push({
      level: "block",
      label: "Correlation cap",
      detail: "Too many legs share the same risk theme for an automatic quote."
    });
  } else if (largestGroup > 1) {
    checks.push({
      level: "warn",
      label: "Correlation surcharge",
      detail: "Multiple legs appear related, so the quote is reviewed with a capped spread."
    });
  }

  if (weakLiquidityCount > 0) {
    checks.push({
      level: "warn",
      label: "Liquidity surcharge",
      detail: `${weakLiquidityCount} leg${weakLiquidityCount === 1 ? "" : "s"} may be thin relative to launch risk limits.`
    });
  }

  if (checks.length === 0) {
    checks.push({ level: "ok", label: "Risk checks passed", detail: "This basket is inside current launch limits." });
  }

  const hasBlock = checks.some((check) => check.level === "block");
  const hasWarn = checks.some((check) => check.level === "warn");
  const decision: RiskDecision = hasBlock ? "reject" : hasWarn ? "review" : "accept";

  return {
    decision,
    feeModel: {
      houseEdgeBps: spreadBps,
      operationFeePerLegUsd: policy.operationFeePerLegUsd
    },
    spreadBps,
    rawSpreadBps,
    maxSpreadBps: policy.maxSpreadBps,
    spreadWasCapped: rawSpreadBps > policy.maxSpreadBps,
    correlationSurchargeBps,
    liquiditySurchargeBps,
    legSurchargeBps,
    maxGrossPayoutUsd: payoutLimitUsd,
    grossPayoutBeforeSpread,
    worstCaseNetLiabilityUsd,
    checks
  };
}
