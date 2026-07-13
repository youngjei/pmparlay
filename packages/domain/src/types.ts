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
  priceSource?: "clob_ask" | "gamma";
  orderbookTimestamp?: string;
  orderbookHash?: string;
  spread?: number;
  enableOrderBook?: boolean;
  negRisk?: boolean;
  rfqEnabled?: boolean;
  source: "polymarket" | "demo";
};

export type ParlayLeg = MarketOutcome & {
  addedAt: number;
};

export type FeeModel = {
  houseEdgeBps: number;
  operationFeePerLegUsd: number;
};
