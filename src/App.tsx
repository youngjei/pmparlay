import { useEffect, useMemo, useRef, useState } from "react";
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
  Lightbulb,
  Search,
  ShoppingCart,
  Sparkles,
  Trophy,
  X,
  Trash2
} from "lucide-react";
import { fetchMarketCatalog } from "./marketData";
import { calculateParlay, formatCents, formatNumber, formatPercent, formatUsd } from "./parlayMath";
import { assessTicketRisk } from "./riskEngine";
import type { FetchState, MarketCatalog, MarketOutcome, ParlayLeg } from "./types";

const categoryOrder = ["All", "Sports", "Politics", "Crypto", "Economics", "Weather", "Technology", "General"];
const stakeCapUsd = 25;
const stakeAdds = [1, 5, 10];
const marketDisplayLimit = 96;
const marketCatalogStaleAfterMs = 30_000;
const sortOptions = [
  { value: "popular", label: "Highest volume" },
  { value: "ending", label: "Ending soon" },
  { value: "balanced", label: "Most balanced" },
  { value: "liquidity", label: "Deepest liquidity" }
] as const;

type SortOrder = (typeof sortOptions)[number]["value"];

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
  source: MarketOutcome["source"];
  outcomes: MarketOutcome[];
};

type ServerQuote = {
  id: string;
  status: "quoted" | "rejected" | "accepted" | "expired";
  expiresAt: string;
  riskDecision: "accept" | "review" | "reject";
  potentialPayoutUsd: number;
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
  status: "pending" | "submitted" | "confirmed" | "activated" | "expired" | "failed";
  txHash?: string;
  ticketId?: string;
  expiresAt: string;
};

type PendingPaymentSummary = {
  id: string;
  quoteId: string;
  status: "submitted" | "confirmed";
  txHash?: string;
  chainId: number;
  amountPaidUsd: number;
  potentialPayoutUsd: number;
  legs: number;
  createdAt: string;
  updatedAt: string;
};

type PaymentFlowState = "idle" | "loading" | "ready" | "sending" | "pending" | "activating" | "complete" | "error";

type AppView = "markets" | "portfolio";

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
    lost: "Lost",
    voided: "Refund due",
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
    resolved_void: "Refund due",
    resolved_partial: "Partial"
  };
  return resolutionState ? labels[resolutionState] : undefined;
}

function legStatusLabel(status: string, resolutionState?: string, endDate?: string, ticketStatus?: string) {
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
    leg.resolutionUpdatedAt ? `Updated ${shortDateTime(leg.resolutionUpdatedAt)}` : "",
    leg.lastResolutionError ? `Last error ${leg.lastResolutionError}` : ""
  ].filter(Boolean);
  return parts.join(" · ");
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
  if (status === "won" || status === "resolved_won") return "won";
  if (status === "paid" || status === "sent") return "paid";
  if (status === "lost" || status === "failed" || status === "resolved_lost") return "lost";
  if (status === "voided" || status === "canceled" || status === "resolved_void") return "voided";
  return "live";
}

function chainLabel(chainId?: number) {
  if (chainId === 1) return "Ethereum";
  if (chainId === 11155111) return "Sepolia";
  return chainId ? `Chain ${chainId}` : "Ethereum";
}

function txExplorerUrl(txHash: string, chainId?: number) {
  if (chainId === 11155111) return `https://sepolia.etherscan.io/tx/${txHash}`;
  return `https://etherscan.io/tx/${txHash}`;
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
    throw new Error(payload?.detail || payload?.error || "Request failed.");
  }

  return (await response.json()) as T;
}

async function authedPostJson<T>(
  url: string,
  getAccessToken?: () => Promise<string | null>,
  body?: unknown,
  headers?: Record<string, string>
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = (await response.json().catch(() => null)) as T | { detail?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && ("detail" in payload || "error" in payload)
        ? payload.detail || payload.error || "Request failed."
        : "Request failed."
    );
  }

  return payload as T;
}

function apiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const item = payload as { detail?: string; error?: string };
  if (item.detail) return item.detail;
  if (item.error === "unauthorized") return "Wallet session expired. Reconnect your wallet and try again.";
  if (item.error === "executable_price_unavailable") return "LEGWORK could not verify current executable prices for every selected leg. Retry in a moment.";
  if (item.error === "quote_pricing_timeout") return "LEGWORK could not refresh executable prices quickly enough. Retry in a moment.";
  if (item.error === "unknown_market_outcome") return "One selected market is no longer available. Refresh markets and rebuild the basket.";
  if (item.error) return item.error.replace(/_/g, " ");
  return fallback;
}

function marketInitial(question: string) {
  return question.replace(/^(will|can|does|do|is|are)\s+/i, "").trim().slice(0, 1).toUpperCase() || "?";
}

function sourceLabel(source: MarketOutcome["source"], marketUrl?: string) {
  if (source === "polymarket" && marketUrl) return "Open on Polymarket";
  if (source === "polymarket") return "Polymarket source";
  return "Source unavailable";
}

function eventKey(marketUrl?: string) {
  if (!marketUrl) return "";
  try {
    return new URL(marketUrl).pathname.replace(/\/$/, "");
  } catch {
    return marketUrl.replace(/\/$/, "");
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

function balanceScore(row: MarketRow) {
  return Math.min(...row.outcomes.map((outcome) => Math.abs(outcome.price - 0.5)));
}

function sortMarketRows(rows: MarketRow[], sortOrder: SortOrder) {
  return [...rows].sort((a, b) => {
    if (sortOrder === "ending") return timeValue(a.endDate) - timeValue(b.endDate);
    if (sortOrder === "balanced") return balanceScore(a) - balanceScore(b);
    if (sortOrder === "liquidity") return (b.liquidity || 0) - (a.liquidity || 0);
    return (b.volume || 0) - (a.volume || 0);
  });
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
      continue;
    }

    rows.set(outcome.marketId, {
      marketId: outcome.marketId,
      conditionId: outcome.conditionId,
      question: outcome.question,
      category: outcome.category || "General",
      endDate: outcome.endDate,
      volume: outcome.volume,
      liquidity: outcome.liquidity,
      image: outcome.image,
      icon: outcome.icon,
      marketUrl: outcome.marketUrl,
      source: outcome.source,
      outcomes: [outcome]
    });
  }

  const allRows = [...rows.values()].sort((a, b) => (b.volume || 0) - (a.volume || 0));
  const promoted = allRows.filter((row) => /bitcoin|ethereum|hype|up or down/i.test(row.question)).slice(0, 10);
  const promotedIds = new Set(promoted.map((row) => row.marketId));
  const buckets = new Map<string, MarketRow[]>();

  for (const row of allRows.filter((item) => !promotedIds.has(item.marketId))) {
    const key = row.category || "General";
    buckets.set(key, [...(buckets.get(key) || []), row]);
  }

  const preferredOrder = ["Crypto", "Sports", "Politics", "Economics", "Weather", "Technology", "General"];
  const bucketOrder = [...preferredOrder, ...[...buckets.keys()].filter((key) => !preferredOrder.includes(key)).sort()];
  const interleaved: MarketRow[] = [];
  let hasRows = true;
  while (hasRows) {
    hasRows = false;
    for (const key of bucketOrder) {
      const bucket = buckets.get(key);
      const next = bucket?.shift();
      if (next) {
        interleaved.push(next);
        hasRows = true;
      }
    }
  }

  return [...promoted, ...interleaved];
}

export default function App({ auth }: AppProps = {}) {
  const [activeView, setActiveView] = useState<AppView>("markets");
  const [marketCatalog, setMarketCatalog] = useState<MarketCatalog | null>(null);
  const [outcomes, setOutcomes] = useState<MarketOutcome[]>([]);
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [marketError, setMarketError] = useState("");
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [sortOrder, setSortOrder] = useState<SortOrder>("popular");
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
  const [accountState, setAccountState] = useState<AccountDataState>("idle");
  const [accountError, setAccountError] = useState("");
  const [ticketListState, setTicketListState] = useState<AccountDataState>("idle");
  const [ticketListError, setTicketListError] = useState("");
  const [withdrawalError, setWithdrawalError] = useState("");
  const [pendingPaymentsError, setPendingPaymentsError] = useState("");
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [pendingPayments, setPendingPayments] = useState<PendingPaymentSummary[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [ticketDetail, setTicketDetail] = useState<TicketDetail | null>(null);
  const [ticketDetailState, setTicketDetailState] = useState<TicketDetailState>("idle");
  const [ticketDetailError, setTicketDetailError] = useState("");
  const [ticketDetailRefreshKey, setTicketDetailRefreshKey] = useState(0);
  const [withdrawals, setWithdrawals] = useState<WithdrawalSummary[]>([]);
  const [accountRefreshKey, setAccountRefreshKey] = useState(0);
  const lastPayoutRef = useRef<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    setFetchState("loading");
    setMarketError("");
    fetchMarketCatalog(controller.signal)
      .then((catalog) => {
        if (!isMounted) return;
        const catalogAge = ageMs(catalog.asOf);
        setMarketCatalog(catalog);
        setOutcomes(catalog.outcomes);
        setFetchState(catalog.complete === false || (catalogAge !== undefined && catalogAge > marketCatalogStaleAfterMs) ? "fallback" : "live");
      })
      .catch((error: unknown) => {
        if (!isMounted) return;
        setMarketCatalog(null);
        setOutcomes([]);
        setMarketError(error instanceof Error ? error.message : "Live market catalog unavailable.");
        setFetchState("error");
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [marketRefreshKey]);

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
  }, [accountRefreshKey, auth?.enabled, auth?.authenticated, auth?.walletSynced, auth?.getAccessToken]);

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

  const categories = useMemo(() => {
    const present = new Set(marketRows.map((row) => row.category || "General"));
    const ordered = categoryOrder.filter((item) => item === "All" || present.has(item));
    const rest = [...present].filter((item) => !ordered.includes(item)).sort();
    return [...ordered, ...rest];
  }, [marketRows]);

  const selectedByMarket = useMemo(() => {
    const selected = new Map<string, ParlayLeg>();
    for (const leg of legs) selected.set(leg.marketId, leg);
    return selected;
  }, [legs]);

  const coveredEventKeys = useMemo(() => {
    const covered = new Set<string>();
    for (const leg of legs) {
      const key = eventKey(leg.marketUrl);
      if (key) covered.add(key);
    }
    return covered;
  }, [legs]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const rows = marketRows
      .filter((row) => category === "All" || row.category === category)
      .filter((row) => !isEnded(row.endDate))
      .filter((row) => {
        const key = eventKey(row.marketUrl);
        return !key || !coveredEventKeys.has(key) || selectedByMarket.has(row.marketId);
      })
      .filter((row) => {
        if (!normalizedQuery) return true;
        return `${row.question} ${row.outcomes.map((outcome) => outcome.outcome).join(" ")} ${row.category}`
          .toLowerCase()
          .includes(normalizedQuery);
      });
    return sortMarketRows(rows, sortOrder).slice(0, marketDisplayLimit);
  }, [category, coveredEventKeys, marketRows, query, selectedByMarket, sortOrder]);
  const hasMarketFilters = query.trim().length > 0 || category !== "All";
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
  const canDraft = legs.length >= 2 && amount > 0 && risk.decision !== "reject" && walletReadyForCheckout;
  const canUseCheckoutAction = canDraft || (walletSyncFailed && hasBasketQuote);
  const payoutDisplay = !hasBasketQuote ? "—" : risk.decision === "reject" ? "Unavailable" : formatUsd(parlay.grossPayout);
  const mobilePayoutDisplay = hasBasketQuote ? `${payoutDisplay} potential` : "Add one more";
  const basketPriceDisplay = hasBasketQuote ? formatCents(parlay.impliedProbability || 0) : "—";
  const basketProbabilityDisplay = hasBasketQuote ? formatPercent(parlay.impliedProbability || 0) : "—";
  const quoteSpreadDisplay = hasBasketQuote ? formatPercent(parlay.houseEdge) : "—";
  const payoutMultipleDisplay = hasBasketQuote ? `${formatNumber(parlay.offeredDecimalOdds || 0)}x` : "—";
  const visibleRiskChecks = useMemo(() => {
    const priority = { block: 0, warn: 1, ok: 2 };
    return [...risk.checks].sort((a, b) => priority[a.level] - priority[b.level]).slice(0, 4);
  }, [risk.checks]);
  useEffect(() => {
    if (!hasBasketQuote) {
      lastPayoutRef.current = null;
      return;
    }
    if (lastPayoutRef.current === null) {
      lastPayoutRef.current = payoutDisplay;
      return;
    }
    if (lastPayoutRef.current !== payoutDisplay) {
      lastPayoutRef.current = payoutDisplay;
      setBurstKey((key) => key + 1);
    }
  }, [hasBasketQuote, payoutDisplay]);
  const checkoutLabel =
    !hasBasketQuote
      ? "Review basket"
      : auth?.enabled && !auth.authenticated
      ? "Connect wallet"
      : walletSyncFailed
      ? "Reconnect wallet"
      : !walletReadyForCheckout
      ? "Syncing wallet"
      : risk.decision === "reject"
      ? "Basket blocked"
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
    setPaymentModalOpen(false);
  }, [amount, legs]);

  useEffect(() => {
    if (stakeLimitKey === 0) return;
    setStakeLimitActive(true);
    const timeout = window.setTimeout(() => setStakeLimitActive(false), 1400);
    return () => window.clearTimeout(timeout);
  }, [stakeLimitKey]);

  function chooseOutcome(outcome: MarketOutcome) {
    setLegs((current) => {
      const outcomeEventKey = eventKey(outcome.marketUrl);
      const withoutMarket = current.filter((leg) => {
        if (leg.marketId === outcome.marketId) return false;
        return !(outcomeEventKey && eventKey(leg.marketUrl) === outcomeEventKey);
      });
      const existing = current.find((leg) => leg.id === outcome.id);
      if (existing) return withoutMarket;
      return [...withoutMarket, { ...outcome, addedAt: Date.now() }];
    });
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
      setPaymentState(intent.status === "confirmed" || intent.status === "activated" ? "pending" : "ready");
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
      const payload = await authedPostJson<ServerTicket | { status: "payment_pending"; paymentIntent?: ServerPaymentIntent; detail?: string }>(
        `/api/quotes/${quoteId}/payment-activate`,
        auth?.getAccessToken
      );
      if ("ticketId" in payload) {
        setServerTicket(payload);
        setServerTicketState("ready");
        setPaymentState("complete");
        setSelectedTicketId(payload.ticketId);
        setAccountRefreshKey((key) => key + 1);
        setActiveView("portfolio");
        return;
      }
      if (payload.paymentIntent) setPaymentIntent(payload.paymentIntent);
      setPaymentState("pending");
      setPaymentError(payload.detail || "Waiting for confirmed USDC payment.");
      setAccountRefreshKey((key) => key + 1);
    } catch (error) {
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

    setPaymentState("sending");
    setPaymentError("");
    let submittedTxHash = "";
    try {
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
        auth?.getAccessToken,
        { txHash }
      );
      setPaymentIntent(submitted);
      setPaymentState("pending");
      setAccountRefreshKey((key) => key + 1);
      await activatePaidQuote(submitted.quoteId);
    } catch (error) {
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
      setPaymentState("error");
      setPaymentError(error instanceof Error ? error.message : "LEGWORK could not continue activation.");
    }
  }

  function handleCheckout() {
    if (walletSyncFailed) {
      auth?.logout?.();
      return;
    }

    void preparePaymentReview();
  }

  function openPortfolioFromPayment() {
    setPaymentModalOpen(false);
    setActiveView("portfolio");
    setAccountRefreshKey((key) => key + 1);
  }

  const activeTickets = tickets.filter((ticket) => ticket.status === "accepted" || ticket.status === "live");
  const confirmingPayments = pendingPayments.filter((payment) => payment.status === "submitted" || payment.status === "confirmed");
  const activeBasketCount = activeTickets.length + confirmingPayments.length;
  const allBasketCount = tickets.length + confirmingPayments.length;
  const availableBalance = balanceFor(accountSummary, ["user_usdc_available"], "USDC");
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
          <span>Your portfolio will show active baskets, claimable winnings, and withdrawals once your wallet is connected.</span>
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
            Reconnect wallet
          </button>
        </div>
      );
    }

    return null;
  }

  function renderPaymentModal() {
    if (!paymentModalOpen) return null;
    const amountDue = paymentIntent ? formatUsd(paymentIntent.amountUsdc) : formatUsd(parlay.totalCost);
    const txHash = paymentTxHash || paymentIntent?.txHash || "";
    const explorerUrl = txHash ? txExplorerUrl(txHash, paymentIntent?.chainId) : "";
    const paymentNetwork = chainLabel(paymentIntent?.chainId || configuredSettlementChainId());
    const netProfit = Math.max(0, parlay.grossPayout - parlay.totalCost);
    const profitReturn = parlay.totalCost > 0 ? netProfit / parlay.totalCost : 0;
    const paymentBusy = paymentState === "loading" || paymentState === "sending" || paymentState === "activating";
    const canSend = Boolean(
      paymentIntent &&
        !txHash &&
        paymentState !== "loading" &&
        paymentState !== "sending" &&
        paymentState !== "activating" &&
        paymentState !== "pending" &&
        paymentState !== "complete"
    );
    const canContinueActivation = Boolean(paymentIntent && txHash && paymentState === "error");

    return (
      <div className="payment-modal-backdrop" role="presentation">
        <section className="payment-modal" role="dialog" aria-modal="true" aria-labelledby="payment-modal-title">
          <div className="payment-modal-header">
            <div>
              <span className="section-label">
                <ReceiptText size={16} />
                Review ticket
              </span>
              <h2 id="payment-modal-title">Buy this basket</h2>
            </div>
            <button
              className="icon-btn quiet"
              disabled={paymentState === "sending" || paymentState === "activating"}
              onClick={() => setPaymentModalOpen(false)}
              type="button"
              aria-label="Close payment review"
            >
              <X size={18} />
            </button>
          </div>

          <div className="payment-hero">
            <span>Total due</span>
            <strong>{amountDue}</strong>
            <small>Stake plus operation fees, paid in USDC on {paymentNetwork}.</small>
          </div>

          <div className="payment-leg-list">
            {legs.map((leg) => (
              <div className="payment-leg" key={leg.id}>
                <span>{leg.outcome} · {formatCents(leg.price)}</span>
                <strong>{leg.question}</strong>
              </div>
            ))}
          </div>

          <div className="payment-grid">
            <div>
              <span>Potential payout</span>
              <strong>{payoutDisplay}</strong>
            </div>
            <div>
              <span>Basket price</span>
              <strong>{basketPriceDisplay}</strong>
            </div>
            <div>
              <span>Network</span>
              <strong>{paymentNetwork}</strong>
            </div>
            <div>
              <span>Profit return</span>
              <strong>+{formatPercent(profitReturn)}</strong>
            </div>
          </div>

          {paymentIntent ? (
            <div className="payment-addresses">
              <div>
                <span>Treasury</span>
                <strong>{compactId(paymentIntent.treasuryAddress)}</strong>
              </div>
              <div>
                <span>USDC contract</span>
                <strong>{compactId(paymentIntent.usdcContractAddress)}</strong>
              </div>
              <div>
                <span>Quote expires</span>
                <strong>{shortDateTime(paymentIntent.expiresAt)}</strong>
              </div>
            </div>
          ) : null}

          {txHash ? (
            <a className="payment-tx-link" href={explorerUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={15} />
              View transfer {compactId(txHash)}
            </a>
          ) : null}

          {paymentState === "pending" ? (
            <div className="payment-note pending">
              <span>{paymentError || "Waiting for the confirmed USDC transfer before activating this basket."}</span>
              <i className="payment-spinner" aria-hidden="true" />
            </div>
          ) : paymentError ? (
            <div className="payment-error">{paymentError}</div>
          ) : null}

          <div className="payment-actions">
            {paymentState === "pending" ? (
              <button className="checkout-btn" onClick={openPortfolioFromPayment} type="button">
                <LayoutDashboard size={18} />
                View Portfolio
              </button>
            ) : paymentState === "complete" ? (
              <button className="checkout-btn" onClick={() => setPaymentModalOpen(false)} type="button">
                Basket live
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

  function renderTicketDetailPanel() {
    const selectedSummary = tickets.find((ticket) => ticket.ticketId === selectedTicketId);
    const detailStatus = ticketDetail?.status || selectedSummary?.status;

    return (
      <section className="account-panel ticket-detail-panel">
        <div className="panel-title-row">
          <div>
            <span className="section-label">
              <ReceiptText size={16} />
              Ticket detail
            </span>
            <h2>{selectedSummary ? compactId(selectedSummary.ticketId) : "Select a basket"}</h2>
          </div>
          {detailStatus ? <em className={`status-pill ${statusTone(detailStatus)}`}>{statusLabel(detailStatus)}</em> : null}
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
                <span>Potential payout</span>
                <strong>{formatUsd(ticketDetail.potentialPayoutUsd)}</strong>
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
                    <small>{settlementDetailText(leg)}</small>
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
        </div>
        <em className="status-pill confirming">Confirming</em>
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
          <div className="inline-error">
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
                    <em className={`status-pill ${statusTone(ticket.status)}`}>{statusLabel(ticket.status)}</em>
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
                <button onClick={() => setActiveView("markets")} type="button">Browse markets</button>
              </div>
            )}
          </section>

          {renderTicketDetailPanel()}
        </div>

        <div className="activity-grid">
          <section className="account-panel">
            <div className="panel-title-row">
              <div>
                <span className="section-label">Tickets</span>
                <h2>All baskets</h2>
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
                      <strong>{formatUsd(ticket.potentialPayoutUsd || 0)} potential</strong>
                      <span>
                        {ticket.legs} leg{ticket.legs === 1 ? "" : "s"} · paid {formatUsd(ticket.amountPaidUsd || 0)} ·{" "}
                        {legProgressText(ticket) || shortDateTime(ticket.createdAt)}
                      </span>
                    </div>
                    <em className={`status-pill ${statusTone(ticket.status)}`}>{statusLabel(ticket.status)}</em>
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
                    </div>
                    <em className={`status-pill ${statusTone(withdrawal.status)}`}>{statusLabel(withdrawal.status)}</em>
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

  return (
    <main className="app-shell">
      {renderPaymentModal()}
      <header className="topbar">
        <div>
          <div className="brand-lockup">
            <Layers3 size={18} />
            <span>LEGWORK</span>
          </div>
          <p>Why win once when you can win big?</p>
        </div>
        <nav className="top-nav" aria-label="Primary">
          {(["markets", "portfolio"] as const).map((view) => (
            <button
              className={activeView === view ? "top-nav-btn active" : "top-nav-btn"}
              key={view}
              onClick={() => setActiveView(view)}
              type="button"
            >
              {view === "markets" ? "Markets" : "Portfolio"}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          {activeView === "markets" ? <strong className="market-count">{filteredRows.length} shown</strong> : null}
          {auth?.enabled ? (
            auth.authenticated ? (
              <button className="wallet-pill" onClick={auth.logout} type="button">
                {auth.userLabel || "Wallet connected"}
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
      <section className="quote-strip" aria-label="Quote summary">
        <div>
          <span>Markets</span>
          <strong>{legs.length}</strong>
        </div>
        <div>
          <span>Basket probability</span>
          <strong>{basketProbabilityDisplay}</strong>
        </div>
        <div>
          <span>Basket price</span>
          <strong>{basketPriceDisplay}</strong>
        </div>
        <div>
          <span>Potential payout</span>
          <strong>{payoutDisplay}</strong>
        </div>
        <div>
          <span>Amount due</span>
          <strong>{formatUsd(parlay.totalCost)}</strong>
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
              {categories.slice(0, 8).map((item) => (
                <button
                  type="button"
                  className={category === item ? "category-chip active" : "category-chip"}
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

          <div className="market-list">
            {filteredRows.map((row) => {
              const selected = selectedByMarket.get(row.marketId);
              return (
                <article
                  className={selected ? "market-card chosen" : "market-card"}
                  key={row.marketId}
                >
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
                      <a href={row.marketUrl} target="_blank" rel="noreferrer" className="market-source-link">
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
                        >
                          <span>{outcome.outcome}</span>
                          <strong>{formatCents(outcome.price)}</strong>
                        </button>
                      );
                    })}
                  </div>
                </article>
              );
            })}
            {filteredRows.length === 0 ? (
              <div className="empty-market-state">
                {fetchState === "loading" || fetchState === "idle" ? (
                  <div className="market-loading-orbit" aria-hidden="true" />
                ) : null}
                <strong>
                  {fetchState === "loading" || fetchState === "idle"
                    ? "Loading live Polymarket markets"
                    : hasMarketFilters
                      ? "No matches"
                      : "No live markets loaded"}
                </strong>
                <span>
                  {fetchState === "loading" || fetchState === "idle"
                    ? "LEGWORK only shows markets with a verified Polymarket source link."
                    : hasMarketFilters
                      ? "Clear the search or category filter to see more markets."
                      : marketError || "No unverified markets are shown. Try again once Polymarket data is available."}
                </span>
                {fetchState === "error" ? (
                  <button className="primary-inline-btn" onClick={() => setMarketRefreshKey((key) => key + 1)} type="button">
                    Retry markets
                  </button>
                ) : null}
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
              <span>Basket price</span>
              <strong>{basketPriceDisplay}</strong>
            </div>
            <div>
              <span>Quote spread</span>
              <strong>{quoteSpreadDisplay}</strong>
            </div>
            <div>
              <span>Operation fee</span>
              <strong>{formatUsd(parlay.operationFee)}</strong>
            </div>
            <div>
              <span>Payout multiple</span>
              <strong>{payoutMultipleDisplay}</strong>
            </div>
          </div>

          <div className="payout-callout" aria-live="polite">
            <span>Potential payout</span>
            <strong className="payout-value" key={`payout-${burstKey}`}>
              {payoutDisplay}
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
            <small>
              {legs.length < 2
                ? legs.length === 1
                  ? "Add one more market to unlock a basket quote."
                  : "Add two markets to unlock a basket quote."
                : risk.decision === "reject"
                  ? "This basket is outside launch risk limits, so LEGWORK will not quote a worse payout."
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

          {hasBasketQuote ? (
            <div className={`risk-panel ${risk.decision}`}>
            <div>
              <span>Risk engine</span>
              <strong>{risk.decision === "accept" ? "Acceptable" : risk.decision === "review" ? "Review quote" : "Blocked"}</strong>
            </div>
            <small>
              Quote spread: {formatPercent(risk.spreadBps / 10_000)} · Spread cap: {formatPercent(risk.maxSpreadBps / 10_000)}
            </small>
            {serverQuoteState === "ready" && activeServerQuote ? (
              <small className="server-quote-status">
                Server quote {activeServerQuote.status} · expires {new Date(activeServerQuote.expiresAt).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}
              </small>
            ) : null}
            {serverQuoteState === "error" ? <small className="server-quote-status error">{serverQuoteError}</small> : null}
            {serverTicketState === "ready" && serverTicket ? (
              <small className="server-quote-status">Ticket live · {serverTicket.ticketId.slice(0, 8)}</small>
            ) : null}
            {serverTicketState === "error" ? <small className="server-quote-status error">{serverTicketError}</small> : null}
            <div className="risk-check-list">
              {visibleRiskChecks.map((check) => (
                <span className={check.level} key={`${check.label}-${check.detail}`}>
                  {check.label}: {check.detail}
                </span>
              ))}
            </div>
          </div>
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
              <span>4. For launch, LEGWORK allows one pick per event group. Related markets disappear after you choose a side.</span>
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
              <span>Operation fee: {formatUsd(1)} per selected market</span>
              <span>Quote spread: {formatPercent(parlay.houseEdge)} on the basket quote</span>
              <span>Risk adjustment: correlation, liquidity, payout, and leg-count checks</span>
              <span>Amount due: {formatUsd(parlay.totalCost)}</span>
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
      ) : (
        renderPortfolio()
      )}

      {activeView === "markets" && mobileBasketOpen ? (
        <>
          <button className="mobile-sheet-backdrop" onClick={() => setMobileBasketOpen(false)} aria-label="Collapse basket" />
          <div className="mobile-basket-sheet" role="dialog" aria-label="Basket">
            <div className="mobile-sheet-handle">
              <div>
                <span>Basket</span>
                <strong className="mobile-payout-value" key={`sheet-${burstKey}`}>
                  {mobilePayoutDisplay}
                </strong>
              </div>
              <button onClick={() => setMobileBasketOpen(false)} aria-label="Collapse basket">
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
                <strong>{formatUsd(parlay.totalCost)} due</strong>
              </div>
              {serverQuoteState === "ready" && activeServerQuote ? (
                <small className="server-quote-status mobile-status">
                  Server quote {activeServerQuote.status} · expires {new Date(activeServerQuote.expiresAt).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}
                </small>
              ) : null}
              {serverQuoteState === "error" ? <small className="server-quote-status error mobile-status">{serverQuoteError}</small> : null}
              {serverTicketState === "ready" && serverTicket ? (
                <small className="server-quote-status mobile-status">Ticket saved · {serverTicket.ticketId.slice(0, 8)}</small>
              ) : null}
              {serverTicketState === "error" ? <small className="server-quote-status error mobile-status">{serverTicketError}</small> : null}
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
      <button className="mobile-basket-bar" onClick={() => setMobileBasketOpen(true)} aria-expanded={mobileBasketOpen}>
        <div>
          <span>{legs.length} markets</span>
          <strong className="mobile-payout-value" key={`bar-${burstKey}`}>
            {mobilePayoutDisplay}
          </strong>
        </div>
        <span className={canDraft ? "mobile-review ready" : "mobile-review"}>{risk.decision === "reject" ? "Blocked" : "Review"}</span>
      </button>
      ) : null}
    </main>
  );
}

function WalletCardIcon() {
  return <Banknote size={28} />;
}

function AccountSkeleton({ rows }: { rows: number }) {
  return (
    <div className="account-list">
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
