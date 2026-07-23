export type MarketOutcome = {
  id: string;
  marketId: string;
  conditionId?: string;
  tokenId?: string;
  question: string;
  marketUrl?: string;
  image?: string;
  icon?: string;
  category: string;
  outcome: string;
  price: number;
  sourceAsOf?: string;
  endDate?: string;
  liquidity?: number;
  volume?: number;
  bestBid?: number;
  bestAsk?: number;
  executablePrice?: number;
  vwapPrice?: number;
  requestedNotionalUsd?: number;
  availableAskNotionalUsd?: number;
  priceSource?: "clob_ask" | "clob_vwap" | "gamma";
  orderbookTimestamp?: string;
  orderbookHash?: string;
  spread?: number;
  enableOrderBook?: boolean;
  negRisk?: boolean;
  rfqEnabled?: boolean;
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
  source: "polymarket" | "demo";
};

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
  version: string;
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
  version: string;
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
  thresholds: {
    minLiquidityUsd: number;
    minVolumeUsd: number;
    maxSpread: number;
    maxPublicAgeMs: number;
    requireOrderBook: boolean;
    requireExplicitLifecycle?: boolean;
    allowUnknownLiquiditySignals: boolean;
  };
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

export type ParlayLeg = MarketOutcome & {
  addedAt: number;
};

export type FeeModel = {
  houseEdgeBps: number;
  operationFeePerLegUsd: number;
};
