import { randomUUID } from "node:crypto";
import { z } from "zod";
import { calculateParlay } from "../packages/domain/src/parlayMath";
import { assessTicketRisk, type RiskCheck, type RiskDecision } from "../packages/domain/src/riskEngine";
import type { MarketOutcome, ParlayLeg } from "../packages/domain/src/types";
import type { MarketCatalogSnapshot } from "./marketCatalog";

export const quoteRequestSchema = z.object({
  stakeUsd: z.number().positive().max(10_000),
  legs: z.array(z.object({ id: z.string().min(1) })).min(2).max(12)
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export type QuoteLeg = {
  id: string;
  marketId: string;
  conditionId?: string;
  tokenId?: string;
  question: string;
  outcome: string;
  price: number;
  marketUrl?: string;
  endDate?: string;
  volume?: number;
  liquidity?: number;
  bestBid?: number;
  bestAsk?: number;
  priceSource?: "clob_ask" | "gamma";
  orderbookTimestamp?: string;
  orderbookHash?: string;
  sourceAsOf?: string;
};

export type QuoteResponse = {
  id: string;
  status: "quoted" | "rejected" | "accepted" | "expired";
  createdAt: string;
  expiresAt: string;
  sourceAsOf: string;
  stakeUsd: number;
  operationFeeUsd: number;
  totalCostUsd: number;
  basketPrice: number;
  basketProbability: number;
  quoteSpread: number;
  payoutMultiple: number;
  potentialPayoutUsd: number;
  riskDecision: RiskDecision;
  riskChecks: RiskCheck[];
  legs: QuoteLeg[];
};

const quoteStore = new Map<string, QuoteResponse>();

function eventKey(marketUrl?: string) {
  if (!marketUrl) return undefined;

  try {
    const url = new URL(marketUrl);
    const [, kind, slug] = url.pathname.split("/");
    return kind === "event" && slug ? slug : undefined;
  } catch {
    return undefined;
  }
}

function duplicateEventChecks(legs: MarketOutcome[]): RiskCheck[] {
  const seen = new Map<string, MarketOutcome>();
  const seenMarketIds = new Set<string>();
  const checks: RiskCheck[] = [];

  for (const leg of legs) {
    if (seenMarketIds.has(leg.marketId)) {
      checks.push({
        level: "block",
        label: "Market selection",
        detail: "Launch quotes allow one outcome per market."
      });
      break;
    }
    seenMarketIds.add(leg.marketId);

    const key = eventKey(leg.marketUrl);
    if (!key) continue;

    const existing = seen.get(key);
    if (existing && existing.marketId !== leg.marketId) {
      checks.push({
        level: "block",
        label: "Event group",
        detail: "Launch quotes allow one pick per event group until same-event pricing is supported server-side."
      });
      break;
    }

    seen.set(key, leg);
  }

  return checks;
}

function toParlayLeg(outcome: MarketOutcome): ParlayLeg {
  return {
    ...outcome,
    addedAt: Date.now()
  };
}

function publicLeg(outcome: MarketOutcome): QuoteLeg {
  return {
    id: outcome.id,
    marketId: outcome.marketId,
    conditionId: outcome.conditionId,
    tokenId: outcome.tokenId,
    question: outcome.question,
    outcome: outcome.outcome,
    price: outcome.price,
    marketUrl: outcome.marketUrl,
    endDate: outcome.endDate,
    volume: outcome.volume,
    liquidity: outcome.liquidity,
    bestBid: outcome.bestBid,
    bestAsk: outcome.bestAsk,
    priceSource: outcome.priceSource,
    orderbookTimestamp: outcome.orderbookTimestamp,
    orderbookHash: outcome.orderbookHash,
    sourceAsOf: outcome.sourceAsOf
  };
}

function sortChecks(checks: RiskCheck[]) {
  const priority = { block: 0, warn: 1, ok: 2 };
  return [...checks].sort((a, b) => priority[a.level] - priority[b.level]);
}

export function applyAdditionalRiskChecks(quote: QuoteResponse, additionalChecks: RiskCheck[]): QuoteResponse {
  if (additionalChecks.length === 0) return quote;

  const riskChecks = sortChecks([...additionalChecks, ...quote.riskChecks]);
  const hasBlock = riskChecks.some((check) => check.level === "block");
  const hasWarn = riskChecks.some((check) => check.level === "warn");
  const riskDecision: RiskDecision = hasBlock ? "reject" : hasWarn ? "review" : "accept";

  return {
    ...quote,
    status: hasBlock ? "rejected" : quote.status,
    potentialPayoutUsd: hasBlock ? 0 : quote.potentialPayoutUsd,
    riskDecision,
    riskChecks
  };
}

export function createQuote(request: QuoteRequest, catalog: MarketCatalogSnapshot, ttlMs = 15_000): QuoteResponse {
  const outcomesById = new Map(catalog.outcomes.map((outcome) => [outcome.id, outcome]));
  const selectedOutcomes = request.legs.map((leg) => outcomesById.get(leg.id));
  const missingIds = request.legs.filter((leg, index) => !selectedOutcomes[index]).map((leg) => leg.id);

  if (missingIds.length > 0) {
    throw new Error(`Unknown market outcome id: ${missingIds.join(", ")}`);
  }

  const selected = selectedOutcomes as MarketOutcome[];
  const parlayLegs = selected.map(toParlayLeg);
  const risk = assessTicketRisk(parlayLegs, request.stakeUsd);
  const parlay = calculateParlay(parlayLegs, request.stakeUsd, risk.feeModel);
  const eventChecks = duplicateEventChecks(selected);
  const riskChecks = sortChecks([...eventChecks, ...risk.checks]);
  const hasBlock = riskChecks.some((check) => check.level === "block");
  const riskDecision: RiskDecision = hasBlock ? "reject" : risk.decision;
  const sourceTimes = selected
    .map((outcome) => (outcome.sourceAsOf ? new Date(outcome.sourceAsOf).getTime() : undefined))
    .filter((value): value is number => Number.isFinite(value));
  const sourceAsOf = sourceTimes.length > 0 ? new Date(Math.min(...sourceTimes)).toISOString() : catalog.asOf;
  const now = Date.now();

  const quote: QuoteResponse = {
    id: randomUUID(),
    status: riskDecision === "reject" ? "rejected" : "quoted",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    sourceAsOf,
    stakeUsd: request.stakeUsd,
    operationFeeUsd: parlay.operationFee,
    totalCostUsd: parlay.totalCost,
    basketPrice: parlay.impliedProbability,
    basketProbability: parlay.impliedProbability,
    quoteSpread: parlay.houseEdge,
    payoutMultiple: parlay.offeredDecimalOdds,
    potentialPayoutUsd: riskDecision === "reject" ? 0 : parlay.grossPayout,
    riskDecision,
    riskChecks,
    legs: selected.map(publicLeg)
  };

  quoteStore.set(quote.id, quote);
  return quote;
}

export function getStoredQuote(id: string) {
  const quote = quoteStore.get(id);
  if (!quote) return undefined;

  if (new Date(quote.expiresAt).getTime() <= Date.now()) {
    quoteStore.delete(id);
    return undefined;
  }

  return quote;
}

export function clearQuoteStore() {
  quoteStore.clear();
}
