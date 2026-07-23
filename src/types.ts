export type {
  CanonicalMarketCategory,
  FeeModel,
  MarketEligibilityMetadata,
  MarketOutcome,
  MarketRelationship,
  MarketRelationshipMetadata,
  MarketTaxonomyMetadata,
  ParlayLeg
} from "../packages/domain/src/types";
import type { MarketOutcome } from "../packages/domain/src/types";

export type MarketCatalogSort = "volume" | "liquidity" | "ending_soon" | "newest";

export type MarketCatalogQuery = {
  cursor?: string;
  limit?: number;
  search?: string;
  category?: string;
  sort?: MarketCatalogSort;
  eventGroupKey?: string;
};

export type MarketCatalogSweep = {
  resource: "events";
  startedAfterCursor?: string;
  attemptedPages: number;
  successfulPages: number;
  maxPages: number;
  nextCursor?: string;
  complete: boolean;
  truncated: boolean;
  stoppedReason: "end" | "request_failed" | "duplicate_page" | "duplicate_cursor" | "page_cap";
};

export type MarketCatalogGroup = {
  eventGroupKey: string;
  eventTitle?: string;
  eventSlug?: string;
  category?: string;
  marketCount: number;
  outcomeCount: number;
};

export type MarketCatalogPageInfo = {
  limit: number;
  offset: number;
  nextCursor?: string;
  hasMore: boolean;
  total?: number;
};

export type ClaimableTicketPageInfo = {
  hasMore: boolean;
  nextCursor?: string;
};

export type ClaimableTicketPage<TTicket> = {
  tickets: TTicket[];
  pageInfo: ClaimableTicketPageInfo;
};

export type MarketCatalog = {
  asOf: string;
  source: "polymarket";
  outcomes: MarketOutcome[];
  totalFeeds?: number;
  successfulFeeds?: number;
  complete?: boolean;
  nextCursor?: string;
  sweep?: MarketCatalogSweep;
  groups?: MarketCatalogGroup[];
  pageInfo?: MarketCatalogPageInfo;
};

export type FetchState = "idle" | "loading" | "live" | "fallback" | "error";
