import type { MarketCatalog, MarketOutcome } from "./types";

const GAMMA_API_BASE_URL = "https://gamma-api.polymarket.com";
const CLOB_API_BASE_URL = "https://clob.polymarket.com";
const GAMMA_KEYSET_LIMIT = 100;
const GAMMA_MAX_PAGES_PER_RESOURCE = 40;
const CLOB_BOOK_CHUNK_SIZE = 100;
const CLOB_BOOK_CONCURRENCY = 4;
const POLYMARKET_REQUEST_TIMEOUT_MS = 10_000;
const POLYMARKET_REQUEST_RETRIES = 2;
const POLYMARKET_RETRY_BASE_DELAY_MS = 250;

export class PolymarketApiError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(status: number, detail?: string) {
    super(`Polymarket responded with ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "PolymarketApiError";
    this.status = status;
    this.detail = detail;
  }
}

export function isPolymarketInvalidCursorError(error: unknown) {
  return (
    error instanceof PolymarketApiError &&
    error.status === 422 &&
    error.detail?.trim().toLowerCase() === "invalid cursor"
  );
}

type GammaMarket = {
  id?: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  clobTokenIds?: string[] | string;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  image?: string;
  icon?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  endDate?: string;
  liquidity?: string | number;
  liquidityNum?: number;
  volume?: string | number;
  volumeNum?: number;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  rfqEnabled?: boolean;
  event?: GammaEvent;
  events?: GammaEvent[];
};

type GammaEvent = {
  id?: string;
  slug?: string;
  title?: string;
  image?: string;
  icon?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  seriesSlug?: string;
  endDate?: string;
  volume?: string | number;
  liquidity?: string | number;
  tags?: Array<{ label?: string; slug?: string }>;
  markets?: GammaMarket[];
};

type GammaKeysetResponse = {
  events?: GammaEvent[];
  markets?: GammaMarket[];
  data?: GammaEvent[];
  next_cursor?: string | null;
  nextCursor?: string | null;
  cursor?: string | null;
  pagination?: {
    next_cursor?: string | null;
    nextCursor?: string | null;
    cursor?: string | null;
    has_more?: boolean;
    hasMore?: boolean;
  };
};

type ClobOrderBookLevel = {
  price?: string;
  size?: string;
};

type ClobOrderBook = {
  asset_id?: string;
  timestamp?: string | number;
  hash?: string;
  bids?: ClobOrderBookLevel[];
  asks?: ClobOrderBookLevel[];
};

export type PolymarketSweepProgress = {
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

export type PolymarketMarketTombstone = {
  marketId: string;
  conditionId?: string;
  question: string;
  marketUrl?: string;
  category: string;
  sourceCategory?: string;
  sourceTags?: string[];
  eventGroupKey?: string;
  eventTitle?: string;
  eventSlug?: string;
  endDate?: string;
  liquidity?: number;
  volume?: number;
  enableOrderBook?: boolean;
  negRisk?: boolean;
  rfqEnabled?: boolean;
  sourceActive: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders?: boolean;
  sourceAsOf?: string;
  source: "polymarket";
};

export type PolymarketOutcomeResult = {
  outcomes: MarketOutcome[];
  tombstones: PolymarketMarketTombstone[];
  totalFeeds: number;
  successfulFeeds: number;
  complete: boolean;
  nextCursor?: string;
  sweep: PolymarketSweepProgress;
};

export type OrderBookHydrationOptions = {
  requestedNotionalUsd?: number;
  retainUnexecutable?: boolean;
  requireExplicitLifecycle?: boolean;
};

type KeysetPageResult<T> = {
  items: T[];
  attemptedPages: number;
  successfulPages: number;
  complete: boolean;
  nextCursor?: string;
  truncated: boolean;
  stoppedReason: PolymarketSweepProgress["stoppedReason"];
  maxPages: number;
};

function parseArray(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function roundPrice(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function eventTags(event?: GammaEvent) {
  return (event?.tags || []).flatMap((tag) => [tag.label, tag.slug]).filter((tag): tag is string => Boolean(tag));
}

function sourceTagsFor(market: GammaMarket, event?: GammaEvent) {
  return [...eventTags(event), event?.category, event?.seriesSlug, market.category].filter((tag): tag is string => Boolean(tag));
}

function primaryEventForMarket(market: GammaMarket, event?: GammaEvent) {
  return event || market.event || market.events?.[0];
}

function bestBid(book: ClobOrderBook) {
  const prices = (book.bids || [])
    .map((level) => ({
      price: parseNumber(level.price),
      size: parseNumber(level.size)
    }))
    .filter((level): level is { price: number; size: number } => level.price !== undefined && level.size !== undefined && level.price > 0 && level.price < 1 && level.size > 0)
    .map((level) => level.price);
  if (prices.length === 0) return undefined;
  return Math.max(...prices);
}

function bestAsk(book: ClobOrderBook) {
  return validAskLevels(book)[0]?.price;
}

function validAskLevels(book: ClobOrderBook) {
  return (book.asks || [])
    .map((level) => ({
      price: parseNumber(level.price),
      size: parseNumber(level.size)
    }))
    .filter(
      (level): level is { price: number; size: number } =>
        level.price !== undefined && level.size !== undefined && level.price > 0 && level.price < 1 && level.size > 0
    )
    .sort((left, right) => left.price - right.price);
}

function askSideExecution(book: ClobOrderBook, requestedNotionalUsd?: number) {
  const asks = validAskLevels(book);
  if (asks.length === 0) return undefined;

  const displayBestAsk = asks[0].price;
  const availableAskNotionalUsd = roundPrice(asks.reduce((sum, level) => sum + level.price * level.size, 0));
  const requested = requestedNotionalUsd !== undefined && requestedNotionalUsd > 0 ? requestedNotionalUsd : undefined;

  if (!requested) {
    return {
      bestAsk: displayBestAsk,
      executablePrice: displayBestAsk,
      vwapPrice: undefined,
      requestedNotionalUsd: undefined,
      availableAskNotionalUsd,
      sufficientDepth: true,
      priceSource: "clob_ask" as const
    };
  }

  if (availableAskNotionalUsd + 0.000001 < requested) {
    return {
      bestAsk: displayBestAsk,
      executablePrice: undefined,
      vwapPrice: undefined,
      requestedNotionalUsd: requested,
      availableAskNotionalUsd,
      sufficientDepth: false,
      priceSource: "clob_vwap" as const
    };
  }

  let remainingNotional = requested;
  let filledShares = 0;
  let spentNotional = 0;

  for (const level of asks) {
    if (remainingNotional <= 0) break;
    const levelNotional = level.price * level.size;
    const takeNotional = Math.min(remainingNotional, levelNotional);
    filledShares += takeNotional / level.price;
    spentNotional += takeNotional;
    remainingNotional -= takeNotional;
  }

  if (filledShares <= 0 || spentNotional + 0.000001 < requested) {
    return {
      bestAsk: displayBestAsk,
      executablePrice: undefined,
      vwapPrice: undefined,
      requestedNotionalUsd: requested,
      availableAskNotionalUsd,
      sufficientDepth: false,
      priceSource: "clob_vwap" as const
    };
  }

  const vwapPrice = roundPrice(spentNotional / filledShares);
  return {
    bestAsk: displayBestAsk,
    executablePrice: vwapPrice,
    vwapPrice,
    requestedNotionalUsd: requested,
    availableAskNotionalUsd,
    sufficientDepth: true,
    priceSource: "clob_vwap" as const
  };
}

function marketUrl(slug?: string) {
  return slug ? `https://polymarket.com/event/${slug}` : undefined;
}

export function normalizeGammaMarket(market: GammaMarket, event?: GammaEvent): MarketOutcome[] {
  const sourceEvent = primaryEventForMarket(market, event);

  const outcomes = parseArray(market.outcomes);
  const prices = parseArray(market.outcomePrices).map(Number);
  const tokenIds = parseArray(market.clobTokenIds);
  const question = market.question?.trim();
  const marketId = market.conditionId;
  const endDate = market.endDate || sourceEvent?.endDate;
  const sourceUrl = marketUrl(sourceEvent?.slug || market.slug);
  const tagCategory = sourceEvent?.tags?.find((tag) => tag.label || tag.slug)?.label || sourceEvent?.tags?.[0]?.slug;
  const duplicateOutcomes = new Set(outcomes).size !== outcomes.length;
  const sourceCategory = market.category || sourceEvent?.category || tagCategory || "Other";
  const tags = sourceTagsFor(market, sourceEvent);

  if (
    !question ||
    !marketId ||
    outcomes.length === 0 ||
    duplicateOutcomes ||
    outcomes.length !== prices.length ||
    outcomes.length !== tokenIds.length ||
    tokenIds.some((tokenId) => !tokenId)
  ) {
    return [];
  }

  return outcomes
    .map((outcome, index) => ({
      id: `${marketId}-${outcome}`,
      marketId,
      conditionId: market.conditionId,
      tokenId: tokenIds[index],
      question,
      marketUrl: sourceUrl,
      image: market.image || sourceEvent?.image,
      icon: market.icon || sourceEvent?.icon,
      category: sourceCategory,
      sourceCategory,
      sourceTags: tags,
      eventGroupKey: sourceEvent?.slug ? `polymarket:event:${sourceEvent.slug}` : undefined,
      eventTitle: sourceEvent?.title,
      eventSlug: sourceEvent?.slug,
      outcome,
      price: prices[index],
      endDate,
      liquidity: parseNumber(market.liquidityNum ?? market.liquidity ?? sourceEvent?.liquidity),
      volume: parseNumber(market.volumeNum ?? market.volume ?? sourceEvent?.volume),
      bestBid: parseNumber(market.bestBid),
      bestAsk: parseNumber(market.bestAsk),
      spread: parseNumber(market.spread),
      enableOrderBook: market.enableOrderBook,
      negRisk: market.negRisk,
      rfqEnabled: market.rfqEnabled,
      priceSource: "gamma" as const,
      sourceActive:
        market.active === false || sourceEvent?.active === false
          ? false
          : market.active === true && (!sourceEvent || sourceEvent.active === true)
            ? true
            : undefined,
      closed:
        market.closed === true || sourceEvent?.closed === true
          ? true
          : market.closed === false && (!sourceEvent || sourceEvent.closed === false)
            ? false
            : undefined,
      archived:
        market.archived === true || sourceEvent?.archived === true
          ? true
          : market.archived === false && (!sourceEvent || sourceEvent.archived === false)
            ? false
            : undefined,
      acceptingOrders: market.acceptingOrders,
      source: "polymarket" as const
    }))
    .filter((outcome) => outcome.marketUrl && Number.isFinite(outcome.price) && outcome.price > 0 && outcome.price < 1);
}

export function normalizeGammaMarketTombstone(market: GammaMarket, event?: GammaEvent): PolymarketMarketTombstone | undefined {
  const sourceEvent = primaryEventForMarket(market, event);
  const sourceActive = market.active === false || sourceEvent?.active === false ? false : market.active === true && (!sourceEvent || sourceEvent.active === true);
  const closed = market.closed === true || sourceEvent?.closed === true;
  const archived = market.archived === true || sourceEvent?.archived === true;
  if (sourceActive !== false && !closed && !archived) return undefined;

  const marketId = market.conditionId;
  if (!marketId) return undefined;

  const sourceCategory = market.category || sourceEvent?.category || sourceEvent?.tags?.[0]?.label || sourceEvent?.tags?.[0]?.slug || "Other";
  return {
    marketId,
    conditionId: market.conditionId,
    question: market.question?.trim() || sourceEvent?.title?.trim() || marketId,
    marketUrl: marketUrl(sourceEvent?.slug || market.slug),
    category: sourceCategory,
    sourceCategory,
    sourceTags: sourceTagsFor(market, sourceEvent),
    eventGroupKey: sourceEvent?.slug ? `polymarket:event:${sourceEvent.slug}` : undefined,
    eventTitle: sourceEvent?.title,
    eventSlug: sourceEvent?.slug,
    endDate: market.endDate || sourceEvent?.endDate,
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity ?? sourceEvent?.liquidity),
    volume: parseNumber(market.volumeNum ?? market.volume ?? sourceEvent?.volume),
    enableOrderBook: market.enableOrderBook,
    negRisk: market.negRisk,
    rfqEnabled: market.rfqEnabled,
    sourceActive,
    closed,
    archived,
    acceptingOrders: market.acceptingOrders,
    source: "polymarket"
  };
}

function isRetriableStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(resolve, ms);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function fetchWithTimeoutAndRetries(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= POLYMARKET_REQUEST_RETRIES; attempt += 1) {
    const timeout = timeoutSignal(signal, POLYMARKET_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...init,
        signal: timeout.signal
      });

      if (response.ok || !isRetriableStatus(response.status) || attempt === POLYMARKET_REQUEST_RETRIES) {
        return response;
      }

      lastError = new Error(`Polymarket responded with ${response.status}`);
    } catch (error) {
      if (signal?.aborted || (isAbortError(error) && signal?.aborted) || attempt === POLYMARKET_REQUEST_RETRIES) {
        throw error;
      }

      lastError = error;
    } finally {
      timeout.cleanup();
    }

    await delay(POLYMARKET_RETRY_BASE_DELAY_MS * (attempt + 1), signal);
  }

  throw lastError instanceof Error ? lastError : new Error("Polymarket request failed");
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchWithTimeoutAndRetries(
    url,
    {
      headers: {
        accept: "application/json"
      }
    },
    signal
  );

  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string") detail = body.error.slice(0, 200);
    } catch {
      // The HTTP status still carries a useful, bounded failure when the body is not JSON.
    }
    throw new PolymarketApiError(response.status, detail);
  }

  return (await response.json()) as T;
}

function dedupeOutcomes(outcomes: MarketOutcome[]) {
  const byId = new Map<string, MarketOutcome>();
  for (const outcome of outcomes) {
    const current = byId.get(outcome.id);
    const currentScore = (current?.eventSlug ? 2 : 0) + (current?.eventTitle ? 1 : 0) + (current?.sourceTags?.length || 0);
    const nextScore = (outcome.eventSlug ? 2 : 0) + (outcome.eventTitle ? 1 : 0) + (outcome.sourceTags?.length || 0);
    if (!current || nextScore > currentScore) {
      byId.set(outcome.id, outcome);
    }
  }
  return [...byId.values()].sort(
    (left, right) =>
      (right.volume || 0) - (left.volume || 0) ||
      left.marketId.localeCompare(right.marketId) ||
      left.outcome.localeCompare(right.outcome)
  );
}

function keysetItems<T extends GammaEvent | GammaMarket>(response: GammaKeysetResponse, resource: "events" | "markets"): T[] {
  const items = resource === "events" ? response.events || response.data || [] : response.markets || response.data || [];
  return Array.isArray(items) ? (items as T[]) : [];
}

function nextCursorFrom(response: GammaKeysetResponse) {
  return (
    response.next_cursor ||
    response.nextCursor ||
    response.cursor ||
    response.pagination?.next_cursor ||
    response.pagination?.nextCursor ||
    response.pagination?.cursor ||
    undefined
  );
}

function keysetUrl(resource: "events" | "markets", cursor?: string) {
  const url = new URL(`${GAMMA_API_BASE_URL}/${resource}/keyset`);
  url.searchParams.set("limit", String(GAMMA_KEYSET_LIMIT));
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  if (cursor) {
    url.searchParams.set("after_cursor", cursor);
  }
  return url.toString();
}

async function fetchKeysetPages<T extends GammaEvent | GammaMarket>(
  resource: "events" | "markets",
  signal?: AbortSignal,
  options: {
    afterCursor?: string;
    maxPages?: number;
  } = {}
): Promise<KeysetPageResult<T>> {
  const items: T[] = [];
  const seenRequestCursors = new Set<string>();
  const seenPageKeys = new Set<string>();
  let cursor = options.afterCursor;
  let attemptedPages = 0;
  let successfulPages = 0;
  let complete = true;
  let nextCursor: string | undefined;
  let truncated = false;
  let stoppedReason: KeysetPageResult<T>["stoppedReason"] = "end";
  const maxPages = Math.max(1, options.maxPages ?? GAMMA_MAX_PAGES_PER_RESOURCE);

  for (let page = 0; page < maxPages; page += 1) {
    if (cursor) {
      if (seenRequestCursors.has(cursor)) {
        complete = false;
        stoppedReason = "duplicate_cursor";
        nextCursor = cursor;
        break;
      }
      seenRequestCursors.add(cursor);
    }

    attemptedPages += 1;

    let response: GammaKeysetResponse;
    try {
      response = await fetchJson<GammaKeysetResponse>(keysetUrl(resource, cursor), signal);
    } catch (error) {
      if (successfulPages === 0) throw error;
      complete = false;
      stoppedReason = "request_failed";
      nextCursor = cursor;
      break;
    }

    successfulPages += 1;
    const pageItems = keysetItems<T>(response, resource);
    const pageKey = pageItems.map((item) => item.id || item.slug || "").join("|");
    if (pageKey && seenPageKeys.has(pageKey)) {
      complete = false;
      stoppedReason = "duplicate_page";
      break;
    }
    if (pageKey) seenPageKeys.add(pageKey);

    items.push(...pageItems);
    nextCursor = nextCursorFrom(response);
    if (!nextCursor || pageItems.length === 0) {
      stoppedReason = "end";
      break;
    }

    if (page === maxPages - 1) {
      complete = false;
      truncated = true;
      stoppedReason = "page_cap";
      break;
    }

    cursor = nextCursor;
  }

  return {
    items,
    attemptedPages,
    successfulPages,
    complete,
    nextCursor,
    truncated,
    stoppedReason,
    maxPages
  };
}

export function applyOrderBookPrices(outcomes: MarketOutcome[], books: ClobOrderBook[], options: OrderBookHydrationOptions = {}) {
  const booksByTokenId = new Map(books.filter((book) => book.asset_id).map((book) => [book.asset_id as string, book]));
  const pricedOutcomes: MarketOutcome[] = [];

  for (const outcome of outcomes) {
    if (!outcome.tokenId) continue;

    const book = booksByTokenId.get(outcome.tokenId);
    if (!book) continue;

    const bid = bestBid(book);
    const ask = bestAsk(book);
    const execution = askSideExecution(book, options.requestedNotionalUsd);
    if (!execution?.sufficientDepth || execution.executablePrice === undefined || !Number.isFinite(ask) || ask! <= 0 || ask! >= 1) continue;

    pricedOutcomes.push({
      ...outcome,
      price: execution.executablePrice,
      bestBid: bid,
      bestAsk: execution.bestAsk,
      executablePrice: execution.executablePrice,
      vwapPrice: execution.vwapPrice,
      requestedNotionalUsd: execution.requestedNotionalUsd,
      availableAskNotionalUsd: execution.availableAskNotionalUsd,
      spread: bid !== undefined ? Math.round(Math.max(0, ask! - bid) * 1_000_000) / 1_000_000 : outcome.spread,
      orderbookTimestamp: normalizeClobTimestamp(book.timestamp),
      orderbookHash: book.hash,
      priceSource: execution.priceSource
    });
  }

  return pricedOutcomes;
}

function applyOrderBookEvidence(outcomes: MarketOutcome[], books: ClobOrderBook[], requestedNotionalUsd: number) {
  const booksByTokenId = new Map(books.filter((book) => book.asset_id).map((book) => [book.asset_id as string, book]));

  return outcomes.map((outcome) => {
    const book = outcome.tokenId ? booksByTokenId.get(outcome.tokenId) : undefined;
    if (!book) {
      return {
        ...outcome,
        bestBid: undefined,
        bestAsk: undefined,
        executablePrice: undefined,
        vwapPrice: undefined,
        requestedNotionalUsd,
        availableAskNotionalUsd: 0,
        spread: undefined,
        orderbookTimestamp: undefined,
        orderbookHash: undefined,
        priceSource: "gamma" as const
      };
    }

    const bid = bestBid(book);
    const ask = bestAsk(book);
    const execution = askSideExecution(book, requestedNotionalUsd);
    const executable = Boolean(execution?.sufficientDepth && execution.executablePrice !== undefined && ask !== undefined && ask > 0 && ask < 1);

    return {
      ...outcome,
      price: executable ? execution!.executablePrice! : outcome.price,
      bestBid: bid,
      bestAsk: execution?.bestAsk ?? ask,
      executablePrice: executable ? execution!.executablePrice : undefined,
      vwapPrice: executable ? execution!.vwapPrice : undefined,
      requestedNotionalUsd,
      availableAskNotionalUsd: execution?.availableAskNotionalUsd ?? 0,
      spread: bid !== undefined && ask !== undefined ? Math.round(Math.max(0, ask - bid) * 1_000_000) / 1_000_000 : outcome.spread,
      orderbookTimestamp: normalizeClobTimestamp(book.timestamp),
      orderbookHash: book.hash,
      priceSource: executable ? execution!.priceSource : ("gamma" as const)
    };
  });
}

function normalizeClobTimestamp(value?: string | number) {
  if (value === undefined || value === null || value === "") return undefined;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }

  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        results[currentIndex] = {
          status: "fulfilled",
          value: await mapper(items[currentIndex])
        };
      } catch (reason) {
        results[currentIndex] = {
          status: "rejected",
          reason
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function confirmsNoOrderBook(tokenId: string, signal?: AbortSignal) {
  const response = await fetchWithTimeoutAndRetries(
    `${CLOB_API_BASE_URL}/book?token_id=${encodeURIComponent(tokenId)}`,
    {
      headers: {
        accept: "application/json"
      }
    },
    signal
  );

  if (response.status !== 404) return false;

  try {
    const body = (await response.json()) as { error?: unknown };
    return body?.error === "No orderbook exists for the requested token id";
  } catch {
    return false;
  }
}

async function fetchOrderBooks(tokenIds: string[], signal?: AbortSignal, allowConfirmedMissing = false) {
  const uniqueTokenIds = [...new Set(tokenIds)].filter(Boolean);
  const chunks: string[][] = [];
  for (let index = 0; index < uniqueTokenIds.length; index += CLOB_BOOK_CHUNK_SIZE) {
    chunks.push(uniqueTokenIds.slice(index, index + CLOB_BOOK_CHUNK_SIZE));
  }

  const results = await mapWithConcurrency(chunks, CLOB_BOOK_CONCURRENCY, async (chunk) => {
    const response = await fetchWithTimeoutAndRetries(
      `${CLOB_API_BASE_URL}/books`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(chunk.map((tokenId) => ({ token_id: tokenId })))
      },
      signal
    );

    if (!response.ok) {
      throw new Error(`Polymarket CLOB responded with ${response.status}`);
    }

    const body = (await response.json()) as ClobOrderBook[];
    if (!Array.isArray(body)) {
      throw new Error("Polymarket CLOB returned malformed books response");
    }
    return body;
  });

  const fulfilled = results.filter((result): result is PromiseFulfilledResult<ClobOrderBook[]> => result.status === "fulfilled");
  const books = fulfilled.flatMap((result) => result.value);
  const returnedTokenIds = books.map((book) => book.asset_id);
  const requestedTokenIds = new Set(uniqueTokenIds);
  const returnedTokenIdSet = new Set(returnedTokenIds);
  const hasEmptyTokenId = returnedTokenIds.some((tokenId) => typeof tokenId !== "string" || tokenId.trim().length === 0);
  const hasDuplicateTokenId = returnedTokenIdSet.size !== returnedTokenIds.length;
  const hasUnexpectedTokenId = returnedTokenIds.some((tokenId) => !requestedTokenIds.has(tokenId as string));
  const missingTokenIds = uniqueTokenIds.filter((tokenId) => !returnedTokenIdSet.has(tokenId));
  const responseIdentityValid =
    fulfilled.length === chunks.length && !hasEmptyTokenId && !hasDuplicateTokenId && !hasUnexpectedTokenId;
  let missingTokenIdsConfirmed = missingTokenIds.length === 0;

  if (allowConfirmedMissing && responseIdentityValid && missingTokenIds.length > 0) {
    const confirmations = await mapWithConcurrency(missingTokenIds, CLOB_BOOK_CONCURRENCY, (tokenId) => confirmsNoOrderBook(tokenId, signal));
    missingTokenIdsConfirmed = confirmations.every((result) => result.status === "fulfilled" && result.value);
  }

  return {
    books,
    complete: responseIdentityValid && missingTokenIdsConfirmed,
    attemptedChunks: chunks.length,
    successfulChunks: fulfilled.length
  };
}

function isOrderBookCandidate(outcome: MarketOutcome, requireExplicitLifecycle = false) {
  return (
    (requireExplicitLifecycle
      ? outcome.sourceActive === true &&
        outcome.closed === false &&
        outcome.archived === false &&
        outcome.acceptingOrders === true &&
        outcome.enableOrderBook === true
      : outcome.sourceActive !== false &&
        !outcome.closed &&
        !outcome.archived &&
        outcome.acceptingOrders !== false &&
        outcome.enableOrderBook !== false) &&
    typeof outcome.tokenId === "string" &&
    outcome.tokenId.trim().length > 0
  );
}

export async function hydrateOutcomesWithOrderBooks(outcomes: MarketOutcome[], signal?: AbortSignal, options: OrderBookHydrationOptions = {}) {
  const candidateOutcomes = outcomes.filter((outcome) => isOrderBookCandidate(outcome, options.requireExplicitLifecycle));
  const orderBooks = await fetchOrderBooks(
    candidateOutcomes.map((outcome) => outcome.tokenId as string),
    signal,
    options.retainUnexecutable === true
  );
  const requestedNotionalUsd = options.requestedNotionalUsd ?? 25;
  const sourceAsOf = new Date().toISOString();
  const hydratedCandidates = options.retainUnexecutable
    ? applyOrderBookEvidence(candidateOutcomes, orderBooks.books, requestedNotionalUsd)
    : applyOrderBookPrices(candidateOutcomes, orderBooks.books, { requestedNotionalUsd });
  const hydratedById = new Map(hydratedCandidates.map((outcome) => [outcome.id, outcome]));
  const hydratedOutcomes = orderBooks.complete
    ? options.retainUnexecutable
      ? outcomes.map((outcome) => hydratedById.get(outcome.id) || outcome)
      : hydratedCandidates
    : options.retainUnexecutable
      ? outcomes
      : [];
  const hydrated = hydratedOutcomes.map((outcome) => ({
    ...outcome,
    sourceAsOf
  }));

  return {
    outcomes: hydrated,
    complete: orderBooks.complete,
    attemptedChunks: orderBooks.attemptedChunks,
    successfulChunks: orderBooks.successfulChunks
  };
}

export type PolymarketFetchOptions = {
  hydrate?: boolean;
  hydrateLimit?: number;
  requestedNotionalUsd?: number;
  retainUnexecutable?: boolean;
  requireCompleteHydration?: boolean;
  afterCursor?: string;
  maxPages?: number;
};

export type MarketCatalogQuery = {
  cursor?: string;
  limit?: number;
  search?: string;
  category?: string;
  sort?: "volume" | "liquidity" | "ending_soon" | "newest";
  eventGroupKey?: string;
};

function eventMarketRecords(events: GammaEvent[]) {
  const outcomes: MarketOutcome[] = [];
  const tombstonesByMarketId = new Map<string, PolymarketMarketTombstone>();

  for (const event of events) {
    for (const market of event.markets || []) {
      outcomes.push(...normalizeGammaMarket(market, event));
      const tombstone = normalizeGammaMarketTombstone(market, event);
      if (tombstone) tombstonesByMarketId.set(tombstone.marketId, tombstone);
    }
  }

  return {
    outcomes,
    tombstones: [...tombstonesByMarketId.values()].sort((left, right) => left.marketId.localeCompare(right.marketId))
  };
}

export async function fetchPolymarketOutcomeResult(signal?: AbortSignal, options: PolymarketFetchOptions = {}): Promise<PolymarketOutcomeResult> {
  const events = await fetchKeysetPages<GammaEvent>("events", signal, {
    afterCursor: options.afterCursor,
    maxPages: options.maxPages
  });
  const records = eventMarketRecords(events.items);
  const outcomes = dedupeOutcomes(records.outcomes);
  const tombstones = records.tombstones;

  if (outcomes.length === 0 && tombstones.length === 0) throw new Error("No markets were returned");

  const shouldHydrate = options.hydrate === true;
  const hydrateLimit = Math.max(0, Math.min(options.hydrateLimit ?? 100, outcomes.length));
  const sweep: PolymarketSweepProgress = {
    resource: "events",
    startedAfterCursor: options.afterCursor,
    attemptedPages: events.attemptedPages,
    successfulPages: events.successfulPages,
    maxPages: events.maxPages,
    nextCursor: events.nextCursor,
    complete: events.complete && !options.afterCursor,
    truncated: events.truncated,
    stoppedReason: events.stoppedReason
  };

  if (!shouldHydrate) {
    return {
      outcomes,
      tombstones,
      totalFeeds: events.attemptedPages,
      successfulFeeds: events.successfulPages,
      complete: sweep.complete,
      nextCursor: events.nextCursor,
      sweep
    };
  }

  const hydrationTargets = outcomes.slice(0, hydrateLimit);
  const hasHydrationCandidates = hydrationTargets.some((outcome) => isOrderBookCandidate(outcome));
  const hydrated = await hydrateOutcomesWithOrderBooks(hydrationTargets, signal, {
    requestedNotionalUsd: options.requestedNotionalUsd,
    retainUnexecutable: options.retainUnexecutable
  });
  if (options.requireCompleteHydration && !hydrated.complete) {
    throw new Error("Polymarket CLOB hydration was incomplete");
  }
  const hydratedById = new Map(hydrated.outcomes.map((outcome) => [outcome.id, outcome]));
  const publicOutcomes: MarketOutcome[] = [];
  for (const outcome of hydrationTargets) {
    const hydratedOutcome = hydratedById.get(outcome.id);
    if (hydratedOutcome) publicOutcomes.push(hydratedOutcome);
  }

  if (publicOutcomes.length === 0 && hasHydrationCandidates) {
    throw new Error("No executable Polymarket orderbook prices were returned");
  }

  return {
    outcomes: publicOutcomes,
    tombstones,
    totalFeeds: events.attemptedPages + hydrated.attemptedChunks,
    successfulFeeds: events.successfulPages + hydrated.successfulChunks,
    complete: sweep.complete && hydrated.complete,
    nextCursor: events.nextCursor,
    sweep: {
      ...sweep,
      complete: sweep.complete && hydrated.complete
    }
  };
}

export async function fetchPolymarketOutcomes(signal?: AbortSignal): Promise<MarketOutcome[]> {
  return (await fetchPolymarketOutcomeResult(signal)).outcomes;
}

function legworkApiBaseUrl() {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
  return meta.env?.VITE_LEGWORK_API_URL || "";
}

function allowDirectPolymarketFallback() {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | boolean | undefined> };
  return meta.env?.DEV === true && meta.env?.VITE_ALLOW_DIRECT_POLYMARKET_FALLBACK === "true";
}

function timeoutSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();

  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

function catalogQueryParams(query?: MarketCatalogQuery) {
  const params = new URLSearchParams();
  if (!query) return params;

  if (query.cursor) params.set("cursor", query.cursor);
  if (Number.isFinite(query.limit)) params.set("limit", String(Math.floor(query.limit!)));
  if (query.search?.trim()) params.set("search", query.search.trim());
  if (query.category?.trim()) params.set("category", query.category.trim());
  if (query.sort) params.set("sort", query.sort);
  if (query.eventGroupKey?.trim()) params.set("eventGroupKey", query.eventGroupKey.trim());

  return params;
}

async function fetchLegworkApiCatalog(signal?: AbortSignal, query?: MarketCatalogQuery): Promise<MarketCatalog> {
  const baseUrl = legworkApiBaseUrl().replace(/\/$/, "");
  const params = catalogQueryParams(query);
  const queryString = params.toString();
  const timeout = timeoutSignal(signal, 30_000);
  let response: Response;

  try {
    response = await fetch(`${baseUrl}/api/markets${queryString ? `?${queryString}` : ""}`, {
      headers: {
        accept: "application/json"
      },
      signal: timeout.signal
    });
  } finally {
    timeout.cleanup();
  }

  if (!response.ok) {
    throw new Error(`LEGWORK API responded with ${response.status}`);
  }

  const catalog = (await response.json()) as MarketCatalog;
  if (!Array.isArray(catalog.outcomes)) {
    throw new Error("LEGWORK API returned malformed catalog outcomes");
  }

  return catalog;
}

export async function fetchMarketCatalog(signal?: AbortSignal, query?: MarketCatalogQuery): Promise<MarketCatalog> {
  try {
    return await fetchLegworkApiCatalog(signal, query);
  } catch (apiError) {
    if (!allowDirectPolymarketFallback()) {
      throw new Error("LEGWORK API unavailable");
    }

    try {
      const direct = await fetchPolymarketOutcomeResult(signal, { hydrate: true, hydrateLimit: 100, requestedNotionalUsd: 25 });
      return {
        asOf: new Date().toISOString(),
        source: "polymarket",
        outcomes: direct.outcomes,
        totalFeeds: direct.totalFeeds,
        successfulFeeds: direct.successfulFeeds,
        complete: direct.complete,
        nextCursor: direct.nextCursor,
        sweep: direct.sweep
      };
    } catch (fallbackError) {
      const message = apiError instanceof Error ? apiError.message : "LEGWORK API unavailable";
      throw new Error(`${message}. Start the local API with npm run dev:api, then refresh markets.`);
    }
  }
}

export async function fetchMarketOutcomes(signal?: AbortSignal): Promise<MarketOutcome[]> {
  return (await fetchMarketCatalog(signal)).outcomes;
}
