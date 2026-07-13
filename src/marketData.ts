import type { MarketCatalog, MarketOutcome } from "./types";

const EVENT_FEED_URLS = [
  "https://gamma-api.polymarket.com/events/keyset?active=true&closed=false&limit=30&order=volume_24hr&ascending=false",
  "https://gamma-api.polymarket.com/events?tag_id=21&active=true&closed=false&related_tags=true&limit=20&order=volume_24hr&ascending=false",
  "https://gamma-api.polymarket.com/events?tag_id=2&active=true&closed=false&limit=20&order=volume_24hr&ascending=false",
  "https://gamma-api.polymarket.com/events?tag_id=102127&active=true&closed=false&related_tags=true&limit=24&order=volume_24hr&ascending=false",
  "https://gamma-api.polymarket.com/events?tag_id=102331&active=true&closed=false&related_tags=true&limit=16&order=volume_24hr&ascending=false"
];

const SEARCH_TERMS = ["bitcoin", "ethereum", "hype", "crypto", "sports", "politics"];

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

type GammaSearchResponse = {
  events?: GammaEvent[];
};

type GammaKeysetResponse = {
  events?: GammaEvent[];
  data?: GammaEvent[];
};

type ClobOrderBookLevel = {
  price?: string;
  size?: string;
};

type ClobOrderBook = {
  asset_id?: string;
  timestamp?: string;
  hash?: string;
  bids?: ClobOrderBookLevel[];
  asks?: ClobOrderBookLevel[];
};

type PolymarketOutcomeResult = {
  outcomes: MarketOutcome[];
  totalFeeds: number;
  successfulFeeds: number;
  complete: boolean;
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

function bestBid(book: ClobOrderBook) {
  const prices = (book.bids || []).map((level) => parseNumber(level.price)).filter((price): price is number => price !== undefined);
  if (prices.length === 0) return undefined;
  return Math.max(...prices);
}

function bestAsk(book: ClobOrderBook) {
  const prices = (book.asks || []).map((level) => parseNumber(level.price)).filter((price): price is number => price !== undefined);
  if (prices.length === 0) return undefined;
  return Math.min(...prices);
}

function marketUrl(slug?: string) {
  return slug ? `https://polymarket.com/event/${slug}` : undefined;
}

function isPastEndDate(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() < Date.now();
}

export function normalizeGammaMarket(market: GammaMarket, event?: GammaEvent): MarketOutcome[] {
  if (
    market.closed ||
    market.archived ||
    market.active === false ||
    market.acceptingOrders === false ||
    event?.closed ||
    event?.archived ||
    event?.active === false
  ) {
    return [];
  }

  const outcomes = parseArray(market.outcomes);
  const prices = parseArray(market.outcomePrices).map(Number);
  const tokenIds = parseArray(market.clobTokenIds);
  const question = market.question?.trim();
  const marketId = market.conditionId || market.id;
  const endDate = market.endDate || event?.endDate;
  const sourceUrl = marketUrl(event?.slug || market.slug);
  const tagCategory = event?.tags?.find((tag) => tag.label || tag.slug)?.label || event?.tags?.[0]?.slug;
  const hasSkewedPrice = prices.some((price) => Number.isFinite(price) && (price >= 0.99 || price <= 0.01));
  const duplicateOutcomes = new Set(outcomes).size !== outcomes.length;

  if (
    !question ||
    !marketId ||
    outcomes.length === 0 ||
    duplicateOutcomes ||
    outcomes.length !== prices.length ||
    outcomes.length !== tokenIds.length ||
    tokenIds.some((tokenId) => !tokenId) ||
    hasSkewedPrice ||
    isPastEndDate(endDate)
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
      image: market.image || event?.image,
      icon: market.icon || event?.icon,
      category: market.category || event?.category || tagCategory || "General",
      outcome,
      price: prices[index],
      endDate,
      liquidity: parseNumber(market.liquidityNum ?? market.liquidity ?? event?.liquidity),
      volume: parseNumber(market.volumeNum ?? market.volume ?? event?.volume),
      bestBid: parseNumber(market.bestBid),
      bestAsk: parseNumber(market.bestAsk),
      spread: parseNumber(market.spread),
      enableOrderBook: market.enableOrderBook,
      negRisk: market.negRisk,
      rfqEnabled: market.rfqEnabled,
      source: "polymarket" as const
    }))
    .filter((outcome) => outcome.marketUrl && Number.isFinite(outcome.price) && outcome.price > 0 && outcome.price < 1);
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    },
    signal
  });

  if (!response.ok) {
    throw new Error(`Polymarket responded with ${response.status}`);
  }

  return (await response.json()) as T;
}

function dedupeOutcomes(outcomes: MarketOutcome[]) {
  const seen = new Set<string>();
  return outcomes.filter((outcome) => {
    if (seen.has(outcome.id)) return false;
    seen.add(outcome.id);
    return true;
  });
}

export function applyOrderBookPrices(outcomes: MarketOutcome[], books: ClobOrderBook[]) {
  const booksByTokenId = new Map(books.filter((book) => book.asset_id).map((book) => [book.asset_id as string, book]));
  const pricedOutcomes: MarketOutcome[] = [];

  for (const outcome of outcomes) {
    if (!outcome.tokenId) continue;

    const book = booksByTokenId.get(outcome.tokenId);
    if (!book) continue;

    const bid = bestBid(book);
    const ask = bestAsk(book);
    if (!Number.isFinite(ask) || ask! <= 0 || ask! >= 1) continue;

    pricedOutcomes.push({
      ...outcome,
      price: ask!,
      bestBid: bid,
      bestAsk: ask,
      spread: bid !== undefined ? Math.round(Math.max(0, ask! - bid) * 1_000_000) / 1_000_000 : outcome.spread,
      orderbookTimestamp: book.timestamp,
      orderbookHash: book.hash,
      priceSource: "clob_ask"
    });
  }

  return pricedOutcomes;
}

async function fetchOrderBooks(tokenIds: string[], signal?: AbortSignal) {
  const uniqueTokenIds = [...new Set(tokenIds)].filter(Boolean);
  const books: ClobOrderBook[] = [];
  const chunkSize = 100;
  let successfulChunks = 0;
  let attemptedChunks = 0;

  for (let index = 0; index < uniqueTokenIds.length; index += chunkSize) {
    attemptedChunks += 1;
    const chunk = uniqueTokenIds.slice(index, index + chunkSize);
    const response = await fetch("https://clob.polymarket.com/books", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(chunk.map((tokenId) => ({ token_id: tokenId }))),
      signal
    });

    if (!response.ok) continue;

    const body = (await response.json()) as ClobOrderBook[];
    if (Array.isArray(body)) {
      books.push(...body);
      successfulChunks += 1;
    }
  }

  return {
    books,
    complete: attemptedChunks > 0 && successfulChunks === attemptedChunks && books.length >= uniqueTokenIds.length,
    attemptedChunks,
    successfulChunks
  };
}

export async function hydrateOutcomesWithOrderBooks(outcomes: MarketOutcome[], signal?: AbortSignal) {
  const orderBooks = await fetchOrderBooks(
    outcomes.map((outcome) => outcome.tokenId).filter((tokenId): tokenId is string => Boolean(tokenId)),
    signal
  );
  const sourceAsOf = new Date().toISOString();
  const hydrated = applyOrderBookPrices(outcomes, orderBooks.books).map((outcome) => ({
    ...outcome,
    sourceAsOf
  }));

  return {
    outcomes: hydrated,
    complete: orderBooks.complete && hydrated.length === outcomes.length,
    attemptedChunks: orderBooks.attemptedChunks,
    successfulChunks: orderBooks.successfulChunks
  };
}

async function fetchSearchOutcomes(term: string, signal?: AbortSignal) {
  const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(term)}&limit_per_type=8`;
  const data = await fetchJson<GammaSearchResponse>(url, signal);
  return (data.events || []).flatMap((event) => (event.markets || []).flatMap((market) => normalizeGammaMarket(market, event)));
}

async function fetchEventOutcomes(url: string, signal?: AbortSignal) {
  const data = await fetchJson<GammaKeysetResponse | GammaEvent[]>(url, signal);
  const events = Array.isArray(data) ? data : data.events || data.data || [];
  return events.flatMap((event) => (event.markets || []).flatMap((market) => normalizeGammaMarket(market, event)));
}

export async function fetchPolymarketOutcomeResult(signal?: AbortSignal): Promise<PolymarketOutcomeResult> {
  const feeds = [
    ...EVENT_FEED_URLS.map((url) => () => fetchEventOutcomes(url, signal)),
    ...SEARCH_TERMS.map((term) => () => fetchSearchOutcomes(term, signal))
  ];
  const results = await Promise.allSettled(feeds.map((fetchFeed) => fetchFeed()));
  const successfulFeeds = results.filter((result) => result.status === "fulfilled").length;
  const liveOutcomes = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const outcomes = dedupeOutcomes(liveOutcomes);

  if (outcomes.length > 0) {
    const executable = await hydrateOutcomesWithOrderBooks(outcomes, signal);

    if (executable.outcomes.length === 0) {
      throw new Error("No executable Polymarket orderbook prices were returned");
    }

    return {
      outcomes: executable.outcomes,
      totalFeeds: feeds.length,
      successfulFeeds,
      complete: successfulFeeds === feeds.length && executable.complete
    };
  }

  throw new Error("No active markets were returned");
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
  return meta.env?.DEV === true || meta.env?.VITE_ALLOW_DIRECT_POLYMARKET_FALLBACK === "true";
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

async function fetchLegworkApiCatalog(signal?: AbortSignal): Promise<MarketCatalog> {
  const baseUrl = legworkApiBaseUrl().replace(/\/$/, "");
  const timeout = timeoutSignal(signal, 30_000);
  let response: Response;

  try {
    response = await fetch(`${baseUrl}/api/markets`, {
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
  if (!Array.isArray(catalog.outcomes) || catalog.outcomes.length === 0) {
    throw new Error("LEGWORK API returned no active markets");
  }

  return catalog;
}

export async function fetchMarketCatalog(signal?: AbortSignal): Promise<MarketCatalog> {
  try {
    return await fetchLegworkApiCatalog(signal);
  } catch (apiError) {
    if (!allowDirectPolymarketFallback()) {
      throw new Error("LEGWORK API unavailable");
    }

    try {
      const direct = await fetchPolymarketOutcomeResult(signal);
      return {
        asOf: new Date().toISOString(),
        source: "polymarket",
        outcomes: direct.outcomes,
        totalFeeds: direct.totalFeeds,
        successfulFeeds: direct.successfulFeeds,
        complete: direct.complete
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
