import type { MarketOutcome } from "../packages/domain/src/types";

export const MARKET_TAXONOMY_VERSION = "market-taxonomy-v1";
export const MARKET_RELATIONSHIP_VERSION = "market-relationships-v1";

export type CanonicalMarketCategory =
  | "Politics"
  | "Sports"
  | "Crypto"
  | "Finance and Economy"
  | "Technology and Science"
  | "Culture and Entertainment"
  | "World and Weather"
  | "Other";

export type MarketTaxonomyMetadata = {
  version: typeof MARKET_TAXONOMY_VERSION;
  category: CanonicalMarketCategory;
  sourceCategory?: string;
  sourceTags: string[];
  matchedSignals: string[];
};

export type MarketRelationship = {
  strength: "hard" | "soft";
  type: "same_event" | "negative_risk" | "asset" | "topic" | "time";
  key: string;
  label: string;
  confidence: number;
  reason: string;
  evidence: string[];
  overrideKey: string;
};

export type MarketRelationshipMetadata = {
  version: typeof MARKET_RELATIONSHIP_VERSION;
  generatedBy: "deterministic_rules_v1";
  overridePolicy: "replace_or_suppress_by_overrideKey";
  hard: MarketRelationship[];
  soft: MarketRelationship[];
  overrides: Array<{
    overrideKey: string;
    action: "replace" | "suppress";
    reason: string;
  }>;
};

export type MarketEligibilityConfig = {
  minLiquidityUsd: number;
  minVolumeUsd: number;
  maxSpread: number;
  maxPublicAgeMs: number;
  requireOrderBook: boolean;
  requireExplicitLifecycle?: boolean;
  allowUnknownLiquiditySignals: boolean;
};

export type MarketEligibilityMetadata = {
  eligible: boolean;
  status:
    | "eligible"
    | "ended"
    | "source_inactive"
    | "closed"
    | "archived"
    | "not_accepting_orders"
    | "missing_identity"
    | "no_orderbook"
    | "spread_too_wide"
    | "low_liquidity"
    | "unknown_liquidity";
  reason: string;
  evaluatedAt: string;
  thresholds: MarketEligibilityConfig;
  signals: {
    endDate?: string;
    sourceActive?: boolean;
    closed?: boolean;
    archived?: boolean;
    acceptingOrders?: boolean;
    enableOrderBook?: boolean;
    hasExecutableOrderBook: boolean;
    liquidityUsd?: number;
    volumeUsd?: number;
    spread?: number;
  };
};

export type MarketCatalogOutcome = MarketOutcome & {
  sourceCategory?: string;
  sourceTags?: string[];
  taxonomy?: MarketTaxonomyMetadata;
  eventGroupKey?: string;
  eventTitle?: string;
  eventSlug?: string;
  relationships?: MarketRelationshipMetadata;
  eligibility?: MarketEligibilityMetadata;
  sourceActive?: boolean;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
};

type Signal = {
  kind: string;
  value: string;
  normalizedValue: string;
  weight: number;
};

type CompiledTerm = {
  term: string;
  pattern: RegExp;
};

const DEFAULT_ELIGIBILITY_CONFIG: MarketEligibilityConfig = {
  minLiquidityUsd: 1_000,
  minVolumeUsd: 5_000,
  maxSpread: 0.2,
  maxPublicAgeMs: 2 * 60_000,
  requireOrderBook: true,
  requireExplicitLifecycle: true,
  allowUnknownLiquiditySignals: false
};

const CATEGORY_RULES: Array<{
  category: CanonicalMarketCategory;
  terms: string[];
}> = [
  {
    category: "Crypto",
    terms: ["crypto", "cryptocurrency", "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "xrp", "doge", "hype", "token", "coin"]
  },
  {
    category: "Sports",
    terms: [
      "sports",
      "sport",
      "fifa",
      "world cup",
      "nba",
      "wnba",
      "nfl",
      "mlb",
      "nhl",
      "ufc",
      "mma",
      "soccer",
      "football",
      "baseball",
      "basketball",
      "tennis",
      "golf",
      "formula 1",
      "f1"
    ]
  },
  {
    category: "Politics",
    terms: [
      "politics",
      "political",
      "election",
      "president",
      "nominee",
      "senate",
      "congress",
      "governor",
      "mayor",
      "trump",
      "biden",
      "democrat",
      "republican",
      "parliament"
    ]
  },
  {
    category: "Finance and Economy",
    terms: ["company", "companies", "stock", "stocks", "earnings", "revenue", "tesla", "nvidia", "apple", "microsoft", "meta", "amazon", "google"]
  },
  {
    category: "Finance and Economy",
    terms: ["finance", "economics", "economy", "fed", "federal reserve", "inflation", "cpi", "gdp", "recession", "interest rate", "rates", "unemployment"]
  },
  {
    category: "Culture and Entertainment",
    terms: ["culture", "movie", "film", "box office", "oscar", "grammy", "music", "celebrity", "tv", "streaming", "album", "song"]
  },
  {
    category: "Technology and Science",
    terms: ["science", "technology", "tech", "ai", "openai", "spacex", "nasa", "rocket", "space", "satellite", "model"]
  },
  {
    category: "World and Weather",
    terms: ["world", "geopolitics", "war", "ceasefire", "country", "weather", "hurricane", "storm", "rain", "snow", "temperature", "heat", "wildfire"]
  }
];

const ASSET_RULES = [
  { key: "bitcoin", label: "Bitcoin", terms: ["bitcoin", "btc"] },
  { key: "ethereum", label: "Ethereum", terms: ["ethereum", "eth"] },
  { key: "solana", label: "Solana", terms: ["solana", "sol"] },
  { key: "xrp", label: "XRP", terms: ["xrp", "ripple"] },
  { key: "dogecoin", label: "Dogecoin", terms: ["dogecoin", "doge"] },
  { key: "hype", label: "HYPE", terms: ["hype", "hyperliquid"] },
  { key: "tesla", label: "Tesla", terms: ["tesla", "tsla"] },
  { key: "nvidia", label: "NVIDIA", terms: ["nvidia", "nvda"] },
  { key: "apple", label: "Apple", terms: ["apple", "aapl"] },
  { key: "microsoft", label: "Microsoft", terms: ["microsoft", "msft"] }
];

function parseNumberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value === "true";
}

export function marketEligibilityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MarketEligibilityConfig {
  return {
    minLiquidityUsd: parseNumberEnv(env.MARKET_CATALOG_MIN_LIQUIDITY_USD, DEFAULT_ELIGIBILITY_CONFIG.minLiquidityUsd),
    minVolumeUsd: parseNumberEnv(env.MARKET_CATALOG_MIN_VOLUME_USD, DEFAULT_ELIGIBILITY_CONFIG.minVolumeUsd),
    maxSpread: parseNumberEnv(env.MARKET_CATALOG_MAX_SPREAD, DEFAULT_ELIGIBILITY_CONFIG.maxSpread),
    maxPublicAgeMs: parseNumberEnv(env.MARKET_CATALOG_PUBLIC_MAX_AGE_MS, DEFAULT_ELIGIBILITY_CONFIG.maxPublicAgeMs),
    requireOrderBook: parseBooleanEnv(env.MARKET_CATALOG_REQUIRE_ORDERBOOK, DEFAULT_ELIGIBILITY_CONFIG.requireOrderBook),
    requireExplicitLifecycle: true,
    allowUnknownLiquiditySignals: parseBooleanEnv(
      env.MARKET_CATALOG_ALLOW_UNKNOWN_LIQUIDITY,
      DEFAULT_ELIGIBILITY_CONFIG.allowUnknownLiquiditySignals
    )
  };
}

export function publicCatalogLimitFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number(env.MARKET_CATALOG_PUBLIC_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 250) : 100;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizedText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTerm(term: string): CompiledTerm {
  const normalizedTerm = normalizedText(term);
  const termPattern = normalizedTerm
    .split(/\s+/)
    .map(escapeRegex)
    .join("\\s+");
  return {
    term,
    pattern: new RegExp(`(?:^|\\s)${termPattern}(?=\\s|$)`)
  };
}

function compileTerms(terms: string[]) {
  return terms.map(compileTerm);
}

function normalizedTextHasTerm(text: string, term: CompiledTerm) {
  return Boolean(text) && term.pattern.test(text);
}

const COMPILED_CATEGORY_RULES = CATEGORY_RULES.map((rule) => ({
  ...rule,
  terms: compileTerms(rule.terms)
}));

const COMPILED_ASSET_RULES = ASSET_RULES.map((asset) => ({
  ...asset,
  terms: compileTerms(asset.terms)
}));

function titleFromSlug(slug: string) {
  const acronyms = new Set(["ai", "cpi", "eu", "fbi", "fifa", "gdp", "mlb", "nba", "nfl", "nhl", "uk", "ufc", "us"]);
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => (acronyms.has(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

export function eventSlugFromMarketUrl(marketUrl?: string) {
  if (!marketUrl) return undefined;
  try {
    const parsed = new URL(marketUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const eventIndex = parts.indexOf("event");
    if (eventIndex >= 0 && parts[eventIndex + 1]) return parts[eventIndex + 1];
  } catch {
    const match = marketUrl.match(/\/event\/([^/?#]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function normalizeSourceTags(values: Array<string | undefined | null>, sourceCategory?: string) {
  const tags = [...values, sourceCategory]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  const byKey = new Map<string, string>();
  for (const tag of tags) {
    const key = normalizedText(tag);
    if (key && !byKey.has(key)) byKey.set(key, tag);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, tag]) => tag);
}

export function normalizeMarketTaxonomy(input: {
  question: string;
  sourceCategory?: string;
  sourceTags?: string[];
  marketUrl?: string;
  eventSlug?: string;
}): MarketTaxonomyMetadata {
  const sourceTags = normalizeSourceTags(input.sourceTags || [], input.sourceCategory);
  const signals: Signal[] = [
    ...(input.sourceCategory ? [{ kind: "source_category", value: input.sourceCategory, weight: 3 }] : []),
    ...sourceTags.map((tag) => ({ kind: "source_tag", value: tag, weight: 3 })),
    { kind: "question", value: input.question, weight: 1 },
    ...(input.eventSlug ? [{ kind: "event_slug", value: input.eventSlug, weight: 1 }] : []),
    ...(input.marketUrl ? [{ kind: "market_url", value: input.marketUrl, weight: 1 }] : [])
  ].map((signal) => ({ ...signal, normalizedValue: normalizedText(signal.value) }));

  let bestCategory: CanonicalMarketCategory = "Other";
  let bestScore = 0;
  let bestMatchedSignals: string[] = [];

  for (const rule of COMPILED_CATEGORY_RULES) {
    let score = 0;
    const matchedSignals: string[] = [];
    for (const signal of signals) {
      const matchedTerm = rule.terms.find((term) => normalizedTextHasTerm(signal.normalizedValue, term));
      if (matchedTerm) {
        score += signal.weight;
        matchedSignals.push(`${signal.kind}:${matchedTerm.term}`);
      }
    }

    if (score > bestScore) {
      bestCategory = rule.category;
      bestScore = score;
      bestMatchedSignals = matchedSignals;
    }
  }

  return {
    version: MARKET_TAXONOMY_VERSION,
    category: bestCategory,
    sourceCategory: input.sourceCategory,
    sourceTags,
    matchedSignals: bestMatchedSignals
  };
}

export function buildEventGrouping(input: {
  marketId: string;
  question: string;
  marketUrl?: string;
  eventSlug?: string;
  eventTitle?: string;
}) {
  const slug = input.eventSlug || eventSlugFromMarketUrl(input.marketUrl);
  if (slug) {
    return {
      eventGroupKey: `polymarket:event:${slug}`,
      eventSlug: slug,
      eventTitle: input.eventTitle?.trim() || titleFromSlug(slug)
    };
  }

  return {
    eventGroupKey: `polymarket:market:${input.marketId}`,
    eventTitle: input.eventTitle?.trim() || input.question
  };
}

export function isMarketCurrentlyLive(endDate?: string | Date, now: Date = new Date()) {
  if (!endDate) return true;
  const parsed = endDate instanceof Date ? endDate : new Date(endDate);
  if (!Number.isFinite(parsed.getTime())) return true;
  return parsed.getTime() > now.getTime();
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function hasExecutableOrderBook(outcome: MarketCatalogOutcome, now: Date, config: MarketEligibilityConfig) {
  const bestAsk = finiteNumber(outcome.bestAsk);
  const executablePrice = finiteNumber(outcome.executablePrice);
  const requestedNotionalUsd = finiteNumber(outcome.requestedNotionalUsd);
  const availableAskNotionalUsd = finiteNumber(outcome.availableAskNotionalUsd);
  const orderbookTimestamp = outcome.orderbookTimestamp ? new Date(outcome.orderbookTimestamp) : undefined;
  const orderbookAgeMs = orderbookTimestamp && Number.isFinite(orderbookTimestamp.getTime()) ? now.getTime() - orderbookTimestamp.getTime() : undefined;
  const hasAsk = bestAsk !== undefined && bestAsk > 0 && bestAsk < 1;
  const hasExecutablePrice = executablePrice !== undefined && executablePrice > 0 && executablePrice < 1;
  const hasClobPrice = outcome.priceSource === "clob_ask" || outcome.priceSource === "clob_vwap";
  const hasDepth =
    requestedNotionalUsd !== undefined &&
    requestedNotionalUsd > 0 &&
    availableAskNotionalUsd !== undefined &&
    availableAskNotionalUsd >= requestedNotionalUsd;
  const isFresh = orderbookAgeMs !== undefined && orderbookAgeMs >= -30_000 && orderbookAgeMs <= config.maxPublicAgeMs;
  return outcome.enableOrderBook === true && Boolean(outcome.tokenId) && hasExecutablePrice && hasClobPrice && hasAsk && hasDepth && isFresh;
}

export function evaluateMarketEligibility(
  outcome: MarketCatalogOutcome,
  now: Date = new Date(),
  config: MarketEligibilityConfig = marketEligibilityConfigFromEnv()
): MarketEligibilityMetadata {
  const evaluatedAt = now.toISOString();
  const liquidityUsd = finiteNumber(outcome.liquidity);
  const volumeUsd = finiteNumber(outcome.volume);
  const spread = finiteNumber(outcome.spread);
  const hasOrderBook = hasExecutableOrderBook(outcome, now, config);
  const requireExplicitLifecycle = config.requireExplicitLifecycle !== false;
  const signals = {
    endDate: outcome.endDate,
    sourceActive: outcome.sourceActive,
    closed: outcome.closed,
    archived: outcome.archived,
    acceptingOrders: outcome.acceptingOrders,
    enableOrderBook: outcome.enableOrderBook,
    hasExecutableOrderBook: hasOrderBook,
    liquidityUsd,
    volumeUsd,
    spread
  };

  const ineligible = (
    status: MarketEligibilityMetadata["status"],
    reason: string
  ): MarketEligibilityMetadata => ({
    eligible: false,
    status,
    reason,
    evaluatedAt,
    thresholds: config,
    signals
  });

  if (!isMarketCurrentlyLive(outcome.endDate, now)) {
    return ineligible("ended", "Market endDate is not in the future.");
  }

  if (outcome.sourceActive === false || (requireExplicitLifecycle && outcome.sourceActive !== true)) {
    return ineligible("source_inactive", "Polymarket source marked the market inactive.");
  }

  if (outcome.closed === true || (requireExplicitLifecycle && outcome.closed !== false)) {
    return ineligible("closed", "Polymarket source marked the market closed.");
  }

  if (outcome.archived === true || (requireExplicitLifecycle && outcome.archived !== false)) {
    return ineligible("archived", "Polymarket source marked the market archived.");
  }

  if (outcome.acceptingOrders === false || (requireExplicitLifecycle && outcome.acceptingOrders !== true)) {
    return ineligible("not_accepting_orders", "Polymarket source is not accepting orders.");
  }

  if (!outcome.conditionId?.trim() || !outcome.tokenId?.trim()) {
    return ineligible("missing_identity", "Polymarket condition or outcome token identity is missing.");
  }

  if (outcome.enableOrderBook === false || (requireExplicitLifecycle && outcome.enableOrderBook !== true)) {
    return ineligible("no_orderbook", "Polymarket source has not enabled an order book for this outcome.");
  }

  if (config.requireOrderBook && !hasOrderBook) {
    return ineligible("no_orderbook", "No executable CLOB ask was present for the outcome.");
  }

  if (spread !== undefined && spread > config.maxSpread) {
    return ineligible("spread_too_wide", "Orderbook spread is above the configured severe weakness threshold.");
  }

  const liquiditySignalsUnknown = liquidityUsd === undefined && volumeUsd === undefined;

  if (!config.allowUnknownLiquiditySignals && liquiditySignalsUnknown) {
    return ineligible("unknown_liquidity", "Liquidity and volume signals were both missing.");
  }

  const passesLiquidity = liquidityUsd !== undefined && liquidityUsd >= config.minLiquidityUsd;
  const passesVolume = volumeUsd !== undefined && volumeUsd >= config.minVolumeUsd;

  if (!passesLiquidity && !passesVolume && !(config.allowUnknownLiquiditySignals && liquiditySignalsUnknown)) {
    return ineligible("low_liquidity", "Liquidity and lifetime volume are both below the configured public eligibility thresholds.");
  }

  return {
    eligible: true,
    status: "eligible",
    reason: config.requireOrderBook
      ? "Market passed deterministic lifecycle, orderbook, and liquidity checks."
      : "Market passed deterministic lifecycle and liquidity checks.",
    evaluatedAt,
    thresholds: config,
    signals
  };
}

function evidenceForTerm(signals: Signal[], terms: CompiledTerm[]) {
  for (const term of terms) {
    const match = signals.find((signal) => normalizedTextHasTerm(signal.normalizedValue, term));
    if (match) return match;
  }
  return undefined;
}

function dedupeRelationships(relationships: MarketRelationship[]) {
  const byOverrideKey = new Map<string, MarketRelationship>();
  for (const relationship of relationships) {
    if (!byOverrideKey.has(relationship.overrideKey)) {
      byOverrideKey.set(relationship.overrideKey, relationship);
    }
  }
  return [...byOverrideKey.values()].sort((left, right) => left.overrideKey.localeCompare(right.overrideKey));
}

export function buildRelationshipMetadata(outcome: MarketCatalogOutcome): MarketRelationshipMetadata {
  const hard: MarketRelationship[] = [];
  const soft: MarketRelationship[] = [];

  if (outcome.eventGroupKey && outcome.eventSlug) {
    hard.push({
      strength: "hard",
      type: "same_event",
      key: outcome.eventGroupKey,
      label: outcome.eventTitle || outcome.eventSlug,
      confidence: 1,
      reason: "Outcomes share the same Polymarket event slug.",
      evidence: [outcome.eventSlug],
      overrideKey: `hard:same_event:${outcome.eventGroupKey}`
    });
  }

  if (outcome.negRisk) {
    const key = `polymarket:neg-risk:${outcome.eventGroupKey || outcome.conditionId || outcome.marketId}`;
    hard.push({
      strength: "hard",
      type: "negative_risk",
      key,
      label: "Polymarket negative risk set",
      confidence: 1,
      reason: "Polymarket marked this market as a negative-risk market.",
      evidence: [outcome.eventGroupKey, outcome.conditionId, outcome.marketId].filter((value): value is string => Boolean(value)),
      overrideKey: `hard:negative_risk:${key}`
    });
  }

  const sourceTags = outcome.sourceTags || outcome.taxonomy?.sourceTags || [];
  const signals = [outcome.question, outcome.category, outcome.eventTitle, outcome.eventSlug, ...(sourceTags || [])]
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ kind: "relationship_signal", value, normalizedValue: normalizedText(value), weight: 0 }));

  for (const asset of COMPILED_ASSET_RULES) {
    const evidence = evidenceForTerm(signals, asset.terms);
    if (!evidence) continue;
    soft.push({
      strength: "soft",
      type: "asset",
      key: `asset:${asset.key}`,
      label: asset.label,
      confidence: 0.8,
      reason: "A deterministic asset keyword matched the market question, event, or source tags.",
      evidence: [evidence.value],
      overrideKey: `soft:asset:${asset.key}`
    });
  }

  const topicKey = `topic:${slugify(outcome.category || "Other") || "other"}`;
  soft.push({
    strength: "soft",
    type: "topic",
    key: topicKey,
    label: outcome.category || "Other",
    confidence: outcome.taxonomy?.matchedSignals.length ? 0.7 : 0.45,
    reason: "Canonical taxonomy assigned this market topic using deterministic rules.",
    evidence: outcome.taxonomy?.matchedSignals.length ? outcome.taxonomy.matchedSignals : [outcome.sourceCategory || outcome.category],
    overrideKey: `soft:topic:${topicKey}`
  });

  for (const tag of sourceTags.slice(0, 5)) {
    const tagKey = `source-tag:${slugify(tag)}`;
    if (!tagKey.endsWith(":")) {
      soft.push({
        strength: "soft",
        type: "topic",
        key: tagKey,
        label: tag,
        confidence: 0.5,
        reason: "Polymarket source tag provides a deterministic soft topic relationship.",
        evidence: [tag],
        overrideKey: `soft:topic:${tagKey}`
      });
    }
  }

  if (outcome.endDate) {
    const parsed = new Date(outcome.endDate);
    if (Number.isFinite(parsed.getTime())) {
      const day = parsed.toISOString().slice(0, 10);
      soft.push({
        strength: "soft",
        type: "time",
        key: `end-date:${day}`,
        label: day,
        confidence: 0.4,
        reason: "Markets ending on the same UTC date may share time-driven risk.",
        evidence: [outcome.endDate],
        overrideKey: `soft:time:end-date:${day}`
      });
    }
  }

  return {
    version: MARKET_RELATIONSHIP_VERSION,
    generatedBy: "deterministic_rules_v1",
    overridePolicy: "replace_or_suppress_by_overrideKey",
    hard: dedupeRelationships(hard),
    soft: dedupeRelationships(soft),
    overrides: []
  };
}

export function annotateCatalogOutcome(
  outcome: MarketCatalogOutcome,
  options: {
    now?: Date;
    eligibilityConfig?: MarketEligibilityConfig;
  } = {}
): MarketCatalogOutcome {
  const sourceCategory = outcome.sourceCategory || outcome.taxonomy?.sourceCategory || outcome.category;
  const sourceTags = normalizeSourceTags([...(outcome.sourceTags || []), ...(outcome.taxonomy?.sourceTags || [])], sourceCategory);
  const grouping = buildEventGrouping({
    marketId: outcome.marketId,
    question: outcome.question,
    marketUrl: outcome.marketUrl,
    eventSlug: outcome.eventSlug,
    eventTitle: outcome.eventTitle
  });
  const taxonomy = normalizeMarketTaxonomy({
    question: outcome.question,
    sourceCategory,
    sourceTags,
    marketUrl: outcome.marketUrl,
    eventSlug: grouping.eventSlug
  });
  const base: MarketCatalogOutcome = {
    ...outcome,
    category: taxonomy.category,
    sourceCategory,
    sourceTags,
    taxonomy,
    eventGroupKey: grouping.eventGroupKey,
    eventTitle: grouping.eventTitle,
    eventSlug: grouping.eventSlug
  };

  return {
    ...base,
    relationships: buildRelationshipMetadata(base),
    eligibility: evaluateMarketEligibility(base, options.now, options.eligibilityConfig)
  };
}

export function annotateCatalogOutcomes(
  outcomes: MarketOutcome[],
  options: {
    now?: Date;
    eligibilityConfig?: MarketEligibilityConfig;
  } = {}
): MarketCatalogOutcome[] {
  return outcomes.map((outcome) => annotateCatalogOutcome(outcome as MarketCatalogOutcome, options));
}
