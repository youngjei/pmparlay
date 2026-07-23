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
  priceSource?: "clob_ask" | "clob_vwap" | "gamma";
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

export type RequoteOrderbookEvidence = {
  requestedNotionalUsd?: number;
  availableNotionalUsd?: number;
  bestAsk?: number;
  executablePrice?: number;
  vwapAsk?: number;
  evidenceAsOf?: string;
  orderbookTimestamp?: string;
  orderbookHash?: string;
  priceSource?: QuoteLeg["priceSource"];
  stale?: boolean;
  sufficientDepth?: boolean;
  [key: string]: unknown;
};

export type PaymentActivationRequote = {
  quote: QuoteResponse;
  evidenceByLegId: Map<string, RequoteOrderbookEvidence>;
};

function numericEvidenceField(evidence: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = evidence[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringEvidenceField(evidence: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = evidence[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function boolEvidenceField(evidence: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = evidence[name];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function objectEvidenceField(outcome: MarketOutcome): Record<string, unknown> | undefined {
  const record = outcome as unknown as Record<string, unknown>;
  for (const key of ["askDepthEvidence", "orderbookEvidence", "executionEvidence", "depthEvidence"]) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }

  const topLevelEvidence: Record<string, unknown> = {};
  for (const key of [
    "requestedNotionalUsd",
    "availableNotionalUsd",
    "availableAskNotionalUsd",
    "executableNotionalUsd",
    "vwapAsk",
    "vwapPrice",
    "bestAsk",
    "executablePrice",
    "orderbookTimestamp",
    "orderbookHash",
    "evidenceAsOf",
    "sourceAsOf",
    "priceSource",
    "sufficientDepth",
    "stale"
  ]) {
    if (record[key] !== undefined) topLevelEvidence[key] = record[key];
  }
  return Object.keys(topLevelEvidence).length > 0 ? topLevelEvidence : undefined;
}

function orderbookEvidence(outcome: MarketOutcome, requestedNotionalUsdPerLeg: number): RequoteOrderbookEvidence | undefined {
  const raw = objectEvidenceField(outcome);
  if (!raw) return undefined;

  return {
    ...raw,
    requestedNotionalUsd:
      numericEvidenceField(raw, ["requestedNotionalUsd", "requestedUsd", "notionalUsd"]) ?? requestedNotionalUsdPerLeg,
    availableNotionalUsd:
      numericEvidenceField(raw, ["availableNotionalUsd", "availableAskNotionalUsd", "executableNotionalUsd", "askDepthUsd"]) ??
      outcome.availableAskNotionalUsd,
    bestAsk: numericEvidenceField(raw, ["bestAsk"]) ?? outcome.bestAsk,
    executablePrice: numericEvidenceField(raw, ["executablePrice", "vwapAsk", "vwapPrice", "askVwap", "price"]) ?? outcome.executablePrice ?? outcome.price,
    vwapAsk: numericEvidenceField(raw, ["vwapAsk", "vwapPrice", "askVwap", "price"]) ?? outcome.vwapPrice ?? outcome.executablePrice ?? outcome.price,
    evidenceAsOf: stringEvidenceField(raw, ["evidenceAsOf", "asOf", "sourceAsOf"]),
    orderbookTimestamp: stringEvidenceField(raw, ["orderbookTimestamp", "capturedAt"]),
    orderbookHash: stringEvidenceField(raw, ["orderbookHash", "bookHash"]) ?? outcome.orderbookHash,
    priceSource: (stringEvidenceField(raw, ["priceSource"]) as QuoteLeg["priceSource"] | undefined) ?? outcome.priceSource,
    stale: boolEvidenceField(raw, ["stale", "isStale"]),
    sufficientDepth: boolEvidenceField(raw, ["sufficientDepth", "hasSufficientDepth"])
  };
}

function evidenceTimestamp(evidence: RequoteOrderbookEvidence) {
  const timestamp = evidence.orderbookTimestamp || evidence.evidenceAsOf;
  if (!timestamp) return undefined;
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : undefined;
}

function validateRequoteEvidence(
  outcome: MarketOutcome,
  input: {
    requestedNotionalUsdPerLeg: number;
    requireDepthEvidence: boolean;
    maxEvidenceAgeMs: number;
    nowMs: number;
  }
) {
  const evidence = orderbookEvidence(outcome, input.requestedNotionalUsdPerLeg);
  if (!evidence) {
    if (input.requireDepthEvidence) throw new Error("stale_book");
    return undefined;
  }

  if (evidence.stale) throw new Error("stale_book");
  if (!evidence.orderbookHash || evidence.bestAsk === undefined || evidence.executablePrice === undefined) {
    throw new Error("stale_book");
  }
  const timestamp = evidenceTimestamp(evidence);
  if (!timestamp || input.nowMs - timestamp > input.maxEvidenceAgeMs || timestamp - input.nowMs > 30_000) {
    throw new Error("stale_book");
  }

  if (evidence.sufficientDepth === false) throw new Error("insufficient_depth");
  if (evidence.availableNotionalUsd !== undefined && evidence.availableNotionalUsd + 1e-9 < input.requestedNotionalUsdPerLeg) {
    throw new Error("insufficient_depth");
  }
  if (evidence.requestedNotionalUsd !== undefined && evidence.requestedNotionalUsd + 1e-9 < input.requestedNotionalUsdPerLeg) {
    throw new Error("insufficient_depth");
  }

  return evidence;
}

export function createPaymentActivationRequote(
  originalQuote: QuoteResponse,
  catalog: MarketCatalogSnapshot,
  options: {
    requestedNotionalUsdPerLeg: number;
    ttlMs?: number;
    requireDepthEvidence?: boolean;
    maxEvidenceAgeMs?: number;
    nowMs?: number;
  }
): PaymentActivationRequote {
  const nowMs = options.nowMs ?? Date.now();
  const outcomesById = new Map(catalog.outcomes.map((outcome) => [outcome.id, outcome]));
  const selected: MarketOutcome[] = [];
  const evidenceByLegId = new Map<string, RequoteOrderbookEvidence>();

  for (const leg of originalQuote.legs) {
    const outcome = outcomesById.get(leg.id);
    if (!outcome) throw new Error("market_closed");
    if (outcome.endDate && new Date(outcome.endDate).getTime() <= nowMs) throw new Error("market_closed");

    const evidence = validateRequoteEvidence(outcome, {
      requestedNotionalUsdPerLeg: options.requestedNotionalUsdPerLeg,
      requireDepthEvidence: options.requireDepthEvidence ?? true,
      maxEvidenceAgeMs: options.maxEvidenceAgeMs ?? 30_000,
      nowMs
    });
    if (evidence) evidenceByLegId.set(outcome.id, evidence);
    selected.push(outcome);
  }

  const quote = createQuote(
    {
      stakeUsd: originalQuote.stakeUsd,
      legs: selected.map((outcome) => ({ id: outcome.id }))
    },
    {
      ...catalog,
      outcomes: selected
    },
    options.ttlMs
  );

  return {
    quote,
    evidenceByLegId
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
