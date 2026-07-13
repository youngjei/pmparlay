export type { FeeModel, MarketOutcome, ParlayLeg } from "../packages/domain/src/types";
import type { MarketOutcome } from "../packages/domain/src/types";

export type MarketCatalog = {
  asOf: string;
  source: "polymarket";
  outcomes: MarketOutcome[];
  totalFeeds?: number;
  successfulFeeds?: number;
  complete?: boolean;
};

export type FetchState = "idle" | "loading" | "live" | "fallback" | "error";
