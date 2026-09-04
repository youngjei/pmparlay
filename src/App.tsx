import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  Banknote,
  ChevronDown,
  Clock3,
  ExternalLink,
  Info,
  Layers3,
  LayoutDashboard,
  ReceiptText,
  RefreshCw,
  Lightbulb,
  Search,
  ShoppingCart,
  Sparkles,
  Trophy,
  X,
  Trash2
} from "lucide-react";
import { fetchMarketCatalog } from "./marketData";
import { LpVaultView } from "./LpVaultView";
import { calculateParlay, formatCents, formatNumber, formatPercent, formatUsd } from "./parlayMath";
import { assessTicketRisk } from "./riskEngine";
import type { ClaimableTicketPage, FetchState, MarketCatalog, MarketCatalogQuery, MarketOutcome, ParlayLeg } from "./types";

const categoryOrder = [
  "All",
  "Politics",
  "Sports",
  "Crypto",
  "Finance and Economy",
  "Technology and Science",
  "Culture and Entertainment",
  "World and Weather",
  "Other"
] as const;
const stakeCapUsd = 5;
const stakeAdds = [1, 2, 5];
const marketPageSize = 48;
const claimableTicketPageSize = 50;
const maxClaimableTicketPages = 200;
const marketCatalogStaleAfterMs = 30_000;
const marketViewCacheTtlMs = 2 * 60_000;
const marketViewCacheMaxEntries = 24;
const sortOptions = [
  { value: "volume", label: "Highest volume" },
  { value: "ending_soon", label: "Ending soon" },
  { value: "liquidity", label: "Deepest liquidity" },
  { value: "newest", label: "Newest" }
] as const;

type SortOrder = (typeof sortOptions)[number]["value"];
type CanonicalCategory = (typeof categoryOrder)[number];

type MarketRow = {
  marketId: string;
  conditionId?: string;
  question: string;
  category: string;
  endDate?: string;
  volume?: number;
  liquidity?: number;
  image?: string;
  icon?: string;
  marketUrl?: string;
  eventGroupKey?: string;
  eventTitle?: string;
  eventSlug?: string;
  source: MarketOutcome["source"];
  outcomes: MarketOutcome[];
};

type MarketEventSurface = {
  key: string;
  structured: boolean;
  rows: MarketRow[];
  category: string;
  eventTitle: string;
  image?: string;
  icon?: string;
  marketUrl?: string;
  volume: number;
  liquidity: number;
  endDate?: string;
  marketCount: number;
};

type PaginationIssue = {
  kind: "duplicate" | "malformed" | "request";
  message: string;
  cursor: string;
};

type MarketViewCacheEntry = {
  catalog: MarketCatalog;
  outcomes: MarketOutcome[];
  nextCursor?: string;
  hasMore: boolean;
  total?: number;
  fetchState: FetchState;
  storedAt: number;
};

type ServerQuote = {
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
  riskDecision: "accept" | "review" | "reject";
  potentialPayoutUsd: number;
  riskChecks: Array<{ level: "ok" | "warn" | "block"; label: string; detail: string }>;
  legs: Array<{
    id: string;
    marketId: string;
    question: string;
    outcome: string;
    price: number;
    marketUrl?: string;
    endDate?: string;
  }>;
};

type ServerTicket = {
  ticketId: string;
  quoteId: string;
  status: string;
  ledgerTransactionId: string;
  accountingMode?: string;
  currency?: string;
};

type ServerPaymentIntent = {
  id: string;
  quoteId: string;
  chainId: number;
  currency: "USDC";
  treasuryAddress: string;
  usdcContractAddress: string;
  amountMicroUnits: string;
  amountUsdc: number;
  requiredConfirmations: number;
  status: "pending" | "submitted" | "confirmed" | "activated" | "expired" | "failed" | "recoverable";
  txHash?: string;
  ticketId?: string;
  recoveryReason?: string;
  expiresAt: string;
};

type PendingPaymentSummary = {
  id: string;
  quoteId: string;
  status: "submitted" | "confirmed" | "recoverable";
  txHash?: string;
  chainId: number;
  amountPaidUsd: number;
  potentialPayoutUsd: number;
  legs: number;
  createdAt: string;
  updatedAt: string;
};

type RecoverablePaymentResponse = {
  status: "recoverable";
  error: "payment_intent_recoverable";
  reason: string;
  paymentIntent?: ServerPaymentIntent;
};

type ApiErrorPayload = {
  detail?: string;
  error?: string;
  status?: string;
  reason?: string;
  paymentIntent?: ServerPaymentIntent;
};

class ApiRequestError extends Error {
  constructor(readonly payload: ApiErrorPayload | null) {
    super(apiErrorMessage(payload, "Request failed."));
  }
}

type PaymentFlowState = "idle" | "loading" | "ready" | "sending" | "pending" | "activating" | "recoverable" | "complete" | "error";

type AppView = "markets" | "portfolio" | "lp-vault";

function appViewFromHash(hash: string): AppView {
  if (hash === "#portfolio") return "portfolio";
  if (hash === "#lp-vault") return "lp-vault";
  return "markets";
}

type AccountSummary = {
  balances: Array<{
    accountType: string;
    currency: string;
    balance: number;
  }>;
  openTickets: number;
  openStakeUsd: number;
  openPotentialPayoutUsd: number;
  openNetLiabilityUsd: number;
};

type TicketSummary = {
  ticketId: string;
  quoteId: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  stakeUsd?: number;
  operationFeeUsd?: number;
  amountPaidUsd?: number;
  potentialPayoutUsd?: number;
  claimableAmountUsd?: number;
  settlementPolicyReviewRequired?: boolean;
  accountingMode?: string;
  currency?: string;
  legs: number;
  legStatusCounts?: {
    pending: number;
    won: number;
    lost: number;
    voided: number;
    disputed: number;
  };
};

type TicketDetail = {
  ticketId: string;
  quoteId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stakeUsd: number;
  operationFeeUsd: number;
  amountPaidUsd: number;
  potentialPayoutUsd: number;
  claimableAmountUsd?: number;
  settlementPolicyReviewRequired?: boolean;
  accountingMode: string;
  currency: string;
  purchaseTxHash?: string;
  purchaseChainId?: number;
  legs: Array<{
    ticketLegId: string;
    status: string;
    settledAt?: string;
    resolutionState?: string;
    resolutionUpdatedAt?: string;
    nextResolutionCheckAt?: string;
    lastResolutionError?: string;
    endDate?: string;
    question: string;
    outcome: string;
    marketUrl?: string;
  }>;
};

type WithdrawalSummary = {
  id: string;
  status: string;
  chainId: number;
  destinationAddress: string;
  amountUsdc: number;
  onchainTxHash?: string;
  createdAt: string;
  updatedAt: string;
};

type TicketClaimResult = {
  ticketId: string;
  status: "claimed" | "already_claimed";
  ticketStatus: "paid";
  amountMicroUnits: string;
  currency: string;
};

type AccountDataState = "idle" | "loading" | "ready" | "error";

type AppProps = {
  auth?: {
    enabled: boolean;
    authenticated: boolean;
    ready: boolean;
    walletSynced?: boolean;
    walletSyncStatus?: "idle" | "syncing" | "synced" | "limited" | "error";
    walletSyncError?: string;
    walletUsdcBalance?: number | null;
    walletBalanceState?: "idle" | "loading" | "ready" | "error";
    walletBalanceError?: string;
    walletAddress?: string;
    userLabel?: string;
    getAccessToken?: () => Promise<string | null>;
    sendUsdcPayment?: (input: {
      treasuryAddress: string;
      usdcContractAddress: string;
      amountMicroUnits: string;
      chainId: number;
    }) => Promise<`0x${string}` | string>;
    login?: () => void;
    retryWalletSync?: () => void;
    logout?: () => void;
  };
};

type ServerQuoteState = "idle" | "loading" | "ready" | "error";
type ServerTicketState = "idle" | "loading" | "ready" | "error";
type TicketDetailState = "idle" | "loading" | "ready" | "error";

function basketSignature(amount: number, legs: ParlayLeg[]) {
  return JSON.stringify({
    amount: Math.round(amount * 100) / 100,
    legs: legs
      .map((leg) => ({
        id: leg.id,
        marketId: leg.marketId,
        outcome: leg.outcome
      }))
      .sort((left, right) => `${left.marketId}:${left.outcome}`.localeCompare(`${right.marketId}:${right.outcome}`))
  });
}

function dateLabel(value?: string) {
  if (!value) return "Open";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Open";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(date);
}

function compactUsd(value?: number) {
  if (!value) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function shortDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function contractCloseDateTime(value?: string) {
  if (!value) return "Close time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Close time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function ageMs(value?: string) {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Date.now() - time);
}

function elapsedLabel(value?: string) {
  const age = ageMs(value);
  if (age === undefined) return "at an unknown time";
  if (age < 15_000) return "just now";
  if (age < 60_000) return `${Math.max(1, Math.round(age / 1_000))}s ago`;
  if (age < 3_600_000) return `${Math.max(1, Math.round(age / 60_000))}m ago`;
  return shortDateTime(value);
}

function feedCoverageLabel(catalog: MarketCatalog | null) {
  if (!catalog || catalog.totalFeeds === undefined || catalog.successfulFeeds === undefined) return "";
  return `${catalog.successfulFeeds}/${catalog.totalFeeds} feeds`;
}

function marketCatalogTrustCopy(catalog: MarketCatalog | null, stale: boolean, partial: boolean) {
  if (!catalog) return "";
  const refreshed = `Refreshed ${elapsedLabel(catalog.asOf)}`;
  const coverage = feedCoverageLabel(catalog);
  const coverageText = coverage ? ` Coverage ${coverage}.` : "";

  if (partial && stale) return `Using a stale partial catalog. ${refreshed}.${coverageText} Some markets may be missing.`;
  if (partial) return `Using a partial catalog. ${refreshed}.${coverageText} Some markets may be missing.`;
  if (stale) return `Using the last available catalog. ${refreshed}.${coverageText} Refresh is running in the background.`;
  return `${refreshed}.${coverageText}`;
}

function compactId(value: string) {
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    accepted: "Live",
    live: "Live",
    won: "Won",
    claimable: "Claimable",
    lost: "Lost",
    voided: "Stake returned",
    paid: "Claimed",
    confirming: "Confirming",
    submitted: "Confirming",
    confirmed: "Confirming",
    requested: "Requested",
    sent: "Sent",
    canceled: "Canceled",
    failed: "Failed"
  };
  return labels[status] || status.replace(/_/g, " ");
}

function isPastDate(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

function resolutionLabel(resolutionState?: string) {
  const labels: Record<string, string> = {
    awaiting_oracle: "Awaiting oracle",
    settlement_blocked: "Needs review",
    resolution_candidate: "Checking",
    disputed: "Disputed",
    resolved_won: "Won",
    resolved_lost: "Lost",
    resolved_void: "Removed",
    resolved_partial: "Partial"
  };
  return resolutionState ? labels[resolutionState] : undefined;
}

function legStatusLabel(status: string, resolutionState?: string, endDate?: string, ticketStatus?: string) {
  if (status === "voided" || resolutionState === "resolved_void") return "Removed";
  if (status === "pending" && ticketStatus === "lost") return "No longer needed";
  if (status === "pending") return resolutionLabel(resolutionState) || (isPastDate(endDate) ? "Checking" : "Active");
  return statusLabel(status);
}

function resolutionStateLabel(state?: string) {
  const labels: Record<string, string> = {
    pending: "pending",
    resolution_candidate: "candidate",
    awaiting_oracle: "awaiting oracle",
    disputed: "disputed",
    resolved_won: "resolved won",
    resolved_lost: "resolved lost",
    resolved_void: "resolved void",
    resolved_partial: "resolved partial",
    settlement_blocked: "blocked"
  };
  return labels[state || ""] || (state ? state.replace(/_/g, " ") : "pending");
}

function settlementDetailText(leg: TicketDetail["legs"][number]) {
  const parts = [
    `Resolution ${resolutionStateLabel(leg.resolutionState)}`,
    leg.endDate ? `Ends ${shortDateTime(leg.endDate)}` : "",
    leg.nextResolutionCheckAt ? `Next check ${shortDateTime(leg.nextResolutionCheckAt)}` : "",
    leg.resolutionUpdatedAt ? `Updated ${shortDateTime(leg.resolutionUpdatedAt)}` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function settlementSummaryText(leg: TicketDetail["legs"][number], ticketStatus: string) {
  const status = leg.resolutionState || leg.status;
  if (status === "resolved_won" || leg.status === "won") return "Resolved in your favor.";
  if (status === "resolved_lost" || leg.status === "lost") return "Resolved against this pick.";
  if (status === "resolved_void" || leg.status === "voided") return "Voided; this leg was removed from the basket payout calculation.";
  if (ticketStatus === "lost" && leg.status === "pending") return "No longer affects this basket.";
  if (status === "disputed" || status === "settlement_blocked") return "Settlement needs review.";
  if (isPastDate(leg.endDate)) return "Waiting for the final market result.";
  return "Market is still active.";
}

function isAllVoidedTicket(ticket: TicketSummary | TicketDetail) {
  return ticket.status === "voided";
}

function legProgressText(ticket: TicketSummary | TicketDetail) {
  const counts =
    "legStatusCounts" in ticket && ticket.legStatusCounts
      ? ticket.legStatusCounts
      : "legs" in ticket && Array.isArray(ticket.legs)
        ? ticket.legs.reduce(
            (acc, leg) => {
              acc[leg.status as keyof typeof acc] = (acc[leg.status as keyof typeof acc] || 0) + 1;
              return acc;
            },
            { pending: 0, won: 0, lost: 0, voided: 0, disputed: 0 }
          )
        : undefined;

  if (!counts) return "";
  const parts = [
    counts.won ? `${counts.won} won` : "",
    counts.lost ? `${counts.lost} lost` : "",
    counts.voided ? `${counts.voided} voided` : "",
    counts.disputed ? `${counts.disputed} disputed` : "",
    counts.pending ? `${counts.pending} active` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function statusTone(status: string) {
  if (status === "confirming" || status === "submitted" || status === "confirmed") return "confirming";
  if (status === "awaiting_oracle" || status === "resolution_candidate") return "confirming";
  if (status === "settlement_blocked" || status === "disputed") return "voided";
  if (status === "won" || status === "claimable" || status === "resolved_won") return "won";
  if (status === "paid" || status === "sent") return "paid";
  if (status === "lost" || status === "failed" || status === "resolved_lost") return "lost";
  if (status === "voided" || status === "canceled" || status === "resolved_void") return "voided";
  return "live";
}

function chainLabel(chainId?: number) {
  if (chainId === 1) return "Ethereum";
  if (chainId === 11155111) return "Sepolia";
  if (chainId === 137) return "Polygon";
  if (chainId === 80002) return "Polygon Amoy";
  if (chainId === 8453) return "Base";
  if (chainId === 84532) return "Base Sepolia";
  return chainId ? `Chain ${chainId}` : "Ethereum";
}

function txExplorerUrl(txHash: string, chainId?: number) {
  if (chainId === 11155111) return `https://sepolia.etherscan.io/tx/${txHash}`;
  if (chainId === 137) return `https://polygonscan.com/tx/${txHash}`;
  if (chainId === 80002) return `https://amoy.polygonscan.com/tx/${txHash}`;
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return `https://etherscan.io/tx/${txHash}`;
}

function expiryCountdown(expiresAt: string, now: number) {
  const remainingSeconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1_000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function configuredSettlementChainId() {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
  const chainId = Number(meta.env?.VITE_SETTLEMENT_CHAIN_ID || 11155111);
  return Number.isFinite(chainId) && chainId > 0 ? chainId : 11155111;
}

function balanceFor(summary: AccountSummary | null, accountTypes: string[], currency = "USDC") {
  const account = summary?.balances.find((item) => accountTypes.includes(item.accountType) && item.currency === currency);
  return account?.balance || 0;
}

function parseUsdcMicroUnits(value: string) {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(`${fraction}000000`.slice(0, 6));
}

function formatUsdcInput(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(6).replace(/\.0+$/, "").replace(/(\.[0-9]*?)0+$/, "$1");
}

function availableUsdcMicroUnits(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.round(value * 1_000_000));
}

function formatUsdcMicroUnits(value: bigint) {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function authedJson<T>(url: string, getAccessToken?: () => Promise<string | null>, signal?: AbortSignal): Promise<T> {
  const token = getAccessToken ? await getAccessToken() : null;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    signal
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string; error?: string } | null;
    throw new Error(apiErrorMessage(payload, "Request failed."));
  }

  return (await response.json()) as T;
}

async function authedPostJson<T>(
  url: string,
  getAccessToken?: () => Promise<string | null>,
  body?: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal
): Promise<T> {
  const token = getAccessToken ? await getAccessToken() : null;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal
  });
  const payload = (await response.json().catch(() => null)) as T | ApiErrorPayload | null;
  if (!response.ok) {
    throw new ApiRequestError(payload && typeof payload === "object" ? (payload as ApiErrorPayload) : null);
  }

  return payload as T;
}

function claimErrorMessage(error: unknown) {
  const message = apiErrorCode(error) || (error instanceof Error ? error.message.toLowerCase() : "");
  if (message.includes("unauthorized") || message.includes("session expired")) {
    return "Your wallet session has expired. Reconnect your wallet and try again.";
  }
  if (message.includes("already_claimed")) {
    return "This ticket was already claimed. Your balance is being refreshed.";
  }
  if (message.includes("not_claimable") || message.includes("invalid_ticket_status")) {
    return "This ticket is no longer ready to claim. Portfolio is refreshing with its latest status.";
  }
  if (message.includes("not_found")) {
    return "This ticket is no longer available. Portfolio is refreshing.";
  }
  if (message.includes("idempotency")) {
    return "This claim is already being processed. Check your available balance before retrying.";
  }
  if (message.includes("rate") && message.includes("limit")) {
    return "Too many claim attempts. Wait a moment, then try again.";
  }
  return "We could not claim this ticket. Try again in a moment.";
}

function withdrawalRequestErrorMessage(error: unknown) {
  const message = apiErrorCode(error) || (error instanceof Error ? error.message.toLowerCase() : "");
  if (message.includes("unauthorized") || message.includes("session expired")) {
    return "Your wallet session has expired. Reconnect your wallet and try again.";
  }
  if (message.includes("destination_wallet_not_linked")) {
    return "This wallet is no longer verified for withdrawals. Reconnect it and try again.";
  }
  if (message.includes("insufficient_user_balance")) {
    return "Your available LEGWORK balance changed. Review the updated balance and try again.";
  }
  if (message.includes("idempotency")) {
    return "This withdrawal request is already being processed. Check your withdrawal history before retrying.";
  }
  if (message.includes("rate") && message.includes("limit")) {
    return "Too many withdrawal requests. Wait a moment, then try again.";
  }
  return "We could not create this withdrawal request. Try again in a moment.";
}

function apiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const item = payload as { detail?: string; error?: string };
  if (item.error === "unauthorized") return "Wallet session expired. Reconnect your wallet and try again.";
  if (item.error === "executable_price_unavailable") return "LEGWORK could not verify current executable prices for every selected leg. Retry in a moment.";
  if (item.error === "quote_pricing_timeout") return "LEGWORK could not refresh executable prices quickly enough. Retry in a moment.";
  if (item.error === "unknown_market_outcome") return "One selected market is no longer available. Refresh markets and rebuild the basket.";
  if (item.error === "financial_operations_unavailable") return "Payments are temporarily unavailable. Try again shortly.";
  if (item.error === "payment_intent_expired" || item.error === "quote_expired") return "This quote expired. Refresh it before paying.";
  return fallback;
}

function apiErrorCode(error: unknown) {
  if (error instanceof ApiRequestError && typeof error.payload?.error === "string") return error.payload.error.toLowerCase();
  return "";
}

function claimErrorNeedsRefresh(error: unknown) {
  const code = apiErrorCode(error);
  return ["already_claimed", "not_claimable", "invalid_ticket_status", "not_found"].includes(code);
}

function isRecoverablePaymentResponse(value: unknown): value is RecoverablePaymentResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<RecoverablePaymentResponse>;
  return response.status === "recoverable" && response.error === "payment_intent_recoverable" && typeof response.reason === "string";
}

function recoverablePaymentMessage() {
  return "This basket could not be activated. Received USDC was returned to your available LEGWORK balance. Open Portfolio to review the balance and current withdrawal status.";
}

function marketInitial(question: string) {
  return question.replace(/^(will|can|does|do|is|are)\s+/i, "").trim().slice(0, 1).toUpperCase() || "?";
}

function sourceLabel(source: MarketOutcome["source"], marketUrl?: string) {
  if (source === "polymarket" && marketUrl) return "Open on Polymarket";
  if (source === "polymarket") return "Polymarket source";
  return "Source unavailable";
}

function legacyEventKey(marketUrl?: string) {
  if (!marketUrl) return "";
  try {
    return new URL(marketUrl).pathname.replace(/\/$/, "");
  } catch {
    return marketUrl.replace(/\/$/, "");
  }
}

function outcomeEventKey(outcome: Pick<MarketOutcome, "eventGroupKey" | "marketUrl" | "marketId">) {
  if (outcome.eventGroupKey) return outcome.eventGroupKey;
  const legacy = legacyEventKey(outcome.marketUrl);
  return legacy ? `legacy:${legacy}` : `market:${outcome.marketId}`;
}

function rowEventKey(row: MarketRow) {
  if (row.eventGroupKey) return row.eventGroupKey;
  const legacy = legacyEventKey(row.marketUrl);
  return legacy ? `legacy:${legacy}` : `market:${row.marketId}`;
}

function canonicalCategory(category?: string) {
  switch ((category || "").trim().toLowerCase()) {
    case "politics":
      return "Politics";
    case "sports":
      return "Sports";
    case "crypto":
      return "Crypto";
    case "finance and economy":
    case "economics":
    case "economy":
    case "finance":
      return "Finance and Economy";
    case "technology and science":
    case "technology":
    case "science":
      return "Technology and Science";
    case "culture and entertainment":
    case "culture":
    case "entertainment":
      return "Culture and Entertainment";
    case "world and weather":
    case "weather":
    case "world":
      return "World and Weather";
    default:
      return "Other";
  }
}

function isYesOutcome(outcome: string) {
  const normalized = outcome.trim().toLowerCase();
  return normalized === "yes" || normalized === "up";
}

function timeValue(value?: string) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? Number.POSITIVE_INFINITY : date.getTime();
}

function isEnded(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

function toMarketRows(outcomes: MarketOutcome[]): MarketRow[] {
  const rows = new Map<string, MarketRow>();

  for (const outcome of outcomes) {
    const current = rows.get(outcome.marketId);
    if (current) {
      current.outcomes.push(outcome);
      current.volume = Math.max(current.volume || 0, outcome.volume || 0);
      current.liquidity = Math.max(current.liquidity || 0, outcome.liquidity || 0);
      current.image ||= outcome.image;
      current.icon ||= outcome.icon;
      current.eventGroupKey ||= outcome.eventGroupKey;
      current.eventTitle ||= outcome.eventTitle;
      current.eventSlug ||= outcome.eventSlug;
      continue;
    }

    rows.set(outcome.marketId, {
      marketId: outcome.marketId,
      conditionId: outcome.conditionId,
      question: outcome.question,
      category: canonicalCategory(outcome.category),
      endDate: outcome.endDate,
      volume: outcome.volume,
      liquidity: outcome.liquidity,
      image: outcome.image,
      icon: outcome.icon,
      marketUrl: outcome.marketUrl,
      eventGroupKey: outcome.eventGroupKey,
      eventTitle: outcome.eventTitle,
      eventSlug: outcome.eventSlug,
      source: outcome.source,
      outcomes: [outcome]
    });
  }

  return [...rows.values()];
}

function toMarketEventSurfaces(rows: MarketRow[]): MarketEventSurface[] {
  const groups = new Map<string, MarketRow[]>();
  for (const row of rows) {
    const key = rowEventKey(row);
    groups.set(key, [...(groups.get(key) || []), row]);
  }

  return [...groups.entries()].map(([key, groupRows]) => {
    const first = groupRows[0];
    const structured = Boolean(first.eventGroupKey);
    const eventTitle = first.eventTitle || (groupRows.length > 1 ? commonEventTitle(groupRows) : first.question);
    return {
      key,
      structured,
      rows: groupRows,
      category: first.category,
      eventTitle,
      image: first.image,
      icon: first.icon,
      marketUrl: first.marketUrl,
      volume: groupRows.reduce((sum, row) => sum + (row.volume || 0), 0),
      liquidity: groupRows.reduce((sum, row) => sum + (row.liquidity || 0), 0),
      endDate: groupRows
        .map((row) => row.endDate)
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => timeValue(left) - timeValue(right))[0],
      marketCount: groupRows.length
    };
  });
}

function commonEventTitle(rows: MarketRow[]) {
  const title = rows.find((row) => row.eventTitle)?.eventTitle;
  if (title) return title;
  const firstUrl = rows[0]?.marketUrl;
  if (firstUrl) {
    try {
      const slug = new URL(firstUrl).pathname.split("/").filter(Boolean).at(-1);
      if (slug) {
        return slug
          .split("-")
          .filter(Boolean)
          .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
          .join(" ");
      }
    } catch {
      // Fall through to the first question.
    }
  }
  return rows[0]?.question || "Related markets";
}

function marketQueryFingerprint(query: MarketCatalogQuery) {
  return JSON.stringify({
    limit: query.limit,
    search: query.search || "",
    category: query.category || "All",
    sort: query.sort || "volume",
    eventGroupKey: query.eventGroupKey || ""
  });
}

function eventSiblingListId(eventKey: string) {
  return `event-siblings-${eventKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export default function App({ auth }: AppProps = {}) {
  const [activeView, setActiveView] = useState<AppView>(() => appViewFromHash(window.location.hash));
  const [marketCatalog, setMarketCatalog] = useState<MarketCatalog | null>(null);
  const [outcomes, setOutcomes] = useState<MarketOutcome[]>([]);
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [marketError, setMarketError] = useState("");
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [sortOrder, setSortOrder] = useState<SortOrder>("volume");
  const [nextMarketCursor, setNextMarketCursor] = useState<string | undefined>();
  const [marketTotal, setMarketTotal] = useState<number | undefined>();
  const [marketHasMore, setMarketHasMore] = useState(false);
  const [loadingMoreMarkets, setLoadingMoreMarkets] = useState(false);
  const [paginationIssue, setPaginationIssue] = useState<PaginationIssue | null>(null);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(() => new Set());
  const [expandedSiblingLimits, setExpandedSiblingLimits] = useState<Record<string, number>>({});
  const [selectionNotice, setSelectionNotice] = useState("");
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [legs, setLegs] = useState<ParlayLeg[]>([]);
  const [amount, setAmount] = useState(0);
  const [amountInput, setAmountInput] = useState("");
  const [stakeLimitKey, setStakeLimitKey] = useState(0);
  const [stakeLimitActive, setStakeLimitActive] = useState(false);
  const [mobileBasketOpen, setMobileBasketOpen] = useState(false);
  const [burstKey, setBurstKey] = useState(0);
  const [serverQuote, setServerQuote] = useState<ServerQuote | null>(null);
  const [serverQuoteBasketKey, setServerQuoteBasketKey] = useState("");
  const [serverQuoteState, setServerQuoteState] = useState<ServerQuoteState>("idle");
  const [serverQuoteError, setServerQuoteError] = useState("");
  const [serverTicket, setServerTicket] = useState<ServerTicket | null>(null);
  const [serverTicketState, setServerTicketState] = useState<ServerTicketState>("idle");
  const [serverTicketError, setServerTicketError] = useState("");
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentIntent, setPaymentIntent] = useState<ServerPaymentIntent | null>(null);
  const [paymentState, setPaymentState] = useState<PaymentFlowState>("idle");
  const [paymentError, setPaymentError] = useState("");
  const [paymentTxHash, setPaymentTxHash] = useState("");
  const [paymentClockNow, setPaymentClockNow] = useState(() => Date.now());
  const [accountState, setAccountState] = useState<AccountDataState>("idle");
  const [accountError, setAccountError] = useState("");
  const [ticketListState, setTicketListState] = useState<AccountDataState>("idle");
  const [ticketListError, setTicketListError] = useState("");
  const [withdrawalError, setWithdrawalError] = useState("");
  const [withdrawalAmountInput, setWithdrawalAmountInput] = useState("");
  const [withdrawalRequestState, setWithdrawalRequestState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [withdrawalRequestMessage, setWithdrawalRequestMessage] = useState("");
  const [cancelingWithdrawalId, setCancelingWithdrawalId] = useState<string | null>(null);
  const [pendingPaymentsError, setPendingPaymentsError] = useState("");
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [claimableTickets, setClaimableTickets] = useState<TicketSummary[]>([]);
  const [claimableTicketListState, setClaimableTicketListState] = useState<AccountDataState>("idle");
  const [claimableTicketListError, setClaimableTicketListError] = useState("");
  const [pendingPayments, setPendingPayments] = useState<PendingPaymentSummary[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [ticketDetail, setTicketDetail] = useState<TicketDetail | null>(null);
  const [ticketDetailState, setTicketDetailState] = useState<TicketDetailState>("idle");
  const [ticketDetailError, setTicketDetailError] = useState("");
  const [ticketDetailRefreshKey, setTicketDetailRefreshKey] = useState(0);
  const [withdrawals, setWithdrawals] = useState<WithdrawalSummary[]>([]);
  const [claimingTicketId, setClaimingTicketId] = useState<string | null>(null);
  const [claimNotice, setClaimNotice] = useState("");
  const [claimError, setClaimError] = useState("");
  const [accountRefreshKey, setAccountRefreshKey] = useState(0);
  const lastPayoutRef = useRef<string | null>(null);
  const marketGenerationRef = useRef(0);
  const marketFingerprintRef = useRef("");
  const marketViewCacheRef = useRef(new Map<string, MarketViewCacheEntry>());
  const marketRequestControllerRef = useRef<AbortController | null>(null);
  const activeAppendCursorRef = useRef<string | undefined>(undefined);
  const consumedMarketCursorsRef = useRef<Set<string>>(new Set());
  const mobileBasketDialogRef = useRef<HTMLDivElement | null>(null);
  const mobileBasketCloseRef = useRef<HTMLButtonElement | null>(null);
  const mobileBasketTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileBasketReturnFocusRef = useRef<HTMLElement | null>(null);
  const paymentModalDialogRef = useRef<HTMLElement | null>(null);
  const paymentModalCloseRef = useRef<HTMLButtonElement | null>(null);
  const paymentModalReturnFocusRef = useRef<HTMLElement | null>(null);
  const ticketDetailPanelRef = useRef<HTMLElement | null>(null);
  const paymentModalOpenRef = useRef(false);
  const paymentReviewCanCloseRef = useRef(true);
  const claimableRequestControllerRef = useRef<AbortController | null>(null);
  const claimRequestControllerRef = useRef<AbortController | null>(null);
  const claimInFlightRef = useRef(new Set<string>());
  const claimAttemptKeysRef = useRef(new Map<string, string>());
  const claimScopeRef = useRef("");
  const withdrawalAttemptRef = useRef<{ key: string; signature: string } | null>(null);
  const paymentReviewCanClose = paymentState !== "sending" && paymentState !== "activating";
  paymentReviewCanCloseRef.current = paymentReviewCanClose;
  const authIdentity = auth?.enabled ? (auth.authenticated ? auth.userLabel || "connected-wallet" : "signed-out") : "local-session";

  const navigateToView = useCallback((view: AppView) => {
    setActiveView(view);
    const nextUrl = new URL(window.location.href);
    nextUrl.hash = view === "markets" ? "" : view;
    window.history.pushState({ view }, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const syncViewFromLocation = () => setActiveView(appViewFromHash(window.location.hash));
    window.addEventListener("popstate", syncViewFromLocation);
    return () => window.removeEventListener("popstate", syncViewFromLocation);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), 260);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const updateViewport = () => setIsMobileViewport(query.matches);
    updateViewport();
    query.addEventListener("change", updateViewport);
    return () => query.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (!paymentModalOpen || !paymentIntent) return;
    setPaymentClockNow(Date.now());
    const interval = window.setInterval(() => setPaymentClockNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [paymentIntent, paymentModalOpen]);

  useEffect(() => {
    if (!isMobileViewport || activeView !== "portfolio" || !selectedTicketId) return;
    const timeout = window.setTimeout(() => {
      ticketDetailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [activeView, isMobileViewport, selectedTicketId]);

  const closeMobileBasket = useCallback(() => setMobileBasketOpen(false), []);
  const openMobileBasket = useCallback(() => {
    mobileBasketReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : mobileBasketTriggerRef.current;
    setMobileBasketOpen(true);
  }, []);

  const closePaymentReview = useCallback(() => {
    if (!paymentReviewCanCloseRef.current) return;
    paymentModalOpenRef.current = false;
    setPaymentModalOpen(false);
  }, []);

  useEffect(() => {
    if (!mobileBasketOpen) return;
    const dialog = mobileBasketDialogRef.current;
    const returnFocus = mobileBasketReturnFocusRef.current || mobileBasketTriggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    mobileBasketCloseRef.current?.focus();

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (paymentModalOpenRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileBasket();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousOverflow;
      if (!paymentModalOpenRef.current && returnFocus?.isConnected) returnFocus.focus();
    };
  }, [closeMobileBasket, mobileBasketOpen]);

  useEffect(() => {
    if (!paymentModalOpen) return;
    paymentModalOpenRef.current = true;
    const dialog = paymentModalDialogRef.current;
    const returnFocus = paymentModalReturnFocusRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    paymentModalCloseRef.current?.focus();

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!paymentReviewCanCloseRef.current) return;
        event.preventDefault();
        closePaymentReview();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousOverflow;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [closePaymentReview, paymentModalOpen]);

  const marketQuery = useMemo<MarketCatalogQuery>(() => {
    const search = debouncedQuery.trim();
    return {
      limit: marketPageSize,
      ...(search ? { search } : {}),
      ...(category === "All" ? {} : { category: canonicalCategory(category) }),
      sort: sortOrder
    };
  }, [category, debouncedQuery, sortOrder]);
  const currentMarketFingerprint = useMemo(() => marketQueryFingerprint(marketQuery), [marketQuery]);

  const loadMarketCatalogPage = useCallback(
    async (mode: "reset" | "append", cursor?: string) => {
      const generation = marketGenerationRef.current;
      const fingerprint = marketFingerprintRef.current;

      if (fingerprint !== currentMarketFingerprint) return;
      if (mode === "append") {
        if (!cursor) return;
        if (consumedMarketCursorsRef.current.has(cursor)) {
          setMarketHasMore(false);
          setPaginationIssue({
            kind: "duplicate",
            cursor,
            message: "Pagination repeated a page cursor. Loading more has stopped to prevent duplicate markets."
          });
          return;
        }
        activeAppendCursorRef.current = cursor;
        setLoadingMoreMarkets(true);
        setPaginationIssue(null);
      } else {
        setMarketError("");
      }

      marketRequestControllerRef.current?.abort();
      const controller = new AbortController();
      marketRequestControllerRef.current = controller;

      const requestIsCurrent = () =>
        !controller.signal.aborted &&
        marketGenerationRef.current === generation &&
        marketFingerprintRef.current === fingerprint &&
        (mode === "reset" || activeAppendCursorRef.current === cursor);

      try {
        const catalog = await fetchMarketCatalog(controller.signal, {
          ...marketQuery,
          ...(mode === "append" && cursor ? { cursor } : {})
        });
        if (!requestIsCurrent()) return;

        const catalogAge = ageMs(catalog.asOf);
        const freshOutcomes = catalog.outcomes || [];
        const returnedCursor = catalog.pageInfo ? catalog.pageInfo.nextCursor : catalog.nextCursor;
        const nextCursor = typeof returnedCursor === "string" && returnedCursor.trim() ? returnedCursor.trim() : undefined;
        const serverHasMore = catalog.pageInfo ? catalog.pageInfo.hasMore : Boolean(nextCursor);
        const malformedPagination = catalog.pageInfo?.hasMore === true && !nextCursor;
        const duplicateCursor =
          mode === "append" &&
          Boolean(nextCursor && (nextCursor === cursor || consumedMarketCursorsRef.current.has(nextCursor)));

        if (mode === "append" && cursor) consumedMarketCursorsRef.current.add(cursor);
        const nextFetchState =
          catalog.complete === false || (catalogAge !== undefined && catalogAge > marketCatalogStaleAfterMs)
            ? "fallback"
            : "live";
        if (mode === "reset") {
          const refreshedById = new Map(freshOutcomes.map((outcome) => [outcome.id, outcome]));
          setLegs((current) => {
            let changed = false;
            const next = current.map((leg) => {
              const refreshed = refreshedById.get(leg.id);
              if (
                !refreshed ||
                (refreshed.sourceAsOf === leg.sourceAsOf &&
                  refreshed.orderbookTimestamp === leg.orderbookTimestamp &&
                  refreshed.price === leg.price &&
                  refreshed.executablePrice === leg.executablePrice &&
                  refreshed.availableAskNotionalUsd === leg.availableAskNotionalUsd)
              ) {
                return leg;
              }
              changed = true;
              return { ...refreshed, addedAt: leg.addedAt };
            });
            return changed ? next : current;
          });
        }
        setMarketCatalog(catalog);
        setOutcomes((current) => {
          if (mode === "reset") return freshOutcomes;
          const byId = new Map<string, MarketOutcome>();
          for (const outcome of current) byId.set(outcome.id, outcome);
          for (const outcome of freshOutcomes) byId.set(outcome.id, outcome);
          return [...byId.values()];
        });
        setNextMarketCursor(nextCursor);
        setMarketHasMore(serverHasMore && !malformedPagination && !duplicateCursor);
        setMarketTotal((current) => catalog.pageInfo?.total ?? current);
        setFetchState(nextFetchState);

        if (mode === "reset") {
          const cache = marketViewCacheRef.current;
          cache.delete(fingerprint);
          cache.set(fingerprint, {
            catalog,
            outcomes: freshOutcomes,
            nextCursor,
            hasMore: serverHasMore && !malformedPagination && !duplicateCursor,
            total: catalog.pageInfo?.total,
            fetchState: nextFetchState,
            storedAt: Date.now()
          });
          while (cache.size > marketViewCacheMaxEntries) {
            const oldestKey = cache.keys().next().value;
            if (!oldestKey) break;
            cache.delete(oldestKey);
          }
        }

        if (malformedPagination) {
          setPaginationIssue({
            kind: "malformed",
            cursor: "",
            message: "Pagination response is missing its next cursor. Loading more has stopped. Retry the catalog."
          });
        } else if (duplicateCursor && cursor) {
          setPaginationIssue({
            kind: "duplicate",
            cursor,
            message: "Pagination returned a cursor that was already used. Loading more has stopped to prevent duplicates."
          });
        } else {
          setPaginationIssue(null);
        }
      } catch (error: unknown) {
        if (!requestIsCurrent()) return;
        const message = error instanceof Error ? error.message : "Live market catalog unavailable.";
        if (mode === "reset") {
          const cached = marketViewCacheRef.current.get(fingerprint);
          if (cached) {
            setFetchState("fallback");
            setMarketError(`Could not refresh markets. ${message}`);
          } else {
            setMarketCatalog(null);
            setOutcomes([]);
            setNextMarketCursor(undefined);
            setMarketHasMore(false);
            setMarketTotal(undefined);
            setFetchState("error");
            setMarketError(message);
          }
        } else if (cursor) {
          setMarketHasMore(false);
          setPaginationIssue({
            kind: "request",
            cursor,
            message: `${message} The markets already loaded are still available.`
          });
        }
      } finally {
        if (marketRequestControllerRef.current === controller) marketRequestControllerRef.current = null;
        if (mode === "append" && activeAppendCursorRef.current === cursor && generation === marketGenerationRef.current) {
          setLoadingMoreMarkets(false);
        }
      }
    },
    [currentMarketFingerprint, marketQuery]
  );

  useEffect(() => {
    marketRequestControllerRef.current?.abort();
    const generation = marketGenerationRef.current + 1;
    marketGenerationRef.current = generation;
    marketFingerprintRef.current = currentMarketFingerprint;
    activeAppendCursorRef.current = undefined;
    consumedMarketCursorsRef.current = new Set();
    const cached = marketViewCacheRef.current.get(currentMarketFingerprint);
    const cacheIsUsable = Boolean(cached && Date.now() - cached.storedAt <= marketViewCacheTtlMs);
    if (cached && cacheIsUsable) {
      setFetchState(cached.fetchState);
      setOutcomes(cached.outcomes);
      setMarketCatalog(cached.catalog);
      setNextMarketCursor(cached.nextCursor);
      setMarketHasMore(cached.hasMore);
      setMarketTotal(cached.total);
    } else {
      if (cached) marketViewCacheRef.current.delete(currentMarketFingerprint);
      setFetchState("loading");
      setOutcomes([]);
      setMarketCatalog(null);
      setNextMarketCursor(undefined);
      setMarketHasMore(false);
      setMarketTotal(undefined);
    }
    setLoadingMoreMarkets(false);
    setMarketError("");
    setPaginationIssue(null);
    setExpandedEvents(new Set());
    setExpandedSiblingLimits({});
    void loadMarketCatalogPage("reset");

    return () => {
      if (marketGenerationRef.current === generation) marketRequestControllerRef.current?.abort();
    };
  }, [currentMarketFingerprint, loadMarketCatalogPage, marketRefreshKey]);

  useEffect(() => {
    claimableRequestControllerRef.current?.abort();
    claimRequestControllerRef.current?.abort();
    claimScopeRef.current = authIdentity;
    claimInFlightRef.current.clear();
    claimAttemptKeysRef.current.clear();
    setClaimingTicketId(null);
    setClaimNotice("");
    setClaimError("");
  }, [authIdentity]);

  useEffect(() => {
    const shouldLoadClaimableTickets = !auth?.enabled || auth.authenticated;
    claimableRequestControllerRef.current?.abort();

    if (!shouldLoadClaimableTickets) {
      setClaimableTickets([]);
      setClaimableTicketListState("idle");
      setClaimableTicketListError("");
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    const requestIdentity = authIdentity;
    const ticketsById = new Map<string, TicketSummary>();
    const consumedCursors = new Set<string>();
    claimableRequestControllerRef.current = controller;
    setClaimableTickets([]);
    setClaimableTicketListState("loading");
    setClaimableTicketListError("");

    void (async () => {
      let cursor: string | undefined;
      for (let page = 0; page < maxClaimableTicketPages; page += 1) {
        const params = new URLSearchParams({ limit: String(claimableTicketPageSize) });
        if (cursor) params.set("cursor", cursor);
        const response = await authedJson<ClaimableTicketPage<TicketSummary>>(
          `/api/tickets/claimable?${params.toString()}`,
          auth?.getAccessToken,
          controller.signal
        );
        if (!isMounted || controller.signal.aborted || claimScopeRef.current !== requestIdentity) return;

        for (const ticket of response.tickets || []) {
          if (ticket.status === "claimable" && !ticketsById.has(ticket.ticketId)) ticketsById.set(ticket.ticketId, ticket);
        }
        setClaimableTickets([...ticketsById.values()]);

        const nextCursor = response.pageInfo?.nextCursor?.trim() || undefined;
        if (!response.pageInfo?.hasMore) {
          setClaimableTicketListState("ready");
          return;
        }
        if (!nextCursor) {
          setClaimableTicketListState("error");
          setClaimableTicketListError("Claimable tickets could not be fully loaded. Refresh your portfolio to try again.");
          return;
        }
        if (consumedCursors.has(nextCursor)) {
          setClaimableTicketListState("error");
          setClaimableTicketListError("Claimable ticket pagination repeated a page. Refresh your portfolio to try again.");
          return;
        }
        consumedCursors.add(nextCursor);
        cursor = nextCursor;
      }

      if (!controller.signal.aborted && isMounted && claimScopeRef.current === requestIdentity) {
        setClaimableTicketListState("error");
        setClaimableTicketListError("Claimable tickets could not be fully loaded. Refresh your portfolio to try again.");
      }
    })().catch(() => {
      if (!isMounted || controller.signal.aborted || claimScopeRef.current !== requestIdentity) return;
      setClaimableTicketListState("error");
      setClaimableTicketListError("Claimable tickets could not be loaded. Refresh your portfolio to try again.");
    });

    return () => {
      isMounted = false;
      controller.abort();
      if (claimableRequestControllerRef.current === controller) claimableRequestControllerRef.current = null;
    };
  }, [accountRefreshKey, auth?.enabled, auth?.authenticated, auth?.getAccessToken, authIdentity]);

  useEffect(() => {
    const shouldLoadAccount = !auth?.enabled || auth.authenticated;
    if (!shouldLoadAccount) {
      setAccountSummary(null);
      setTickets([]);
      setTicketListState("idle");
      setTicketListError("");
      setPendingPayments([]);
      setPendingPaymentsError("");
      setSelectedTicketId(null);
      setTicketDetail(null);
      setTicketDetailState("idle");
      setWithdrawals([]);
      setAccountError("");
      setAccountState("idle");
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    setAccountState((current) => (current === "ready" ? current : "loading"));
    setTicketListState((current) => (current === "ready" ? current : "loading"));
    setAccountError("");
    setTicketListError("");
    setWithdrawalError("");
    setPendingPaymentsError("");

    void (async () => {
      const [accountResult, ticketResult, withdrawalResult, paymentIntentResult] = await Promise.allSettled([
        authedJson<AccountSummary>("/api/account", auth?.getAccessToken, controller.signal),
        authedJson<{ tickets: TicketSummary[] }>("/api/tickets", auth?.getAccessToken, controller.signal),
        authedJson<{ withdrawals: WithdrawalSummary[] }>("/api/withdrawals", auth?.getAccessToken, controller.signal),
        authedJson<{ paymentIntents: PendingPaymentSummary[] }>("/api/payment-intents", auth?.getAccessToken, controller.signal)
      ]);

      if (!isMounted) return;

      if (accountResult.status === "fulfilled") {
        setAccountSummary(accountResult.value);
        setAccountError("");
        setAccountState("ready");
      } else {
        setAccountSummary(null);
        setAccountError(accountResult.reason instanceof Error ? accountResult.reason.message : "Account summary unavailable.");
        setAccountState("error");
      }

      if (ticketResult.status === "fulfilled") {
        setTickets(ticketResult.value.tickets);
        setTicketListError("");
        setTicketListState("ready");
      } else {
        setTickets([]);
        setTicketListError(ticketResult.reason instanceof Error ? ticketResult.reason.message : "Basket history unavailable.");
        setTicketListState("error");
        setSelectedTicketId(null);
        setTicketDetail(null);
        setTicketDetailState("idle");
      }

      if (paymentIntentResult.status === "fulfilled") {
        setPendingPayments(paymentIntentResult.value.paymentIntents);
        setPendingPaymentsError("");
      } else {
        setPendingPayments([]);
        setPendingPaymentsError("Confirming baskets are unavailable right now.");
      }
      if (withdrawalResult.status === "fulfilled") {
        setWithdrawals(withdrawalResult.value.withdrawals);
        setWithdrawalError("");
      } else {
        setWithdrawals([]);
        setWithdrawalError("Withdrawal history is unavailable right now.");
      }
    })().catch((error: unknown) => {
      if (!isMounted || controller.signal.aborted) return;
      setAccountSummary(null);
      setTickets([]);
      setTicketListState("error");
      setTicketListError("Basket history unavailable.");
      setPendingPayments([]);
      setPendingPaymentsError("");
      setSelectedTicketId(null);
      setTicketDetail(null);
      setTicketDetailState("idle");
      setWithdrawals([]);
      setAccountError(error instanceof Error ? error.message : "Account summary unavailable.");
      setAccountState("error");
    });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [accountRefreshKey, auth?.enabled, auth?.authenticated, auth?.walletSynced, auth?.getAccessToken, authIdentity]);

  useEffect(() => {
    if (ticketListState !== "ready" || selectedTicketId || tickets.length === 0) return;
    setSelectedTicketId(tickets[0].ticketId);
  }, [selectedTicketId, ticketListState, tickets]);

  useEffect(() => {
    const hasOpenTickets = tickets.some((ticket) => ticket.status === "accepted" || ticket.status === "live");
    if (pendingPayments.length === 0 && !hasOpenTickets) return;
    const interval = window.setInterval(() => {
      setAccountRefreshKey((key) => key + 1);
    }, pendingPayments.length > 0 ? 8000 : 15000);
    return () => window.clearInterval(interval);
  }, [pendingPayments.length, tickets]);

  useEffect(() => {
    if (!selectedTicketId) {
      setTicketDetail(null);
      setTicketDetailState("idle");
      setTicketDetailError("");
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    setTicketDetailState("loading");
    setTicketDetailError("");

    authedJson<TicketDetail>(`/api/tickets/${selectedTicketId}`, auth?.getAccessToken, controller.signal)
      .then((detail) => {
        if (!isMounted) return;
        setTicketDetail(detail);
        setTicketDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!isMounted || controller.signal.aborted) return;
        setTicketDetail(null);
        setTicketDetailError(error instanceof Error ? error.message : "Ticket detail unavailable.");
        setTicketDetailState("error");
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [selectedTicketId, ticketDetailRefreshKey, auth?.getAccessToken]);

  const marketRows = useMemo(() => toMarketRows(outcomes), [outcomes]);

  const categories = categoryOrder;

  const selectedByMarket = useMemo(() => {
    const selected = new Map<string, ParlayLeg>();
    for (const leg of legs) selected.set(leg.marketId, leg);
    return selected;
  }, [legs]);

  const selectedByEvent = useMemo(() => {
    const selected = new Map<string, ParlayLeg>();
    for (const leg of legs) selected.set(outcomeEventKey(leg), leg);
    return selected;
  }, [legs]);

  const visibleRows = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();
    const rows = marketRows
      .filter((row) => category === "All" || row.category === category)
      .filter((row) => !isEnded(row.endDate))
      .filter((row) => {
        if (!normalizedQuery) return true;
        return `${row.question} ${row.outcomes.map((outcome) => outcome.outcome).join(" ")} ${row.category}`
          .toLowerCase()
          .includes(normalizedQuery);
      });
    return rows;
  }, [category, debouncedQuery, marketRows]);
  const marketEventSurfaces = useMemo(() => toMarketEventSurfaces(visibleRows), [visibleRows]);
  const hasMarketFilters = query.trim().length > 0 || category !== "All";
  const loadedMarketCount = marketRows.length;
  const marketCountLabel =
    marketTotal !== undefined ? `${loadedMarketCount}/${marketTotal} loaded` : `${loadedMarketCount} loaded`;
  const marketCatalogAge = ageMs(marketCatalog?.asOf);
  const marketCatalogStale = marketCatalogAge !== undefined && marketCatalogAge > marketCatalogStaleAfterMs;
  const marketCatalogPartial = marketCatalog?.complete === false;
  const showMarketCatalogNotice = Boolean(marketCatalog && (marketCatalogPartial || marketCatalogStale || fetchState === "fallback"));
  const marketCatalogNoticeTitle = marketCatalogPartial
    ? "Partial market catalog"
    : marketCatalogStale
      ? "Stale market catalog"
      : "Market catalog notice";
  const marketCatalogNoticeCopy = marketCatalogTrustCopy(marketCatalog, marketCatalogStale, marketCatalogPartial);

  const risk = useMemo(() => assessTicketRisk(legs, amount), [legs, amount]);
  const parlay = useMemo(() => calculateParlay(legs, amount, risk.feeModel), [legs, amount, risk.feeModel]);
  const currentBasketKey = useMemo(() => basketSignature(amount, legs), [amount, legs]);
  const activeServerQuote = serverQuoteBasketKey === currentBasketKey ? serverQuote : null;
  const hasBasketQuote = legs.length >= 2;
  const hasBuyAmount = amount > 0;
  const authoritativeQuote = activeServerQuote?.status === "quoted" ? activeServerQuote : null;
  const walletSyncStatus = auth?.walletSyncStatus || (auth?.walletSynced ? "synced" : "idle");
  const walletSyncFailed = Boolean(auth?.enabled && auth.authenticated && walletSyncStatus === "error");
  const walletSyncLimited = Boolean(auth?.enabled && auth.authenticated && !auth.walletSynced && walletSyncStatus === "limited");
  const walletSyncInProgress = Boolean(auth?.enabled && auth.authenticated && !auth.walletSynced && walletSyncStatus === "syncing");
  const walletReadyForCheckout = !auth?.enabled || (auth.authenticated && walletSyncStatus === "synced");
  const walletBalanceLabel =
    !auth?.enabled
      ? "Wallet disabled"
      : !auth.authenticated
        ? "Connect wallet"
        : auth.walletBalanceState === "loading"
          ? "Loading"
          : auth.walletBalanceState === "error"
            ? "Unavailable"
            : auth.walletUsdcBalance === null || auth.walletUsdcBalance === undefined
              ? "—"
              : `${formatNumber(auth.walletUsdcBalance)} USDC`;
  const basketReadyForCheckout = legs.length >= 2 && amount > 0 && risk.decision !== "reject";
  const canDraft = basketReadyForCheckout && walletReadyForCheckout;
  const canUseCheckoutAction =
    (basketReadyForCheckout && (!auth?.enabled || !auth.authenticated || walletReadyForCheckout)) ||
    (walletSyncFailed && hasBasketQuote && hasBuyAmount);
  const quoteUnavailable = serverQuoteState === "error" && !authoritativeQuote;
  const payoutDisplay = !hasBasketQuote || !hasBuyAmount
    ? "—"
    : quoteUnavailable
      ? "Unavailable"
    : authoritativeQuote
      ? formatUsd(authoritativeQuote.potentialPayoutUsd)
      : risk.decision === "reject"
        ? "Unavailable"
        : formatUsd(parlay.grossPayout);
  const mobilePayoutDisplay =
    legs.length === 0
      ? "Add two markets"
      : legs.length === 1
        ? "Add one more"
        : !hasBuyAmount
          ? "Enter buy amount"
          : quoteUnavailable
            ? "Quote unavailable"
          : `${payoutDisplay} potential`;
  const mobileBasketAction =
    legs.length === 0
      ? "Add 2 picks"
      : legs.length === 1
        ? "Add 1 pick"
        : !hasBuyAmount
          ? "Add amount"
          : risk.decision === "reject"
            ? "Unavailable"
            : auth?.enabled && !auth.authenticated
              ? "Connect"
              : "Review";
  const basketPriceDisplay = hasBasketQuote
    ? quoteUnavailable
      ? "Unavailable"
      : formatCents(authoritativeQuote?.basketPrice ?? parlay.impliedProbability ?? 0)
    : "—";
  const basketProbabilityDisplay = hasBasketQuote
    ? quoteUnavailable
      ? "Unavailable"
      : formatPercent(authoritativeQuote?.basketProbability ?? parlay.impliedProbability ?? 0)
    : "—";
  const quoteSpreadDisplay = hasBasketQuote
    ? quoteUnavailable
      ? "Unavailable"
      : formatPercent(authoritativeQuote?.quoteSpread ?? parlay.houseEdge)
    : "—";
  const payoutMultipleDisplay = hasBasketQuote
    ? quoteUnavailable
      ? "Unavailable"
      : `${formatNumber(authoritativeQuote?.payoutMultiple ?? parlay.offeredDecimalOdds ?? 0)}x`
    : "—";
  const operationFeeDisplay = hasBuyAmount
    ? formatUsd(authoritativeQuote?.operationFeeUsd ?? parlay.operationFee)
    : "—";
  const totalCostDisplay = hasBuyAmount
    ? formatUsd(authoritativeQuote?.totalCostUsd ?? parlay.totalCost)
    : formatUsd(0);
  const quoteValueQualifier =
    hasBasketQuote && hasBuyAmount && !authoritativeQuote && !quoteUnavailable
      ? serverQuoteState === "loading"
        ? " checking"
        : " estimate"
      : "";
  const visibleRiskChecks = useMemo(() => {
    const priority = { block: 0, warn: 1, ok: 2 };
    return [...risk.checks].sort((a, b) => priority[a.level] - priority[b.level]).slice(0, 4);
  }, [risk.checks]);
  useEffect(() => {
    if (!hasBasketQuote || !hasBuyAmount || payoutDisplay === "—" || payoutDisplay === "Unavailable") {
      lastPayoutRef.current = null;
      return;
    }
    if (lastPayoutRef.current === null) {
      lastPayoutRef.current = payoutDisplay;
      setBurstKey((key) => key + 1);
      return;
    }
    if (lastPayoutRef.current !== payoutDisplay) {
      lastPayoutRef.current = payoutDisplay;
      setBurstKey((key) => key + 1);
    }
  }, [hasBasketQuote, hasBuyAmount, payoutDisplay]);
  const checkoutLabel =
    !hasBasketQuote
      ? "Review basket"
      : !hasBuyAmount
      ? "Review basket"
      : auth?.enabled && !auth.authenticated
      ? "Connect wallet"
      : walletSyncFailed
      ? "Disconnect wallet"
      : !walletReadyForCheckout
      ? "Syncing wallet"
      : risk.decision === "reject"
      ? "Basket unavailable"
      : paymentState === "loading"
        ? "Preparing review"
      : paymentState === "sending"
        ? "Sending USDC"
      : paymentState === "activating"
        ? "Activating"
      : serverTicketState === "ready"
          ? "Basket live"
          : serverQuoteState === "loading"
        ? "Checking quote"
        : "Review basket";
  const checkoutBusy =
    serverQuoteState === "loading" ||
    paymentState === "loading" ||
    paymentState === "sending" ||
    paymentState === "activating" ||
    serverTicketState === "ready";

  useEffect(() => {
    setServerQuote(null);
    setServerQuoteBasketKey("");
    setServerQuoteState("idle");
    setServerQuoteError("");
    setServerTicket(null);
    setServerTicketState("idle");
    setServerTicketError("");
    setPaymentIntent(null);
    setPaymentState("idle");
    setPaymentError("");
    setPaymentTxHash("");
    paymentModalOpenRef.current = false;
    setPaymentModalOpen(false);
  }, [amount, legs]);

  useEffect(() => {
    if (stakeLimitKey === 0) return;
    setStakeLimitActive(true);
    const timeout = window.setTimeout(() => setStakeLimitActive(false), 1400);
    return () => window.clearTimeout(timeout);
  }, [stakeLimitKey]);

  useEffect(() => {
    if (!selectionNotice) return;
    const timeout = window.setTimeout(() => setSelectionNotice(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [selectionNotice]);

  function chooseOutcome(outcome: MarketOutcome) {
    const outcomeKey = outcomeEventKey(outcome);
    const replaced = legs.find((leg) => outcomeEventKey(leg) === outcomeKey && leg.id !== outcome.id);
    const existing = legs.find((leg) => leg.id === outcome.id);
    const withoutEvent = legs.filter((leg) => outcomeEventKey(leg) !== outcomeKey);

    if (existing) {
      setLegs(withoutEvent);
      setSelectionNotice(`Removed ${outcome.outcome} from ${outcome.eventTitle || outcome.question}.`);
      return;
    }

    setLegs([...withoutEvent, { ...outcome, addedAt: Date.now() }]);
    setSelectionNotice(
      replaced
        ? `Replaced ${replaced.question} (${replaced.outcome}) with ${outcome.question} (${outcome.outcome}).`
        : `Selected ${outcome.outcome} for ${outcome.eventTitle || outcome.question}.`
    );
    window.setTimeout(() => {
      setExpandedEvents((current) => {
        if (!current.has(outcomeKey)) return current;
        const next = new Set(current);
        next.delete(outcomeKey);
        return next;
      });
    }, 0);
  }

  function removeLeg(id: string) {
    setLegs((current) => current.filter((leg) => leg.id !== id));
  }

  function triggerStakeLimit() {
    setStakeLimitKey((key) => key + 1);
  }

  function setStakeAmount(nextAmount: number) {
    if (nextAmount > stakeCapUsd) {
      triggerStakeLimit();
    }
    const normalized = Math.min(stakeCapUsd, Math.max(0, Math.round(nextAmount * 100) / 100));
    setAmount(normalized);
    setAmountInput(normalized > 0 ? String(normalized) : "");
  }

  function handleAmountInput(nextInput: string) {
    setAmountInput(nextInput);
    if (nextInput.trim() === "") {
      setAmount(0);
      return;
    }

    const parsed = Number(nextInput);
    if (Number.isFinite(parsed)) {
      if (parsed > stakeCapUsd) {
        triggerStakeLimit();
        setStakeAmount(stakeCapUsd);
        return;
      }
      setAmount(Math.min(stakeCapUsd, Math.max(0, parsed)));
    }
  }

  function commitAmountInput() {
    if (amountInput.trim() === "") {
      setStakeAmount(0);
      return;
    }

    const parsed = Number(amountInput);
    setStakeAmount(Number.isFinite(parsed) ? parsed : 0);
  }

  async function requestServerQuote(requestBasketKey = currentBasketKey): Promise<{ quote: ServerQuote | null; error?: string }> {
    if (!canDraft || serverQuoteState === "loading") {
      return { quote: null, error: serverQuoteState === "loading" ? "Quote check is already running." : "This basket is not ready to quote." };
    }

    setServerQuoteState("loading");
    setServerQuoteError("");

    try {
      const token = auth?.getAccessToken ? await auth.getAccessToken() : null;
      if (auth?.enabled && !token) {
        throw new Error("Wallet session expired. Reconnect your wallet and try again.");
      }

      const response = await fetch("/api/quotes", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "idempotency-key": `quote-${window.crypto.randomUUID()}`
        },
        body: JSON.stringify({
          stakeUsd: amount,
          legs: legs.map((leg) => ({ id: leg.id }))
        })
      });
      const payload = (await response.json()) as ServerQuote | { detail?: string; error?: string };

      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, "Quote service unavailable."));
      }
      if (!("status" in payload) || payload.status !== "quoted") {
        throw new Error("This basket is not available at the current quote.");
      }

      setServerQuote(payload as ServerQuote);
      setServerQuoteBasketKey(requestBasketKey);
      setServerQuoteState("ready");
      return { quote: payload as ServerQuote };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Quote service unavailable.";
      setServerQuote(null);
      setServerQuoteError(message);
      setServerQuoteState("error");
      return { quote: null, error: message };
    }
  }

  async function preparePaymentReview() {
    if (!canDraft || paymentState === "loading") return;

    paymentModalOpenRef.current = true;
    setPaymentModalOpen(true);
    setPaymentState("loading");
    setPaymentError("");

    const hasPaymentInFlight = Boolean(paymentIntent && (paymentIntent.txHash || paymentState === "pending"));
    const reusableQuote = hasPaymentInFlight && activeServerQuote?.status === "quoted" ? activeServerQuote : null;
    if (!reusableQuote) {
      setServerQuote(null);
      setServerQuoteBasketKey("");
      setPaymentIntent(null);
      setPaymentTxHash("");
    }

    const quoteResult = reusableQuote ? { quote: reusableQuote } : await requestServerQuote(currentBasketKey);
    const quote = quoteResult.quote;
    if (!quote) {
      setPaymentState("error");
      setPaymentError(quoteResult.error || "LEGWORK could not prepare a quote for this basket.");
      return;
    }

    try {
      const intent = await authedPostJson<ServerPaymentIntent>(`/api/quotes/${quote.id}/payment-intent`, auth?.getAccessToken);
      setPaymentIntent(intent);
      setPaymentTxHash(intent.txHash || "");
      if (intent.status === "recoverable") {
        setPaymentState("recoverable");
        setPaymentError(recoverablePaymentMessage());
      } else {
        setPaymentState(intent.status === "confirmed" || intent.status === "activated" ? "pending" : "ready");
      }
    } catch (error) {
      setPaymentIntent(null);
      setPaymentState("error");
      setPaymentError(error instanceof Error ? error.message : "LEGWORK could not prepare USDC payment.");
    }
  }

  async function activatePaidQuote(quoteId = activeServerQuote?.id) {
    if (!quoteId) return;
    setPaymentState("activating");
    setPaymentError("");
    try {
      const payload = await authedPostJson<ServerTicket | { status: "payment_pending"; paymentIntent?: ServerPaymentIntent; detail?: string } | RecoverablePaymentResponse>(
        `/api/quotes/${quoteId}/payment-activate`,
        auth?.getAccessToken
      );
      if ("ticketId" in payload) {
        setServerTicket(payload);
        setServerTicketState("ready");
        setPaymentState("complete");
        setBurstKey((key) => key + 1);
        setSelectedTicketId(payload.ticketId);
        setAccountRefreshKey((key) => key + 1);
        navigateToView("portfolio");
        return;
      }
      if (isRecoverablePaymentResponse(payload)) {
        if (payload.paymentIntent) setPaymentIntent(payload.paymentIntent);
        setPaymentState("recoverable");
        setPaymentError(recoverablePaymentMessage());
        setAccountRefreshKey((key) => key + 1);
        return;
      }
      if (payload.paymentIntent) setPaymentIntent(payload.paymentIntent);
      setPaymentState("pending");
      setPaymentError(payload.detail || "Waiting for confirmed USDC payment.");
      setAccountRefreshKey((key) => key + 1);
    } catch (error) {
      if (error instanceof ApiRequestError && isRecoverablePaymentResponse(error.payload)) {
        if (error.payload.paymentIntent) setPaymentIntent(error.payload.paymentIntent);
        setPaymentState("recoverable");
        setPaymentError(recoverablePaymentMessage());
        setAccountRefreshKey((key) => key + 1);
        return;
      }
      setServerTicket(null);
      setServerTicketState("error");
      setServerTicketError(error instanceof Error ? error.message : "Ticket activation unavailable.");
      setPaymentState("error");
      setPaymentError(error instanceof Error ? error.message : "Ticket activation unavailable.");
    }
  }

  async function sendPayment() {
    if (!paymentIntent || paymentState === "sending" || paymentState === "activating") return;
    if (auth?.enabled && !auth.authenticated) {
      auth.login?.();
      return;
    }
    if (!auth?.sendUsdcPayment) {
      setPaymentState("error");
      setPaymentError("Connected wallet payment is unavailable. Reconnect your wallet and try again.");
      return;
    }
    if (!walletReadyForCheckout || !auth.getAccessToken) {
      setPaymentState("error");
      setPaymentError("Your wallet session is no longer verified. Reconnect your wallet before sending USDC.");
      return;
    }

    setPaymentState("sending");
    setPaymentError("");
    let submittedTxHash = "";
    try {
      // Refresh authentication immediately before the irreversible wallet action.
      const accessToken = await auth.getAccessToken();
      if (!accessToken) {
        throw new Error("Your wallet session expired before payment. Reconnect your wallet and try again.");
      }
      if (paymentIntent.status === "expired" || new Date(paymentIntent.expiresAt).getTime() <= Date.now()) {
        setPaymentState("error");
        setPaymentError("This payment quote expired. Refresh the quote before sending USDC.");
        return;
      }
      const txHash = await auth.sendUsdcPayment({
        treasuryAddress: paymentIntent.treasuryAddress,
        usdcContractAddress: paymentIntent.usdcContractAddress,
        amountMicroUnits: paymentIntent.amountMicroUnits,
        chainId: paymentIntent.chainId
      });
      submittedTxHash = txHash;
      setPaymentTxHash(txHash);
      const submitted = await authedPostJson<ServerPaymentIntent>(
        `/api/quotes/${paymentIntent.quoteId}/payment-transaction`,
        async () => accessToken,
        { txHash }
      );
      setPaymentIntent(submitted);
      setPaymentState("pending");
      setAccountRefreshKey((key) => key + 1);
      await activatePaidQuote(submitted.quoteId);
    } catch (error) {
      if (error instanceof ApiRequestError && isRecoverablePaymentResponse(error.payload)) {
        if (error.payload.paymentIntent) setPaymentIntent(error.payload.paymentIntent);
        setPaymentState("recoverable");
        setPaymentError(recoverablePaymentMessage());
        setAccountRefreshKey((key) => key + 1);
        return;
      }
      setPaymentState("error");
      setPaymentError(
        submittedTxHash
          ? "Transfer sent, but LEGWORK could not finish activation. Continue activation to save the transfer and check confirmation."
          : error instanceof Error
            ? error.message
            : "USDC payment failed before submission."
      );
    }
  }

  async function continuePaymentActivation() {
    if (!paymentIntent) return;
    const txHash = paymentTxHash || paymentIntent.txHash;
    if (!txHash) return;

    setPaymentState("activating");
    setPaymentError("");
    try {
      const submitted =
        paymentIntent.txHash === txHash && paymentIntent.status !== "pending"
          ? paymentIntent
          : await authedPostJson<ServerPaymentIntent>(
              `/api/quotes/${paymentIntent.quoteId}/payment-transaction`,
              auth?.getAccessToken,
              { txHash }
            );
      setPaymentIntent(submitted);
      setPaymentTxHash(submitted.txHash || txHash);
      setPaymentState("pending");
      setAccountRefreshKey((key) => key + 1);
      await activatePaidQuote(submitted.quoteId);
    } catch (error) {
      if (error instanceof ApiRequestError && isRecoverablePaymentResponse(error.payload)) {
        if (error.payload.paymentIntent) setPaymentIntent(error.payload.paymentIntent);
        setPaymentState("recoverable");
        setPaymentError(recoverablePaymentMessage());
        setAccountRefreshKey((key) => key + 1);
        return;
      }
      setPaymentState("error");
      setPaymentError(error instanceof Error ? error.message : "LEGWORK could not continue activation.");
    }
  }

  function handleCheckout() {
    if (auth?.enabled && !auth.authenticated) {
      setMobileBasketOpen(false);
      auth.login?.();
      return;
    }
    if (walletSyncFailed) {
      auth?.logout?.();
      return;
    }

    paymentModalReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void preparePaymentReview();
  }

  function refreshPaymentQuote() {
    setPaymentIntent(null);
    setPaymentTxHash("");
    setPaymentError("");
    setPaymentState("idle");
    void preparePaymentReview();
  }

  function openPortfolioFromPayment() {
    closePaymentReview();
    navigateToView("portfolio");
    setAccountRefreshKey((key) => key + 1);
  }

  const activeTickets = tickets.filter((ticket) => ticket.status === "accepted" || ticket.status === "live");
  const confirmingPayments = pendingPayments.filter((payment) => payment.status === "submitted" || payment.status === "confirmed");
  const recoverablePayments = pendingPayments.filter((payment) => payment.status === "recoverable");
  const activeBasketCount = activeTickets.length + confirmingPayments.length;
  const allBasketCount = tickets.length + confirmingPayments.length;
  const availableBalance = balanceFor(accountSummary, ["user_usdc_available"], "USDC");
  const availableBalanceMicroUnits = availableUsdcMicroUnits(availableBalance);
  const withdrawalDestination = auth?.walletAddress?.trim() || "";
  const withdrawalAmountMicroUnits = parseUsdcMicroUnits(withdrawalAmountInput);
  const withdrawalAmountError = useMemo(() => {
    if (!withdrawalDestination) return "Connect and verify a wallet before requesting a withdrawal.";
    if (accountState === "loading" || accountState === "idle") return "Available LEGWORK balance is loading.";
    if (accountState === "error" || !accountSummary) return "Available LEGWORK balance is unavailable.";
    if (!withdrawalAmountInput) return "Enter an amount to withdraw.";
    if (withdrawalAmountMicroUnits === null) return "Use up to six decimal places.";
    if (withdrawalAmountMicroUnits <= 0n) return "Enter an amount greater than zero.";
    if (withdrawalAmountMicroUnits > availableBalanceMicroUnits) return "Amount exceeds your available LEGWORK balance.";
    return "";
  }, [accountState, accountSummary, availableBalanceMicroUnits, withdrawalAmountInput, withdrawalAmountMicroUnits, withdrawalDestination]);
  const canSubmitWithdrawal = !withdrawalAmountError && withdrawalRequestState !== "submitting";
  const walletDisplayBalance = auth?.walletBalanceState === "ready" ? auth.walletUsdcBalance : undefined;
  const walletBalanceMetric =
    auth?.enabled && !auth.authenticated
      ? "Connect wallet"
      : auth?.walletBalanceState === "loading"
        ? "Loading"
        : auth?.walletBalanceState === "error"
          ? "Unavailable"
          : walletDisplayBalance === undefined || walletDisplayBalance === null
            ? "—"
            : formatUsd(walletDisplayBalance);
  const claimableBalance = balanceFor(accountSummary, ["user_usdc_claimable", "claimable_usdc"], "USDC");
  const accountSummaryLoading = accountState === "loading" || accountState === "idle";
  const accountSummaryUnavailable = accountState === "error" || !accountSummary;
  const accountMetric = (value: number) =>
    accountSummaryLoading ? "Loading" : accountSummaryUnavailable ? "Unavailable" : formatUsd(value);
  const openTicketsValue = accountSummary?.openTickets ?? 0;
  const openNetLiabilityValue = accountSummary?.openNetLiabilityUsd ?? 0;
  const openTicketsCopy = accountSummaryLoading
    ? "Loading active basket count."
    : accountSummaryUnavailable
      ? "Active basket count unavailable."
      : `${openTicketsValue} active basket${openTicketsValue === 1 ? "" : "s"}.`;
  const openLiabilityCopy = accountSummaryLoading
    ? "Loading open liability."
    : accountSummaryUnavailable
      ? "Open liability unavailable."
      : `${formatUsd(openNetLiabilityValue)} still open across active baskets.`;

  function renderAccountPrompt() {
    if (auth?.enabled && !auth.authenticated) {
      return (
        <div className="account-empty-state">
          <WalletCardIcon />
          <strong>Connect wallet to see your account</strong>
          <span>Your portfolio will show active baskets, claimable payouts, and withdrawals once your wallet is connected.</span>
          <button className="primary-inline-btn" disabled={!auth.ready} onClick={auth.login} type="button">
            Connect wallet
          </button>
        </div>
      );
    }

    if (auth?.enabled && auth.authenticated && walletSyncFailed) {
      return (
        <div className="account-empty-state">
          <Clock3 size={28} />
          <strong>Session needs attention</strong>
          <span>
            {auth.walletSyncError || "LEGWORK could not verify this session. Reconnect your wallet to continue."}
          </span>
          <button className="primary-inline-btn" onClick={auth.logout} type="button">
            Disconnect wallet
          </button>
        </div>
      );
    }

    return null;
  }

  function renderPaymentModal() {
    if (!paymentModalOpen) return null;
    const amountDue = paymentIntent ? formatUsd(paymentIntent.amountUsdc) : totalCostDisplay;
    const txHash = paymentTxHash || paymentIntent?.txHash || "";
    const explorerUrl = txHash ? txExplorerUrl(txHash, paymentIntent?.chainId) : "";
    const paymentNetwork = chainLabel(paymentIntent?.chainId || configuredSettlementChainId());
    const quotedPayout = authoritativeQuote?.potentialPayoutUsd ?? parlay.grossPayout;
    const quotedTotal = authoritativeQuote?.totalCostUsd ?? parlay.totalCost;
    const netProfit = Math.max(0, quotedPayout - quotedTotal);
    const profitReturn = quotedTotal > 0 ? netProfit / quotedTotal : 0;
    const quoteAdjusted = Boolean(
      authoritativeQuote && Math.abs(authoritativeQuote.potentialPayoutUsd - parlay.grossPayout) >= 0.01
    );
    const paymentLegs = authoritativeQuote?.legs?.length ? authoritativeQuote.legs : legs;
    const paymentBusy = paymentState === "loading" || paymentState === "sending" || paymentState === "activating";
    const paymentRecoverable = paymentState === "recoverable";
    const paymentComplete = paymentState === "complete";
    const reviewUnavailable = paymentState === "error" && !paymentIntent && !txHash;
    const paymentIntentExpired = Boolean(
      paymentIntent &&
        (paymentIntent.status === "expired" || new Date(paymentIntent.expiresAt).getTime() <= paymentClockNow)
    );
    const canSend = Boolean(
      paymentIntent &&
        walletReadyForCheckout &&
        auth?.sendUsdcPayment &&
        !txHash &&
        paymentState !== "loading" &&
        paymentState !== "sending" &&
        paymentState !== "activating" &&
        paymentState !== "pending" &&
        !paymentRecoverable &&
        !paymentIntentExpired &&
        paymentState !== "complete"
    );
    const canContinueActivation = Boolean(paymentIntent && txHash && paymentState === "error" && !paymentRecoverable);

    return (
      <div className="payment-modal-backdrop" role="presentation">
        <section
          className="payment-modal"
          ref={paymentModalDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-modal-title"
          tabIndex={-1}
        >
          <div className="payment-modal-header">
            <div>
              <span className="section-label">
                {paymentComplete ? <Trophy size={16} /> : <ReceiptText size={16} />}
                {paymentComplete ? "Basket confirmed" : "Review ticket"}
              </span>
              <h2 id="payment-modal-title">{paymentComplete ? "Your basket is live" : "Buy this basket"}</h2>
            </div>
            <button
              className="icon-btn quiet"
              ref={paymentModalCloseRef}
              disabled={!paymentReviewCanClose}
              onClick={closePaymentReview}
              type="button"
              aria-label="Close payment review"
            >
              <X size={18} />
            </button>
          </div>

          <div className="payment-hero">
            <span>{paymentComplete ? "Confirmed potential payout" : `Total due${quoteValueQualifier}`}</span>
            {paymentComplete ? (
              <AnimatedPayout value={payoutDisplay} burstKey={burstKey} compact />
            ) : (
              <strong>{reviewUnavailable ? "Unavailable" : amountDue}</strong>
            )}
            <small>
              {paymentComplete
                ? `Your ${paymentLegs.length}-pick basket is now tracking every result.`
                : `Stake plus operation fees, paid in USDC on ${paymentNetwork}.`}
            </small>
            {authoritativeQuote ? (
              <small className="payment-quote-update">
                {quoteAdjusted ? "Quote updated with current market prices." : "Live quote confirmed."}
              </small>
            ) : null}
          </div>

          <div className="payment-leg-list">
            {paymentLegs.map((leg) => (
              <div className="payment-leg" key={leg.id}>
                <span>{leg.outcome} · {formatCents(leg.price)}</span>
                <strong>{leg.question}</strong>
                <small>Closes {contractCloseDateTime(leg.endDate)}</small>
                {leg.marketUrl ? (
                  <a href={leg.marketUrl} target="_blank" rel="noreferrer">
                    View market rules <ExternalLink size={12} />
                  </a>
                ) : null}
              </div>
            ))}
          </div>

          <div className="payment-grid">
            <div>
              <span>Potential payout{quoteValueQualifier}</span>
              <AnimatedPayout value={reviewUnavailable ? "Unavailable" : payoutDisplay} burstKey={burstKey} compact />
            </div>
            <div>
              <span>Basket price{quoteValueQualifier}</span>
              <strong>{reviewUnavailable ? "Unavailable" : basketPriceDisplay}</strong>
            </div>
            <div>
              <span>Quote spread{quoteValueQualifier}</span>
              <strong>{reviewUnavailable ? "Unavailable" : quoteSpreadDisplay}</strong>
            </div>
            <div>
              <span>Payout multiple{quoteValueQualifier}</span>
              <strong>{reviewUnavailable ? "Unavailable" : payoutMultipleDisplay}</strong>
            </div>
            <div>
              <span>Operation fee{quoteValueQualifier}</span>
              <strong>{reviewUnavailable ? "—" : operationFeeDisplay}</strong>
            </div>
            <div>
              <span>Profit return{quoteValueQualifier}</span>
              <strong>{reviewUnavailable ? "—" : `+${formatPercent(profitReturn)}`}</strong>
            </div>
          </div>

          {paymentIntent ? (
            <>
              <div className={paymentIntentExpired ? "payment-expiry expired" : "payment-expiry"} role="status">
                <Clock3 size={15} />
                <strong>
                  {paymentIntentExpired ? "Quote expired" : `Send within ${expiryCountdown(paymentIntent.expiresAt, paymentClockNow)}`}
                </strong>
              </div>
              <details className="payment-technical">
                <summary>Transaction details</summary>
                <div className="payment-addresses">
                  <div>
                    <span>Network</span>
                    <strong>{paymentNetwork}</strong>
                  </div>
                  <div>
                    <span>Treasury</span>
                    <strong>{compactId(paymentIntent.treasuryAddress)}</strong>
                  </div>
                  <div>
                    <span>USDC contract</span>
                    <strong>{compactId(paymentIntent.usdcContractAddress)}</strong>
                  </div>
                  <div>
                    <span>Expires</span>
                    <strong>{shortDateTime(paymentIntent.expiresAt)}</strong>
                  </div>
                </div>
                {txHash ? (
                  <a className="payment-tx-link" href={explorerUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={15} />
                    View transfer {compactId(txHash)}
                  </a>
                ) : null}
              </details>
            </>
          ) : null}

          {paymentState === "pending" ? (
            <div className="payment-note pending">
              <span>{paymentError || "Waiting for the confirmed USDC transfer before activating this basket."}</span>
              <i className="payment-spinner" aria-hidden="true" />
            </div>
          ) : paymentError ? (
            <div className="payment-error" role="alert">{paymentError}</div>
          ) : null}

          <div className="payment-actions">
            {paymentIntentExpired && !txHash ? (
              <button className="checkout-btn" onClick={refreshPaymentQuote} type="button">
                <RefreshCw size={18} />
                Refresh quote
              </button>
            ) : reviewUnavailable ? (
              <button className="checkout-btn" onClick={refreshPaymentQuote} type="button">
                <RefreshCw size={18} />
                Retry quote
              </button>
            ) : paymentState === "pending" || paymentRecoverable ? (
              <button className="checkout-btn" onClick={openPortfolioFromPayment} type="button">
                <LayoutDashboard size={18} />
                View Portfolio
              </button>
            ) : paymentState === "complete" ? (
              <button className="checkout-btn" onClick={openPortfolioFromPayment} type="button">
                <LayoutDashboard size={18} />
                View live basket
              </button>
            ) : canContinueActivation ? (
              <button className="checkout-btn" onClick={continuePaymentActivation} type="button">
                <Clock3 size={18} />
                Continue activation
              </button>
            ) : (
              <button className="checkout-btn" disabled={!canSend || paymentBusy} onClick={sendPayment} type="button">
                <Banknote size={18} />
                {paymentState === "loading"
                  ? "Preparing"
                  : paymentState === "sending"
                    ? "Confirm in wallet"
                    : paymentState === "activating"
                      ? "Activating"
                      : "Send USDC"}
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  async function claimTicketWinnings(ticketId: string) {
    if (claimInFlightRef.current.has(ticketId) || claimingTicketId) return;
    const requestIdentity = authIdentity;
    const idempotencyKey = claimAttemptKeysRef.current.get(ticketId) || `ticket-claim-${crypto.randomUUID()}`;
    claimAttemptKeysRef.current.set(ticketId, idempotencyKey);
    claimInFlightRef.current.add(ticketId);
    claimRequestControllerRef.current?.abort();
    const controller = new AbortController();
    claimRequestControllerRef.current = controller;
    setClaimingTicketId(ticketId);
    setClaimNotice("");
    setClaimError("");

    try {
      const result = await authedPostJson<TicketClaimResult>(
        `/api/tickets/${ticketId}/claim`,
        auth?.getAccessToken,
        undefined,
        { "idempotency-key": idempotencyKey },
        controller.signal
      );
      if (controller.signal.aborted || claimScopeRef.current !== requestIdentity) return;
      const claimedUsd = Number(BigInt(result.amountMicroUnits)) / 1_000_000;
      setClaimNotice(`${formatUsd(claimedUsd)} moved to your available LEGWORK balance.`);
      claimAttemptKeysRef.current.delete(ticketId);
      setAccountRefreshKey((key) => key + 1);
      if (selectedTicketId === ticketId) setTicketDetailRefreshKey((key) => key + 1);
    } catch (error: unknown) {
      if (!controller.signal.aborted && claimScopeRef.current === requestIdentity) {
        setClaimError(claimErrorMessage(error));
        if (claimErrorNeedsRefresh(error)) {
          setAccountRefreshKey((key) => key + 1);
          if (selectedTicketId === ticketId) setTicketDetailRefreshKey((key) => key + 1);
        }
      }
    } finally {
      claimInFlightRef.current.delete(ticketId);
      if (!controller.signal.aborted && claimScopeRef.current === requestIdentity) setClaimingTicketId(null);
      if (claimRequestControllerRef.current === controller) claimRequestControllerRef.current = null;
    }
  }

  function updateWithdrawalAmount(value: string) {
    if (value !== withdrawalAmountInput) withdrawalAttemptRef.current = null;
    setWithdrawalAmountInput(value);
    if (withdrawalRequestState !== "idle") {
      setWithdrawalRequestState("idle");
      setWithdrawalRequestMessage("");
    }
  }

  async function requestWithdrawal() {
    if (!canSubmitWithdrawal || withdrawalAmountMicroUnits === null || !withdrawalDestination) return;

    const requestIdentity = authIdentity;
    const signature = `${withdrawalDestination.toLowerCase()}:${withdrawalAmountMicroUnits.toString()}`;
    const existingAttempt = withdrawalAttemptRef.current;
    const idempotencyKey =
      existingAttempt?.signature === signature ? existingAttempt.key : `withdrawal-${crypto.randomUUID()}`;
    withdrawalAttemptRef.current = { key: idempotencyKey, signature };
    setWithdrawalRequestState("submitting");
    setWithdrawalRequestMessage("Submitting withdrawal request to treasury.");

    try {
      await authedPostJson<{ id: string; status: string }>(
        "/api/withdrawals",
        auth?.getAccessToken,
        {
          amountUsdc: formatUsdcMicroUnits(withdrawalAmountMicroUnits),
          destinationAddress: withdrawalDestination
        },
        { "idempotency-key": idempotencyKey }
      );
      if (claimScopeRef.current !== requestIdentity) return;
      withdrawalAttemptRef.current = null;
      setWithdrawalAmountInput("");
      setWithdrawalRequestState("success");
      setWithdrawalRequestMessage("Withdrawal request received. Treasury processing is pending; funds have not been sent yet.");
      setAccountRefreshKey((key) => key + 1);
    } catch (error: unknown) {
      if (claimScopeRef.current !== requestIdentity) return;
      setWithdrawalRequestState("error");
      setWithdrawalRequestMessage(withdrawalRequestErrorMessage(error));
    }
  }

  async function cancelRequestedWithdrawal(withdrawalId: string) {
    if (cancelingWithdrawalId) return;
    const requestIdentity = authIdentity;
    setCancelingWithdrawalId(withdrawalId);
    setWithdrawalError("");

    try {
      await authedPostJson<{ id: string; status: "canceled" }>(
        `/api/withdrawals/${encodeURIComponent(withdrawalId)}/cancel`,
        auth?.getAccessToken,
        {}
      );
      if (claimScopeRef.current !== requestIdentity) return;
      setAccountRefreshKey((key) => key + 1);
    } catch (error) {
      if (claimScopeRef.current === requestIdentity) {
        setWithdrawalError(apiErrorMessage(error instanceof ApiRequestError ? error.payload : undefined, "Withdrawal could not be canceled."));
      }
    } finally {
      if (claimScopeRef.current === requestIdentity) setCancelingWithdrawalId(null);
    }
  }

  function renderTicketDetailPanel() {
    const selectedSummary = tickets.find((ticket) => ticket.ticketId === selectedTicketId);
    const detailStatus = ticketDetail?.status || selectedSummary?.status;
    const allVoided = ticketDetail ? isAllVoidedTicket(ticketDetail) : selectedSummary ? isAllVoidedTicket(selectedSummary) : false;
    const settlementReviewRequired = Boolean(
      ticketDetail?.settlementPolicyReviewRequired || selectedSummary?.settlementPolicyReviewRequired
    );
    const hasFinalPayout = !settlementReviewRequired && (detailStatus === "claimable" || detailStatus === "paid");

    return (
      <section className="account-panel ticket-detail-panel" ref={ticketDetailPanelRef}>
        <div className="panel-title-row">
          <div>
            <span className="section-label">
              <ReceiptText size={16} />
              Ticket detail
            </span>
            <h2>{selectedSummary ? compactId(selectedSummary.ticketId) : "Select a basket"}</h2>
          </div>
          {detailStatus ? (
            <em className={`status-pill ${statusTone(settlementReviewRequired ? "disputed" : allVoided ? "voided" : detailStatus)}`}>
              {settlementReviewRequired ? "Settlement review" : allVoided ? "Stake returned" : statusLabel(detailStatus)}
            </em>
          ) : null}
        </div>

        {ticketListState === "error" ? (
          renderTicketListUnavailable()
        ) : !selectedSummary ? (
          <div className="panel-empty">
            <ReceiptText size={22} />
            <span>Select a basket to inspect every leg and settlement state.</span>
          </div>
        ) : ticketDetailState === "loading" ? (
          <AccountSkeleton rows={4} />
        ) : ticketDetailState === "error" ? (
          <div className="panel-empty">
            <Clock3 size={22} />
            <strong>Ticket detail unavailable</strong>
            <span>{ticketDetailError}</span>
            <button onClick={() => setTicketDetailRefreshKey((key) => key + 1)} type="button">Retry</button>
          </div>
        ) : ticketDetail ? (
          <>
            <div className="ticket-detail-metrics">
              <div>
                <span>Paid</span>
                <strong>{formatUsd(ticketDetail.amountPaidUsd)}</strong>
              </div>
              <div>
                <span>{settlementReviewRequired ? "Quoted payout" : allVoided ? "Stake returned" : hasFinalPayout ? "Final payout" : "Potential payout"}</span>
                <strong>{formatUsd(
                  settlementReviewRequired
                      ? ticketDetail.potentialPayoutUsd
                      : allVoided
                      ? ticketDetail.stakeUsd
                      : hasFinalPayout
                      ? ticketDetail.claimableAmountUsd ?? 0
                      : ticketDetail.potentialPayoutUsd
                )}</strong>
              </div>
              <div>
                <span>Stake</span>
                <strong>{formatUsd(ticketDetail.stakeUsd)}</strong>
              </div>
              <div>
                <span>Operation fee</span>
                <strong>{formatUsd(ticketDetail.operationFeeUsd)}</strong>
              </div>
            </div>
            {allVoided ? (
              <div className="scoped-success" role="status">
                Stake returned automatically to your available LEGWORK balance. The operation fee was retained.
              </div>
            ) : null}
            {settlementReviewRequired ? (
              <div className="scoped-warning" role="status">
                This legacy ticket used an older void policy. Its payout is unavailable while the settlement record is reconciled.
              </div>
            ) : null}
            {ticketDetail.status === "claimable" && !settlementReviewRequired ? (
              <div className="claim-action">
                <div>
                  <span>Payout ready</span>
                  <strong>{formatUsd(ticketDetail.claimableAmountUsd || 0)}</strong>
                </div>
                <button
                  disabled={claimingTicketId !== null}
                  onClick={() => void claimTicketWinnings(ticketDetail.ticketId)}
                  type="button"
                >
                  <Trophy size={17} />
                  {claimingTicketId === ticketDetail.ticketId ? "Claiming" : "Claim payout"}
                </button>
              </div>
            ) : null}
            <div className="ticket-progress-line">
              <strong>{legProgressText(ticketDetail) || `${ticketDetail.legs.length} active`}</strong>
              <span>Opened {shortDateTime(ticketDetail.createdAt)} · {ticketDetail.currency}</span>
              {ticketDetail.purchaseTxHash ? (
                <a
                  className="ticket-chain-link"
                  href={txExplorerUrl(ticketDetail.purchaseTxHash, ticketDetail.purchaseChainId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Transaction log {compactId(ticketDetail.purchaseTxHash)}
                  <ExternalLink size={12} />
                </a>
              ) : null}
            </div>
            <div className="ticket-leg-stack">
              {ticketDetail.legs.map((leg) => (
                <div className="ticket-leg-detail" key={leg.ticketLegId}>
                  <div>
                    <span>{leg.outcome}</span>
                    <strong>{leg.question}</strong>
                    <small>{settlementSummaryText(leg, ticketDetail.status)}</small>
                    <details className="settlement-diagnostics">
                      <summary>Settlement details</summary>
                      <small>{settlementDetailText(leg)}</small>
                    </details>
                    {leg.marketUrl ? (
                      <a href={leg.marketUrl} target="_blank" rel="noreferrer">
                        Open market <ExternalLink size={12} />
                      </a>
                    ) : null}
                  </div>
                  <em className={`status-pill ${statusTone(leg.resolutionState || leg.status)}`}>
                    {legStatusLabel(leg.status, leg.resolutionState, leg.endDate, ticketDetail.status)}
                  </em>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="panel-empty">
            <Clock3 size={22} />
            <span>Choose a basket to load its legs.</span>
          </div>
        )}
      </section>
    );
  }

  function renderPendingPaymentRow(payment: PendingPaymentSummary) {
    const progressText = payment.status === "confirmed" ? "activating ticket" : "waiting for USDC confirmation";
    return (
      <div className="account-row confirming" key={payment.id}>
        <div className="topbar-brand">
          <strong>{formatUsd(payment.potentialPayoutUsd)} potential</strong>
          <span>
            {payment.legs} leg{payment.legs === 1 ? "" : "s"} · paid {formatUsd(payment.amountPaidUsd)} · {progressText}
          </span>
          {payment.txHash ? (
            <a className="compact-tx-link" href={txExplorerUrl(payment.txHash, payment.chainId)} target="_blank" rel="noreferrer">
              Transaction {compactId(payment.txHash)} <ExternalLink size={12} />
            </a>
          ) : null}
        </div>
        <em className="status-pill confirming">Confirming</em>
      </div>
    );
  }

  function renderRecoverablePaymentRow(payment: PendingPaymentSummary) {
    return (
      <div className="account-row" key={payment.id}>
        <div>
          <strong>{formatUsd(payment.amountPaidUsd)} released</strong>
          <span>{payment.legs} leg{payment.legs === 1 ? "" : "s"} · USDC returned to LEGWORK balance</span>
          {payment.txHash ? (
            <a className="compact-tx-link" href={txExplorerUrl(payment.txHash, payment.chainId)} target="_blank" rel="noreferrer">
              Transaction {compactId(payment.txHash)} <ExternalLink size={12} />
            </a>
          ) : null}
        </div>
        <em className="status-pill paid">Returned</em>
      </div>
    );
  }

  function renderTicketListUnavailable() {
    return (
      <div className="panel-empty">
        <Clock3 size={22} />
        <strong>Basket history unavailable</strong>
        <span>{ticketListError || "LEGWORK could not load basket history."}</span>
        <button onClick={() => setAccountRefreshKey((key) => key + 1)} type="button">Retry</button>
      </div>
    );
  }

  function renderClaimPanel() {
    return (
      <section className="account-panel claim-panel" id="claimable-baskets">
        <div className="panel-title-row">
          <div>
            <span className="section-label">
              <Trophy size={16} />
              Payouts
            </span>
            <h2>Ready to claim</h2>
          </div>
          <span className="panel-count">{claimableTickets.length}</span>
        </div>
        {claimableTicketListError ? <div className="scoped-warning" role="alert">{claimableTicketListError}</div> : null}
        {claimError ? <div className="scoped-warning" role="alert">{claimError}</div> : null}
        {claimableTicketListState === "loading" ? (
          <AccountSkeleton rows={2} />
        ) : claimableTickets.length > 0 ? (
          <div className="account-list">
            {claimableTickets.map((ticket) => (
              <div className="account-row claim-row" key={ticket.ticketId}>
                <div>
                  <strong>{formatUsd(ticket.claimableAmountUsd || 0)}</strong>
                  <span>{ticket.legs} leg{ticket.legs === 1 ? "" : "s"} · {shortDateTime(ticket.updatedAt || ticket.createdAt)}</span>
                </div>
                <button
                  className="claim-ticket-btn"
                  disabled={claimingTicketId !== null}
                  onClick={() => void claimTicketWinnings(ticket.ticketId)}
                  type="button"
                >
                  {claimingTicketId === ticket.ticketId ? "Claiming" : "Claim"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="panel-empty">
            <Trophy size={22} />
            <span>No payouts ready to claim.</span>
          </div>
        )}
      </section>
    );
  }

  function renderPortfolio() {
    const prompt = renderAccountPrompt();
    if (prompt) return <section className="account-surface">{prompt}</section>;

    return (
      <section className="account-surface">
        <div className="account-hero">
          <div>
            <span className="section-label">
              <LayoutDashboard size={16} />
              Portfolio
            </span>
            <h1>Your LEGWORK account</h1>
            <p>Track live baskets, settlement outcomes, and money movement from one place.</p>
          </div>
        </div>

        {accountState === "error" ? (
          <div className="inline-error" role="alert">
            <span>{accountError}</span>
            <button onClick={() => setAccountRefreshKey((key) => key + 1)} type="button">Retry</button>
          </div>
        ) : null}
        {walletSyncInProgress || walletSyncLimited ? (
          <div className={walletSyncLimited ? "account-sync-note limited" : "account-sync-note"}>
            <Clock3 size={17} />
            <div>
              <strong>{walletSyncLimited ? "Portfolio is available" : "Finishing wallet setup"}</strong>
              <span>
                {walletSyncLimited
                  ? auth?.walletSyncError || "Wallet details are still syncing in the background."
                  : "Your account is connected. LEGWORK is syncing wallet details in the background."}
              </span>
            </div>
            {auth?.retryWalletSync ? (
              <button onClick={auth.retryWalletSync} type="button">
                Retry sync
              </button>
            ) : null}
          </div>
        ) : null}

        {claimNotice ? <div className="scoped-success" role="status" aria-live="polite">{claimNotice}</div> : null}

        <div className="dashboard-grid">
          <div className="metric-card primary">
            <span>Wallet USDC</span>
            <strong>{walletBalanceMetric}</strong>
            <small>Connected Sepolia wallet balance. LEGWORK balance: {accountMetric(availableBalance)}.</small>
          </div>
          <div className="metric-card claimable">
            <span>Claimable</span>
            <strong>{accountMetric(claimableBalance)}</strong>
            <small>Won baskets will appear here before they move to available balance.</small>
          </div>
          <div className="metric-card claimable">
            <span>Open stake</span>
            <strong>{accountMetric(accountSummary?.openStakeUsd || 0)}</strong>
            <small>{openTicketsCopy}</small>
          </div>
          <div className="metric-card claimable">
            <span>Potential payout</span>
            <strong>{accountMetric(accountSummary?.openPotentialPayoutUsd || 0)}</strong>
            <small>{openLiabilityCopy}</small>
          </div>
        </div>

        {isMobileViewport && claimableTickets.length > 0 ? renderClaimPanel() : null}

        <div className="account-columns">
          <section className="account-panel">
            <div className="panel-title-row">
              <div>
                <span className="section-label">
                  <Trophy size={16} />
                  Active baskets
                </span>
                <h2>Still in play</h2>
              </div>
              <span className="panel-count">{ticketListState === "error" ? "!" : activeBasketCount}</span>
            </div>
            {pendingPaymentsError ? <div className="scoped-warning">{pendingPaymentsError}</div> : null}
            {ticketListState === "error" && confirmingPayments.length > 0 ? <div className="scoped-warning">{ticketListError}</div> : null}
            {ticketListState === "loading" ? (
              <AccountSkeleton rows={3} />
            ) : activeBasketCount > 0 ? (
              <div className="account-list">
                {confirmingPayments.slice(0, 6).map((payment) => renderPendingPaymentRow(payment))}
                {activeTickets.slice(0, Math.max(0, 6 - confirmingPayments.length)).map((ticket) => (
                  <button
                    className={selectedTicketId === ticket.ticketId ? "account-row selected" : "account-row"}
                    key={ticket.ticketId}
                    onClick={() => setSelectedTicketId(ticket.ticketId)}
                    type="button"
                  >
                    <div>
                      <strong>
                        {formatUsd(ticket.potentialPayoutUsd || 0)} potential
                      </strong>
                      <span>
                        {ticket.legs} leg{ticket.legs === 1 ? "" : "s"} · paid {formatUsd(ticket.amountPaidUsd || 0)} ·{" "}
                        {legProgressText(ticket) || `bought ${shortDateTime(ticket.createdAt)}`}
                      </span>
                    </div>
                    <em className={`status-pill ${statusTone(isAllVoidedTicket(ticket) ? "voided" : ticket.status)}`}>
                      {isAllVoidedTicket(ticket) ? "Stake returned" : statusLabel(ticket.status)}
                    </em>
                  </button>
                ))}
              </div>
            ) : ticketListState === "error" ? (
              renderTicketListUnavailable()
            ) : walletSyncInProgress ? (
              <AccountSkeleton rows={3} />
            ) : (
              <div className="panel-empty">
                <ShoppingCart size={22} />
                <span>No active baskets yet.</span>
                <button onClick={() => navigateToView("markets")} type="button">Browse markets</button>
              </div>
            )}
          </section>

          {renderTicketDetailPanel()}
        </div>

        <div className="activity-grid">
          {!isMobileViewport || claimableTickets.length === 0 ? renderClaimPanel() : null}

          {recoverablePayments.length > 0 ? (
            <section className="account-panel">
              <div className="panel-title-row">
                <div>
                  <span className="section-label">
                    <Banknote size={16} />
                    Released payments
                  </span>
                  <h2>Returned balance</h2>
                </div>
                <span className="panel-count">{recoverablePayments.length}</span>
              </div>
              <div className="scoped-success" role="status">
                Received USDC was returned to your available LEGWORK balance. Review the withdrawal section for current availability.
              </div>
              <div className="account-list">
                {recoverablePayments.map((payment) => renderRecoverablePaymentRow(payment))}
              </div>
            </section>
          ) : null}

          <section className="account-panel">
            <div className="panel-title-row">
              <div>
                <span className="section-label">Tickets</span>
                <h2>Recent baskets</h2>
              </div>
              <span className="panel-count">{ticketListState === "error" ? "!" : allBasketCount}</span>
            </div>
            {ticketListState === "error" && confirmingPayments.length > 0 ? <div className="scoped-warning">{ticketListError}</div> : null}
            {ticketListState === "loading" ? (
              <AccountSkeleton rows={5} />
            ) : allBasketCount > 0 ? (
              <div className="account-list">
                {confirmingPayments.map((payment) => renderPendingPaymentRow(payment))}
                {tickets.map((ticket) => (
                  <button
                    className={selectedTicketId === ticket.ticketId ? "account-row selected" : "account-row"}
                    key={ticket.ticketId}
                    onClick={() => setSelectedTicketId(ticket.ticketId)}
                    type="button"
                  >
                    <div>
                      <strong>
                        {ticket.settlementPolicyReviewRequired
                          ? "Settlement under review"
                          : isAllVoidedTicket(ticket)
                          ? `${formatUsd(ticket.stakeUsd || 0)} stake returned`
                          : ticket.status === "claimable" || ticket.status === "paid"
                            ? `${formatUsd(ticket.claimableAmountUsd || 0)} ${ticket.status === "paid" ? "claimed" : "payout"}`
                            : `${formatUsd(ticket.potentialPayoutUsd || 0)} potential`}
                      </strong>
                      <span>
                        {ticket.settlementPolicyReviewRequired
                          ? `${ticket.legs} leg${ticket.legs === 1 ? "" : "s"} · legacy void policy reconciliation`
                          : isAllVoidedTicket(ticket)
                          ? `${ticket.legs} leg${ticket.legs === 1 ? "" : "s"} · Available LEGWORK balance · operation fee retained`
                          : <>{ticket.legs} leg{ticket.legs === 1 ? "" : "s"} · paid {formatUsd(ticket.amountPaidUsd || 0)} ·{" "}{legProgressText(ticket) || shortDateTime(ticket.createdAt)}</>}
                      </span>
                    </div>
                    <em className={`status-pill ${statusTone(ticket.settlementPolicyReviewRequired ? "disputed" : ticket.status)}`}>
                      {ticket.settlementPolicyReviewRequired ? "Settlement review" : statusLabel(ticket.status)}
                    </em>
                  </button>
                ))}
              </div>
            ) : ticketListState === "error" ? (
              renderTicketListUnavailable()
            ) : walletSyncInProgress ? (
              <AccountSkeleton rows={5} />
            ) : (
              <div className="panel-empty">
                <ShoppingCart size={22} />
                <span>No baskets yet.</span>
              </div>
            )}
          </section>

          <section className="account-panel">
            <div className="panel-title-row">
              <div>
                <span className="section-label">Withdrawals</span>
                <h2>Withdrawal history</h2>
              </div>
              <span className="panel-count">{withdrawals.length}</span>
            </div>
            <form
              className="withdrawal-request"
              onSubmit={(event) => {
                event.preventDefault();
                void requestWithdrawal();
              }}
            >
              <div className="withdrawal-balance">
                <div>
                  <span>Available LEGWORK USDC</span>
                  <strong>{accountMetric(availableBalance)}</strong>
                </div>
                <button
                  disabled={withdrawalRequestState === "submitting" || accountSummaryLoading || accountSummaryUnavailable}
                  onClick={() => updateWithdrawalAmount(formatUsdcInput(availableBalance))}
                  type="button"
                >
                  Max
                </button>
              </div>
              <label className="withdrawal-field" htmlFor="withdrawal-amount">
                <span>Amount</span>
                <div className="withdrawal-input-wrap">
                  <input
                    aria-describedby="withdrawal-amount-help"
                    autoComplete="off"
                    disabled={withdrawalRequestState === "submitting"}
                    id="withdrawal-amount"
                    inputMode="decimal"
                    onChange={(event) => updateWithdrawalAmount(event.target.value)}
                    placeholder="0.000000"
                    value={withdrawalAmountInput}
                  />
                  <strong>USDC</strong>
                </div>
              </label>
              <div className="withdrawal-destination">
                <span>Destination</span>
                {withdrawalDestination ? (
                  <strong title={withdrawalDestination}>{compactId(withdrawalDestination)}</strong>
                ) : (
                  <strong>Wallet verification required</strong>
                )}
              </div>
              <div className="withdrawal-form-footer">
                <span id="withdrawal-amount-help">
                  {withdrawalAmountError || "Requests move available LEGWORK USDC to your verified wallet after treasury processing."}
                </span>
                <button className="withdrawal-submit" disabled={!canSubmitWithdrawal} type="submit">
                  {withdrawalRequestState === "submitting" ? "Requesting" : "Request withdrawal"}
                </button>
              </div>
              {withdrawalRequestState === "submitting" ? (
                <div className="scoped-warning withdrawal-request-status" role="status" aria-live="polite">
                  {withdrawalRequestMessage}
                </div>
              ) : null}
              {withdrawalRequestState === "success" ? (
                <div className="scoped-success withdrawal-request-status" role="status" aria-live="polite">
                  {withdrawalRequestMessage}
                </div>
              ) : null}
              {withdrawalRequestState === "error" ? (
                <div className="scoped-warning withdrawal-request-status" role="alert">
                  {withdrawalRequestMessage}
                </div>
              ) : null}
            </form>
            {withdrawalError ? <div className="scoped-warning">{withdrawalError}</div> : null}
            {accountState === "loading" ? (
              <AccountSkeleton rows={4} />
            ) : withdrawals.length > 0 ? (
              <div className="account-list">
                {withdrawals.map((withdrawal) => (
                  <div className="account-row" key={withdrawal.id}>
                    <div>
                      <strong>{formatUsd(withdrawal.amountUsdc)}</strong>
                      <span>{compactId(withdrawal.destinationAddress)} · {shortDateTime(withdrawal.createdAt)}</span>
                      {withdrawal.onchainTxHash ? (
                        <a
                          className="compact-tx-link"
                          href={txExplorerUrl(withdrawal.onchainTxHash, withdrawal.chainId)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Transaction {compactId(withdrawal.onchainTxHash)} <ExternalLink size={12} />
                        </a>
                      ) : null}
                    </div>
                    <div className="withdrawal-row-actions">
                      <em className={`status-pill ${statusTone(withdrawal.status)}`}>{statusLabel(withdrawal.status)}</em>
                      {withdrawal.status === "requested" ? (
                        <button
                          className="withdrawal-cancel"
                          disabled={cancelingWithdrawalId !== null}
                          onClick={() => void cancelRequestedWithdrawal(withdrawal.id)}
                          type="button"
                        >
                          {cancelingWithdrawalId === withdrawal.id ? "Canceling" : "Cancel"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="panel-empty">
                <ReceiptText size={22} />
                <span>No withdrawals yet.</span>
              </div>
            )}
          </section>
        </div>
      </section>
    );
  }

  function outcomeTone(outcome: string) {
    const normalized = outcome.trim().toLowerCase();
    if (isYesOutcome(outcome)) return "yes";
    if (normalized === "no" || normalized === "down") return "no";
    return "other";
  }

  function renderMarketRow(row: MarketRow, variant: "normal" | "sibling" = "normal") {
    const selected = selectedByMarket.get(row.marketId);
    const content = (
      <>
        <div className="market-image" aria-hidden="true">
          {row.icon || row.image ? <img src={row.icon || row.image} alt="" /> : <span>{marketInitial(row.question)}</span>}
        </div>
        <div className="market-main">
          <div className="market-meta">
            <span>{row.category}</span>
            <span>{dateLabel(row.endDate)}</span>
            <span>Vol {compactUsd(row.volume)}</span>
          </div>
          <h2>{row.question}</h2>
          {row.marketUrl ? (
            <a
              href={row.marketUrl}
              target="_blank"
              rel="noreferrer"
              className="market-source-link"
              aria-label={`${sourceLabel(row.source, row.marketUrl)}: ${row.question}`}
            >
              {sourceLabel(row.source, row.marketUrl)}
              <ExternalLink size={13} />
            </a>
          ) : (
            <span className="market-source-note">{sourceLabel(row.source, row.marketUrl)}</span>
          )}
        </div>
        <div className="outcome-grid">
          {row.outcomes.map((outcome) => {
            const isSelected = selected?.id === outcome.id;
            return (
              <button
                className={`outcome-btn ${outcomeTone(outcome.outcome)}${isSelected ? " selected" : ""}`}
                onClick={() => chooseOutcome(outcome)}
                key={outcome.id}
                aria-pressed={isSelected}
                aria-label={`${outcome.outcome} ${formatCents(outcome.price)} for ${row.question}`}
                type="button"
              >
                <span>{outcome.outcome}</span>
                <strong>{formatCents(outcome.price)}</strong>
              </button>
            );
          })}
        </div>
      </>
    );

    if (variant === "sibling") {
      return (
        <div className={selected ? "event-sibling-row chosen" : "event-sibling-row"} key={row.marketId} role="listitem">
          {content}
        </div>
      );
    }

    return (
      <article className={selected ? "market-card chosen" : "market-card"} key={row.marketId}>
        {content}
      </article>
    );
  }

  function renderEventSurface(surface: MarketEventSurface) {
    if (surface.marketCount === 1) return renderMarketRow(surface.rows[0]);

    const expanded = expandedEvents.has(surface.key);
    const selected = selectedByEvent.get(surface.key);
    const initialLimit = isMobileViewport ? 5 : 8;
    const siblingLimit = expandedSiblingLimits[surface.key] || initialLimit;
    const visibleSiblingRows = expanded ? surface.rows.slice(0, siblingLimit) : [];
    const hasMoreSiblings = expanded && siblingLimit < surface.rows.length;
    const siblingListId = eventSiblingListId(surface.key);

    return (
      <article className={selected ? "event-card chosen" : "event-card"} key={surface.key}>
        <div className="event-header">
          <div className="market-image event-image" aria-hidden="true">
            {surface.icon || surface.image ? (
              <img src={surface.icon || surface.image} alt="" />
            ) : (
              <span>{marketInitial(surface.eventTitle)}</span>
            )}
          </div>
          <div className="event-main">
            <div className="market-meta">
              <span>{surface.category}</span>
              <span>{surface.marketCount} markets</span>
              <span>Vol {compactUsd(surface.volume)}</span>
              <span>Ends {dateLabel(surface.endDate)}</span>
            </div>
            <h2>{surface.eventTitle}</h2>
            <div className="event-footer-line">
              {surface.marketUrl ? (
                <a href={surface.marketUrl} target="_blank" rel="noreferrer" className="market-source-link">
                  Open on Polymarket
                  <ExternalLink size={13} />
                </a>
              ) : null}
              <span className={selected ? "event-selected-summary active" : "event-selected-summary"}>
                {selected ? `${selected.question} · ${selected.outcome} · ${formatCents(selected.price)}` : "No pick yet"}
              </span>
            </div>
          </div>
          <button
            className="event-toggle"
            onClick={() =>
              setExpandedEvents((current) => {
                const next = new Set(current);
                if (next.has(surface.key)) next.delete(surface.key);
                else next.add(surface.key);
                return next;
              })
            }
            type="button"
            aria-expanded={expanded}
            aria-controls={siblingListId}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${surface.eventTitle}`}
          >
            <ChevronDown size={20} />
          </button>
        </div>
        <div className="event-sibling-list" id={siblingListId} hidden={!expanded}>
          {expanded ? (
            <>
              <div className="event-sibling-rows" role="list">
                {visibleSiblingRows.map((row) => renderMarketRow(row, "sibling"))}
              </div>
              {hasMoreSiblings ? (
                <button
                  className="event-show-more"
                  onClick={() =>
                    setExpandedSiblingLimits((current) => ({
                      ...current,
                      [surface.key]: Math.min(surface.rows.length, siblingLimit + initialLimit)
                    }))
                  }
                  type="button"
                >
                  Show more
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <main className="app-shell">
      {renderPaymentModal()}
      <div
        className="app-background"
        aria-hidden={mobileBasketOpen || paymentModalOpen ? true : undefined}
        inert={mobileBasketOpen || paymentModalOpen ? true : undefined}
      >
      <header className="topbar">
        <div className="topbar-brand">
          <button className="brand-lockup" onClick={() => navigateToView("markets")} aria-label="LEGWORK Markets" type="button">
            <Layers3 size={18} />
            <span>LEGWORK</span>
          </button>
          <p>Why win once when you can win big?</p>
        </div>
        <nav className="top-nav" aria-label="Primary">
          {(["markets", "portfolio", "lp-vault"] as const).map((view) => (
            <button
              className={activeView === view ? "top-nav-btn active" : "top-nav-btn"}
              key={view}
              onClick={() => navigateToView(view)}
              aria-current={activeView === view ? "page" : undefined}
              type="button"
            >
              {view === "markets" ? "Markets" : view === "portfolio" ? "Portfolio" : "LP Vault"}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          {activeView === "markets" ? <strong className="market-count">{marketCountLabel}</strong> : null}
          {auth?.enabled ? (
            auth.authenticated ? (
              <button className="wallet-pill" onClick={auth.logout} type="button">
                Disconnect wallet
                <span>{auth.walletSynced ? "Synced" : walletSyncFailed ? "Session issue" : walletSyncLimited ? "Account ready" : "Setting up"}</span>
              </button>
            ) : (
              <button className="wallet-pill connect" disabled={!auth.ready} onClick={auth.login} type="button">
                Connect wallet
              </button>
            )
          ) : null}
        </div>
      </header>

      {activeView === "markets" ? (
      <section className={hasBasketQuote ? "quote-strip" : "quote-strip empty"} aria-label="Quote summary">
        <div>
          <span>Selected</span>
          <strong>{legs.length}</strong>
        </div>
        <div>
          <span>Basket probability{quoteValueQualifier}</span>
          <strong>{basketProbabilityDisplay}</strong>
        </div>
        <div>
          <span>Basket price{quoteValueQualifier}</span>
          <strong>{basketPriceDisplay}</strong>
        </div>
        <div>
          <span>Potential payout{quoteValueQualifier}</span>
          <AnimatedPayout value={payoutDisplay} burstKey={burstKey} compact />
        </div>
        <div>
          <span>Amount due{quoteValueQualifier}</span>
          <strong>{totalCostDisplay}</strong>
        </div>
      </section>
      ) : null}

      {activeView === "markets" ? (
      <section className="workspace-grid">
        <div className="market-pane">
          <div className="pane-header">
            <div>
              <h1>Discover</h1>
              <p>Pick a side, stack another, and turn scattered conviction into one payout.</p>
            </div>
            <label className="sort-control">
              <ArrowUpDown size={16} />
              <span>Sort</span>
              <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)} aria-label="Sort markets">
                {sortOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="toolbar">
            <label className="search-box">
              <Search size={18} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search markets"
                aria-label="Search markets"
              />
            </label>
            <div className="category-rail" role="group" aria-label="Category filters">
              {categories.map((item) => (
                <button
                  type="button"
                  className={category === item ? "category-chip active" : "category-chip"}
                  aria-pressed={category === item}
                  onClick={() => setCategory(item)}
                  key={item}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          {showMarketCatalogNotice ? (
            <div className={marketCatalogStale || marketCatalogPartial ? "catalog-trust-note warning" : "catalog-trust-note"}>
              <Clock3 size={17} />
              <div>
                <strong>{marketCatalogNoticeTitle}</strong>
                <span>{marketCatalogNoticeCopy}</span>
              </div>
              <button className="ghost-btn" onClick={() => setMarketRefreshKey((key) => key + 1)} type="button">
                Refresh
              </button>
            </div>
          ) : null}

          {selectionNotice ? (
            <div className="selection-toast" role="status" aria-live="polite" aria-atomic="true">
              {selectionNotice}
            </div>
          ) : null}

          <div className="market-list">
            {marketEventSurfaces.map((surface) => renderEventSurface(surface))}
            {marketEventSurfaces.length === 0 ? (
              <div
                className="empty-market-state"
                role={fetchState === "error" ? "alert" : "status"}
                aria-live={fetchState === "error" ? "assertive" : "polite"}
              >
                {fetchState === "loading" || fetchState === "idle" ? (
                  <div className="market-loading-orbit" aria-hidden="true" />
                ) : null}
                <strong>
                  {fetchState === "loading" || fetchState === "idle"
                    ? "Loading live Polymarket markets"
                    : hasMarketFilters
                      ? "No matches"
                      : "No live markets"}
                </strong>
                <span>
                  {fetchState === "loading" || fetchState === "idle"
                    ? "LEGWORK only shows markets with a verified Polymarket source link."
                    : hasMarketFilters
                      ? "Clear the search or category filter to see more markets."
                      : marketError || "No markets are available right now."}
                </span>
                {fetchState === "error" ? (
                  <button className="primary-inline-btn" onClick={() => setMarketRefreshKey((key) => key + 1)} type="button">
                    Retry markets
                  </button>
                ) : null}
              </div>
            ) : null}
            {marketHasMore && marketEventSurfaces.length > 0 ? (
              <button
                className="load-more-markets"
                disabled={loadingMoreMarkets || !nextMarketCursor}
                onClick={() => {
                  if (!nextMarketCursor) return;
                  void loadMarketCatalogPage("append", nextMarketCursor);
                }}
                type="button"
              >
                {loadingMoreMarkets ? "Loading" : "Load more"}
              </button>
            ) : null}
            {paginationIssue ? (
              <div className="pagination-error" role="status" aria-live="polite" aria-atomic="true">
                <span>{paginationIssue.message}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (paginationIssue.kind === "duplicate" || paginationIssue.kind === "malformed") {
                      setMarketRefreshKey((key) => key + 1);
                    } else {
                      void loadMarketCatalogPage("append", paginationIssue.cursor);
                    }
                  }}
                >
                  {paginationIssue.kind === "duplicate" || paginationIssue.kind === "malformed" ? "Retry catalog" : "Retry load more"}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="ticket-pane">
          <div className="ticket-header">
            <div>
              <span className="section-label">
                <ShoppingCart size={16} />
                Your slip
              </span>
              <h2>Basket</h2>
            </div>
            <button className="ghost-btn" onClick={() => setLegs([])} disabled={legs.length === 0}>
              <Trash2 size={16} />
              Clear
            </button>
          </div>

          <div className={stakeLimitActive ? "stake-control limit-hit" : "stake-control"}>
            <div className="stake-copy">
              <span>Buy amount</span>
              <small>
                Balance <strong>{walletBalanceLabel}</strong>
              </small>
            </div>
            <div className="stake-entry">
              <label className="money-input">
                <span>$</span>
                <input
                  value={amountInput}
                  min={0}
                  max={stakeCapUsd}
                  inputMode="decimal"
                  placeholder="0"
                  type="number"
                  onBlur={commitAmountInput}
                  onChange={(event) => handleAmountInput(event.target.value)}
                  aria-label="Buy amount"
                />
              </label>
              {stakeLimitActive ? (
                <small className="stake-limit-note" key={`stake-limit-${stakeLimitKey}`}>
                  Max {formatUsd(stakeCapUsd)}
                </small>
              ) : null}
            </div>
            <div className="stake-footer">
              <div className="stake-presets" aria-label="Stake presets">
                {stakeAdds.map((increment) => (
                  <button
                    key={increment}
                    onClick={() => setStakeAmount(amount + increment)}
                    type="button"
                    aria-label={`Add $${increment}`}
                  >
                    +${increment}
                  </button>
                ))}
                <button onClick={() => setStakeAmount(stakeCapUsd)} type="button" aria-label="Set max stake">
                  Max
                </button>
              </div>
              <span className="stake-cap-copy">Launch cap {formatUsd(stakeCapUsd)}</span>
            </div>
          </div>

          <div className="leg-list">
            {legs.length === 0 ? (
              <div className="empty-ticket">
                <ShoppingCart size={26} />
                <span>Select 2+ markets to price a basket</span>
              </div>
            ) : (
              legs.map((leg) => (
                <div className="leg-row" key={leg.id}>
                  <div>
                    <span>
                      {leg.outcome} at {formatCents(leg.price)}
                    </span>
                    <p>{leg.question}</p>
                    <small>
                      {dateLabel(leg.endDate)} · Vol {compactUsd(leg.volume)}
                    </small>
                  </div>
                  <button className="icon-btn quiet" onClick={() => removeLeg(leg.id)} aria-label="Remove leg">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="totals-grid">
            <div>
              <span>Basket price{quoteValueQualifier}</span>
              <strong>{basketPriceDisplay}</strong>
            </div>
            <div>
              <span>Quote spread{quoteValueQualifier}</span>
              <strong>{quoteSpreadDisplay}</strong>
            </div>
            <div>
              <span>Operation fee{quoteValueQualifier}</span>
              <strong>{operationFeeDisplay}</strong>
            </div>
            <div>
              <span>Payout multiple{quoteValueQualifier}</span>
              <strong>{payoutMultipleDisplay}</strong>
            </div>
          </div>

          <div className="checkout-dock">
            <div className="payout-callout" aria-live="polite">
              <span>Potential payout{quoteValueQualifier}</span>
              <AnimatedPayout value={payoutDisplay} burstKey={burstKey} />
              <small>
                {legs.length < 2
                  ? legs.length === 1
                    ? "Add one more market to unlock a basket quote."
                    : "Add two markets to unlock a basket quote."
                  : !hasBuyAmount
                    ? "Enter buy amount to see payout."
                    : risk.decision === "reject"
                      ? "This basket cannot be quoted within the current limits."
                      : "Paid if every selected market resolves your way."}
              </small>
            </div>

            <button
              className="checkout-btn"
              disabled={!canUseCheckoutAction || checkoutBusy}
              onClick={handleCheckout}
            >
              <Banknote size={18} />
              {checkoutLabel}
            </button>
          </div>

          {hasBasketQuote && hasBuyAmount ? (
            <details className={`risk-panel ${risk.decision}`} open={risk.decision === "reject" ? true : undefined}>
              <summary>
                <span>Basket availability</span>
                <strong>
                  {risk.decision === "accept" ? "Available" : risk.decision === "review" ? "Price check needed" : "Unavailable"}
                </strong>
              </summary>
              <div className="risk-diagnostics">
                <small>
                  Quote spread: {formatPercent(risk.spreadBps / 10_000)} · Maximum spread: {formatPercent(risk.maxSpreadBps / 10_000)}
                </small>
                {serverQuoteState === "ready" && activeServerQuote ? (
                  <small className="server-quote-status">
                    Live quote confirmed · expires {new Date(activeServerQuote.expiresAt).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}
                  </small>
                ) : null}
                {serverQuoteState === "error" ? <small className="server-quote-status error" role="alert">{serverQuoteError}</small> : null}
                {serverTicketState === "ready" && serverTicket ? (
                  <small className="server-quote-status">Ticket live · {serverTicket.ticketId.slice(0, 8)}</small>
                ) : null}
                {serverTicketState === "error" ? <small className="server-quote-status error" role="alert">{serverTicketError}</small> : null}
                <div className="risk-check-list">
                  {visibleRiskChecks.map((check) => (
                    <span className={check.level} key={`${check.label}-${check.detail}`}>
                      {check.label}: {check.detail}
                    </span>
                  ))}
                </div>
              </div>
            </details>
          ) : null}

          <details className="detail-panel" open>
            <summary>
              <Lightbulb size={17} />
              How to use LEGWORK
            </summary>
            <div className="help-list">
              <span>1. Choose one side from at least two markets.</span>
              <span>2. The basket price compounds each selected market price.</span>
              <span>3. You win only if every leg resolves in your direction.</span>
              <span>4. For launch, LEGWORK allows one pick per event group. A new pick from the same event replaces the prior one.</span>
            </div>
          </details>

          <details className="detail-panel">
            <summary>
              <Sparkles size={18} />
              Fees and spread
            </summary>
            <p>
              LEGWORK adds a small operation fee for each market in the basket. That covers quote snapshots, market
              monitoring, and settlement work. The quote spread is the margin between the raw market price and the
              basket quote.
            </p>
            <div className="settlement-steps">
              <span>$0.50 per selected leg</span>
              <span>Quote spread: {quoteSpreadDisplay} on the basket quote</span>
              <span>Risk adjustment: correlation, liquidity, payout, and leg-count checks</span>
              <span>Amount due: {totalCostDisplay}</span>
            </div>
          </details>

          <details className="detail-panel">
            <summary>
              <Info size={17} />
              Label guide
            </summary>
            <div className="label-guide">
              <div>
                <strong>Basket price</strong>
                <span>The combined market-implied odds of every selected leg winning.</span>
              </div>
              <div>
                <strong>Basket probability</strong>
                <span>The same combined odds shown as a percentage.</span>
              </div>
              <div>
                <strong>Potential payout</strong>
                <span>The gross amount paid if every selected market resolves your way.</span>
              </div>
              <div>
                <strong>Amount due</strong>
                <span>Your buy amount plus operation fees.</span>
              </div>
              <div>
                <strong>Quote spread</strong>
                <span>The dynamic margin LEGWORK applies after correlation, liquidity, payout, and leg-count checks.</span>
              </div>
              <div>
                <strong>Operation fee</strong>
                <span>The fixed fee for quote snapshots, monitoring, and settlement work.</span>
              </div>
              <div>
                <strong>Payout multiple</strong>
                <span>The payout multiple LEGWORK quotes after spread. Multiply this by your buy amount to estimate the gross payout.</span>
              </div>
            </div>
          </details>
        </aside>
      </section>
      ) : activeView === "portfolio" ? (
        renderPortfolio()
      ) : (
        <LpVaultView
          authenticated={Boolean(auth?.authenticated)}
          onConnect={auth?.enabled && !auth.authenticated && auth.ready ? auth.login : undefined}
        />
      )}
      <footer className="site-footer">
        <span>&copy; {new Date().getFullYear()} LEGWORK</span>
        <span>Supervised Sepolia beta · Test USDC only</span>
        <a href="https://polymarket.com" target="_blank" rel="noreferrer">
          Market data by Polymarket <ExternalLink size={12} />
        </a>
      </footer>
      </div>

      {activeView === "markets" && mobileBasketOpen ? (
        <>
          <div className="mobile-sheet-backdrop" onClick={closeMobileBasket} aria-hidden="true" />
          <div
            className="mobile-basket-sheet"
            id="mobile-basket-dialog"
            ref={mobileBasketDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-basket-title"
            tabIndex={-1}
            aria-hidden={paymentModalOpen ? true : undefined}
            inert={paymentModalOpen ? true : undefined}
          >
            <div className="mobile-sheet-handle">
              <div>
                <span id="mobile-basket-title">Basket</span>
                <AnimatedPayout value={mobilePayoutDisplay} burstKey={burstKey} className="mobile-payout-value" compact />
              </div>
              <button ref={mobileBasketCloseRef} onClick={closeMobileBasket} aria-label="Collapse basket">
                <ChevronDown size={20} />
              </button>
            </div>

            <div className="mobile-sheet-body">
              <div className={stakeLimitActive ? "stake-control mobile-stake limit-hit" : "stake-control mobile-stake"}>
                <div className="stake-copy">
                  <span>Buy amount</span>
                  <small>Launch cap {formatUsd(stakeCapUsd)}</small>
                </div>
                <div className="stake-entry">
                  <label className="money-input">
                    <span>$</span>
                    <input
                      value={amountInput}
                      min={0}
                      max={stakeCapUsd}
                      inputMode="decimal"
                      placeholder="0"
                      type="number"
                      onBlur={commitAmountInput}
                      onChange={(event) => handleAmountInput(event.target.value)}
                      aria-label="Mobile buy amount"
                    />
                  </label>
                  {stakeLimitActive ? (
                    <small className="stake-limit-note" key={`mobile-stake-limit-${stakeLimitKey}`}>
                      Max {formatUsd(stakeCapUsd)}
                    </small>
                  ) : null}
                </div>
                <div className="stake-presets" aria-label="Mobile stake presets">
                  {stakeAdds.map((increment) => (
                    <button
                      key={increment}
                      onClick={() => setStakeAmount(amount + increment)}
                      type="button"
                      aria-label={`Add $${increment} mobile`}
                    >
                      +${increment}
                    </button>
                  ))}
                  <button onClick={() => setStakeAmount(stakeCapUsd)} type="button" aria-label="Set max mobile stake">
                    Max
                  </button>
                </div>
              </div>

              {legs.length === 0 ? (
                <div className="empty-ticket mobile-empty">
                  <ShoppingCart size={24} />
                  <span>Select 2+ markets to price a basket</span>
                </div>
              ) : (
                <div className="mobile-leg-list">
                  {legs.map((leg) => (
                    <div className="leg-row" key={leg.id}>
                      <div>
                        <span>
                          {leg.outcome} at {formatCents(leg.price)}
                        </span>
                        <p>{leg.question}</p>
                      </div>
                      <button className="icon-btn quiet" onClick={() => removeLeg(leg.id)} aria-label="Remove leg">
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="mobile-sheet-totals">
                <span>{basketPriceDisplay} basket price</span>
                <strong>{totalCostDisplay} due</strong>
              </div>
              {serverQuoteState === "ready" && activeServerQuote ? (
                <small className="server-quote-status mobile-status">
                  Live quote confirmed · expires {new Date(activeServerQuote.expiresAt).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}
                </small>
              ) : null}
              {serverQuoteState === "error" ? <small className="server-quote-status error mobile-status" role="alert">{serverQuoteError}</small> : null}
              {serverTicketState === "ready" && serverTicket ? (
                <small className="server-quote-status mobile-status">Ticket saved · {serverTicket.ticketId.slice(0, 8)}</small>
              ) : null}
              {serverTicketState === "error" ? <small className="server-quote-status error mobile-status" role="alert">{serverTicketError}</small> : null}
              <button
                className="checkout-btn"
                disabled={!canUseCheckoutAction || checkoutBusy}
                onClick={handleCheckout}
              >
                {checkoutLabel}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {activeView === "markets" ? (
      <button
        className="mobile-basket-bar"
        ref={mobileBasketTriggerRef}
        onClick={openMobileBasket}
        aria-expanded={mobileBasketOpen}
        aria-controls="mobile-basket-dialog"
        aria-label={`Open basket: ${legs.length} selected. ${mobileBasketAction}.`}
        aria-hidden={mobileBasketOpen || paymentModalOpen ? true : undefined}
        inert={mobileBasketOpen || paymentModalOpen ? true : undefined}
      >
        <div>
          <span>{legs.length} selected</span>
          <AnimatedPayout value={mobilePayoutDisplay} burstKey={burstKey} className="mobile-payout-value" compact />
        </div>
        <span className={canUseCheckoutAction ? "mobile-review ready" : "mobile-review"}>
          {mobileBasketAction}
        </span>
      </button>
      ) : null}
    </main>
  );
}

function WalletCardIcon() {
  return <Banknote size={28} />;
}

function AnimatedPayout({
  value,
  burstKey,
  className = "",
  compact = false
}: {
  value: string;
  burstKey: number;
  className?: string;
  compact?: boolean;
}) {
  const classes = ["payout-value", compact ? "compact" : "", className].filter(Boolean).join(" ");
  return (
    <strong className={classes} key={`payout-${burstKey}`}>
      {value}
      {burstKey > 0 ? (
        <em className="firework-burst" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </em>
      ) : null}
    </strong>
  );
}

function AccountSkeleton({ rows }: { rows: number }) {
  return (
    <div className="account-list" role="status" aria-label="Loading account data">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="account-row skeleton" key={index}>
          <div>
            <strong />
            <span />
          </div>
          <em />
        </div>
      ))}
    </div>
  );
}
