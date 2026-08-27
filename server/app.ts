import { createHash } from "node:crypto";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimitPlugin from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { constantTimeEqual, requireUserId, syncPrivyIdentityToken } from "./auth";
import { config } from "./config";
import { getAccountSummary } from "./db/accountRepository";
import { checkDatabase } from "./db/client";
import { exposureChecksForQuote, listOpenMarketExposure } from "./db/exposureRepository";
import { completeIdempotencyKey, reserveIdempotencyKey } from "./db/idempotencyRepository";
import { getPersistedMarketCatalogPage, getPersistedMarketOutcomesByIds } from "./db/marketRepository";
import {
  createQuotePaymentIntent,
  getQuotePaymentIntent,
  listPendingQuotePayments,
  markQuotePaymentActivated,
  submitQuotePaymentTransaction,
  type QuotePaymentIntent,
  type TreasuryPaymentConfig
} from "./db/paymentIntentRepository";
import { getPersistedQuote, persistQuote } from "./db/quoteRepository";
import { getLatestReconciliationSnapshot } from "./db/reconciliationRepository";
import { listOpenSettlementOperationalAlerts } from "./db/settlementAlertRepository";
import { claimTicketToAvailable, listPendingSettlementLegs, listSettlementProofs, recordLegSettlement } from "./db/settlementRepository";
import { approveTreasuryConfigChange, getActiveTreasuryConfig, proposeTreasuryConfigChange } from "./db/treasuryRepository";
import { acceptQuote, getTicket, listClaimableTickets, listTickets, parseClaimableTicketsCursor } from "./db/ticketRepository";
import { listUserWallets } from "./db/userRepository";
import {
  buildAndPersistSafeWithdrawalProposal,
  cancelWithdrawalRequest,
  createWithdrawalRequest,
  listWithdrawalRequests,
  markWithdrawalSent,
  parseUsdcMicroUnitsExact
} from "./db/withdrawalRepository";
import {
  assertFinancialWorkersHealthy,
  getWorkerHeartbeatHealth,
  REQUIRED_RUNTIME_WORKERS,
  type WorkerHeartbeatHealth
} from "./db/workerHeartbeatRepository";
import { assertFinancialGateOpen, getFinancialGateDecision } from "./financialGate";
import { getMarketCatalog, type MarketCatalogGroup, type MarketCatalogPage, type MarketCatalogQuery } from "./marketCatalog";
import { annotateCatalogOutcomes, marketEligibilityConfigFromEnv } from "./marketTaxonomy";
import { activateConfirmedQuotePayment } from "./paymentActivation";
import { applyAdditionalRiskChecks, createQuote, getStoredQuote, quoteRequestSchema } from "./quoteService";
import { createRateLimitOptions } from "./rateLimit";
import { checkRedis } from "./redisHealth";
import { hydrateOutcomesWithOrderBooks } from "../src/marketData";

type AppDependencies = {
  serveFrontend?: boolean;
  frontendRoot?: string;
  getMarketCatalog?: typeof getMarketCatalog;
  getPersistedMarketCatalogPage?: typeof getPersistedMarketCatalogPage;
  getPersistedMarketOutcomesByIds?: typeof getPersistedMarketOutcomesByIds;
  persistQuote?: typeof persistQuote;
  getPersistedQuote?: typeof getPersistedQuote;
  acceptQuote?: typeof acceptQuote;
  getTicket?: typeof getTicket;
  listTickets?: typeof listTickets;
  listClaimableTickets?: typeof listClaimableTickets;
  listOpenMarketExposure?: typeof listOpenMarketExposure;
  exposureChecksForQuote?: typeof exposureChecksForQuote;
  listPendingSettlementLegs?: typeof listPendingSettlementLegs;
  listOpenSettlementOperationalAlerts?: typeof listOpenSettlementOperationalAlerts;
  listSettlementProofs?: typeof listSettlementProofs;
  recordLegSettlement?: typeof recordLegSettlement;
  claimTicketToAvailable?: typeof claimTicketToAvailable;
  reserveIdempotencyKey?: typeof reserveIdempotencyKey;
  completeIdempotencyKey?: typeof completeIdempotencyKey;
  hydrateQuoteOutcomes?: typeof hydrateOutcomesWithOrderBooks;
  getAccountSummary?: typeof getAccountSummary;
  listUserWallets?: typeof listUserWallets;
  syncPrivyIdentityToken?: typeof syncPrivyIdentityToken;
  getActiveTreasuryConfig?: typeof getActiveTreasuryConfig;
  proposeTreasuryConfigChange?: typeof proposeTreasuryConfigChange;
  approveTreasuryConfigChange?: typeof approveTreasuryConfigChange;
  createWithdrawalRequest?: typeof createWithdrawalRequest;
  cancelWithdrawalRequest?: typeof cancelWithdrawalRequest;
  listWithdrawalRequests?: typeof listWithdrawalRequests;
  markWithdrawalSent?: typeof markWithdrawalSent;
  buildAndPersistSafeWithdrawalProposal?: typeof buildAndPersistSafeWithdrawalProposal;
  getFinancialGateDecision?: typeof getFinancialGateDecision;
  getLatestReconciliationSnapshot?: typeof getLatestReconciliationSnapshot;
  createQuotePaymentIntent?: typeof createQuotePaymentIntent;
  getQuotePaymentIntent?: typeof getQuotePaymentIntent;
  listPendingQuotePayments?: typeof listPendingQuotePayments;
  submitQuotePaymentTransaction?: typeof submitQuotePaymentTransaction;
  markQuotePaymentActivated?: typeof markQuotePaymentActivated;
  assertFinancialGateOpen?: typeof assertFinancialGateOpen;
  assertFinancialWorkersHealthy?: typeof assertFinancialWorkersHealthy;
  getWorkerHeartbeatHealth?: typeof getWorkerHeartbeatHealth;
};

const marketCatalogQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(48),
  search: z.string().trim().max(120).optional(),
  category: z
    .enum([
      "Politics",
      "Sports",
      "Crypto",
      "Finance and Economy",
      "Technology and Science",
      "Culture and Entertainment",
      "World and Weather",
      "Other"
    ])
    .optional(),
  sort: z.enum(["volume", "liquidity", "ending_soon", "newest"]).default("volume"),
  eventGroupKey: z.string().trim().max(256).optional()
});

const claimableTicketsQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const routeRateLimits = {
  authSync: { max: 8, timeWindow: "1 minute" },
  quoteCreation: { max: 20, timeWindow: "1 minute" },
  payment: { max: 10, timeWindow: "1 minute" },
  portfolioRead: { max: 30, timeWindow: "1 minute" },
  claim: { max: 8, timeWindow: "1 minute" },
  withdrawal: { max: 5, timeWindow: "1 minute" },
  ops: { max: 30, timeWindow: "1 minute" }
} as const;

const MAX_MARKET_PAGE_FILL_ATTEMPTS = 4;
const PUBLIC_MARKET_MIN_PRICE = 0.01;
const PUBLIC_MARKET_MAX_PRICE = 0.99;

function hasOpsAccess(authorization?: string) {
  if (!config.OPS_API_KEY) {
    return config.NODE_ENV === "test";
  }

  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  return constantTimeEqual(token, config.OPS_API_KEY);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function requestHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseOperatorId(value: string | string[] | undefined) {
  const operatorId = headerValue(value)?.trim();
  if (!operatorId) return undefined;
  if (operatorId.length < 3 || operatorId.length > 80 || !/^[A-Za-z0-9._@:-]+$/.test(operatorId)) {
    return null;
  }

  return operatorId;
}

function parseIdempotencyKey(value: string | string[] | undefined) {
  const key = headerValue(value)?.trim();
  if (!key) return undefined;
  if (key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    return null;
  }

  return key;
}

function paymentErrorResponse(message: string, paymentIntent?: QuotePaymentIntent) {
  if (message.startsWith("payment_intent_recoverable:")) {
    const reason = message.slice("payment_intent_recoverable:".length) || paymentIntent?.recoveryReason || "activation_failed";
    return {
      status: 409,
      body: {
        status: "recoverable" as const,
        error: "payment_intent_recoverable" as const,
        reason,
        ...(paymentIntent ? { paymentIntent } : {})
      }
    };
  }
  if (message === "quote_not_found" || message === "payment_intent_not_found") {
    return { status: 404, body: { error: message } };
  }
  if (
    message === "quote_expired" ||
    message === "payment_intent_expired" ||
    message === "payment_intent_not_submittable" ||
    message === "payment_intent_tx_hash_conflict" ||
    message.startsWith("quote_not_payable")
  ) {
    return { status: 409, body: { error: message.split(":")[0], detail: message } };
  }
  if (message === "invalid_tx_hash" || message === "invalid_evm_address" || message.startsWith("quote_requires_review")) {
    return { status: 422, body: { error: message.split(":")[0], detail: message } };
  }
  if (message.startsWith("quote_exposure_limit") || message === "insufficient_house_reserve" || message === "payment_intent_not_confirmed") {
    return { status: 409, body: { error: message.split(":")[0], detail: message } };
  }
  if (message === "insufficient_user_balance") {
    return {
      status: 202,
      body: {
        status: "payment_pending",
        error: "payment_not_confirmed",
        detail: "LEGWORK is waiting for the confirmed USDC transfer before activating this basket."
      }
    };
  }
  return undefined;
}

function publicCatalogWithFreshBooks(catalog: MarketCatalogPage, refreshedOutcomes: MarketCatalogPage["outcomes"], now = new Date()) {
  const annotatedOutcomes = annotateCatalogOutcomes(refreshedOutcomes, {
    now,
    eligibilityConfig: {
      ...marketEligibilityConfigFromEnv(),
      requireOrderBook: true
    }
  });
  const marketState = new Map<string, { total: number; eligible: number; blocked: boolean }>();

  for (const outcome of annotatedOutcomes) {
    const state = marketState.get(outcome.marketId) || { total: 0, eligible: 0, blocked: false };
    const executablePrice = outcome.executablePrice ?? outcome.price;
    state.total += 1;
    if (outcome.eligibility?.eligible !== false) state.eligible += 1;
    if (
      outcome.eligibility?.eligible === false ||
      !Number.isFinite(executablePrice) ||
      executablePrice <= PUBLIC_MARKET_MIN_PRICE ||
      executablePrice >= PUBLIC_MARKET_MAX_PRICE
    ) {
      state.blocked = true;
    }
    marketState.set(outcome.marketId, state);
  }

  const outcomes = annotatedOutcomes.filter((outcome) => {
    const state = marketState.get(outcome.marketId);
    return Boolean(state && !state.blocked && state.total >= 2 && state.eligible === state.total);
  });
  const groupsByKey = new Map<string, MarketCatalogGroup & { marketIds: Set<string> }>();

  for (const outcome of outcomes) {
    if (!outcome.eventGroupKey) continue;
    const current = groupsByKey.get(outcome.eventGroupKey) || {
      eventGroupKey: outcome.eventGroupKey,
      eventTitle: outcome.eventTitle,
      eventSlug: outcome.eventSlug,
      category: outcome.category,
      marketCount: 0,
      outcomeCount: 0,
      marketIds: new Set<string>()
    };
    current.marketIds.add(outcome.marketId);
    current.marketCount = current.marketIds.size;
    current.outcomeCount += 1;
    groupsByKey.set(outcome.eventGroupKey, current);
  }

  return {
    ...catalog,
    outcomes,
    groups: [...groupsByKey.values()].map(({ marketIds: _marketIds, ...group }) => group)
  };
}

export function buildApp(dependencies: AppDependencies = {}) {
  const loadMarketCatalog = dependencies.getMarketCatalog || getMarketCatalog;
  const loadPersistedMarketCatalogPage = dependencies.getPersistedMarketCatalogPage || getPersistedMarketCatalogPage;
  const loadPersistedMarketOutcomesByIds = dependencies.getPersistedMarketOutcomesByIds || getPersistedMarketOutcomesByIds;
  const storeQuote = dependencies.persistQuote || persistQuote;
  const loadPersistedQuote = dependencies.getPersistedQuote || getPersistedQuote;
  const acceptStoredQuote = dependencies.acceptQuote || acceptQuote;
  const loadTicket = dependencies.getTicket || getTicket;
  const loadTickets = dependencies.listTickets || listTickets;
  const loadClaimableTickets = dependencies.listClaimableTickets || listClaimableTickets;
  const loadOpenMarketExposure = dependencies.listOpenMarketExposure || listOpenMarketExposure;
  const checkQuoteExposure = dependencies.exposureChecksForQuote || exposureChecksForQuote;
  const loadPendingSettlementLegs = dependencies.listPendingSettlementLegs || listPendingSettlementLegs;
  const loadSettlementProofs = dependencies.listSettlementProofs || listSettlementProofs;
  const settleTicketLeg = dependencies.recordLegSettlement || recordLegSettlement;
  const claimTicket = dependencies.claimTicketToAvailable || claimTicketToAvailable;
  const reserveKey = dependencies.reserveIdempotencyKey || reserveIdempotencyKey;
  const completeKey = dependencies.completeIdempotencyKey || completeIdempotencyKey;
  const refreshQuoteOutcomes = dependencies.hydrateQuoteOutcomes || hydrateOutcomesWithOrderBooks;
  const loadAccountSummary = dependencies.getAccountSummary || getAccountSummary;
  const loadUserWallets = dependencies.listUserWallets || listUserWallets;
  const syncIdentityToken = dependencies.syncPrivyIdentityToken || syncPrivyIdentityToken;
  const loadActiveTreasuryConfig = dependencies.getActiveTreasuryConfig || getActiveTreasuryConfig;
  const proposeTreasuryChange = dependencies.proposeTreasuryConfigChange || proposeTreasuryConfigChange;
  const approveTreasuryChange = dependencies.approveTreasuryConfigChange || approveTreasuryConfigChange;
  const requestWithdrawal = dependencies.createWithdrawalRequest || createWithdrawalRequest;
  const cancelWithdrawal = dependencies.cancelWithdrawalRequest || cancelWithdrawalRequest;
  const loadWithdrawalRequests = dependencies.listWithdrawalRequests || listWithdrawalRequests;
  const setWithdrawalSent = dependencies.markWithdrawalSent || markWithdrawalSent;
  const proposeSafeWithdrawal = dependencies.buildAndPersistSafeWithdrawalProposal || buildAndPersistSafeWithdrawalProposal;
  const loadFinancialGateDecision = dependencies.getFinancialGateDecision || getFinancialGateDecision;
  const createPaymentIntent = dependencies.createQuotePaymentIntent || createQuotePaymentIntent;
  const loadPaymentIntent = dependencies.getQuotePaymentIntent || getQuotePaymentIntent;
  const loadPendingQuotePayments = dependencies.listPendingQuotePayments || listPendingQuotePayments;
  const submitPaymentTransaction = dependencies.submitQuotePaymentTransaction || submitQuotePaymentTransaction;
  const activatePaymentIntent = dependencies.markQuotePaymentActivated || markQuotePaymentActivated;
  const assertMoneyMovementAllowed = dependencies.assertFinancialGateOpen || assertFinancialGateOpen;
  const assertRequiredFinancialWorkersHealthy = dependencies.assertFinancialWorkersHealthy || assertFinancialWorkersHealthy;
  const loadWorkerHeartbeatHealth = dependencies.getWorkerHeartbeatHealth || getWorkerHeartbeatHealth;
  const idempotencyEnabled = Boolean(config.DATABASE_URL && config.NODE_ENV !== "test") || Boolean(dependencies.reserveIdempotencyKey);
  const rateLimitStore = createRateLimitOptions();
  const serveFrontend = dependencies.serveFrontend ?? config.NODE_ENV === "production";
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: config.NODE_ENV === "test" ? false : { level: config.NODE_ENV === "production" ? "info" : "debug" }
  });

  app.register(cors, {
    origin: config.WEB_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"]
  });
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", "https:", "wss:"],
        fontSrc: ["'self'", "data:", "https:"],
        formAction: ["'self'", "https:"],
        frameAncestors: ["'none'"],
        frameSrc: ["'self'", "https:"],
        imgSrc: ["'self'", "data:", "https:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'", "blob:"]
      }
    }
  });
  app.register(rateLimitPlugin, rateLimitStore.options);
  if (serveFrontend) {
    app.register(fastifyStatic, {
      root: dependencies.frontendRoot || resolve(process.cwd(), "dist"),
      index: false,
      wildcard: false,
      setHeaders(reply, filePath) {
        reply.header("Cache-Control", filePath.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      }
    });
  }
  app.addHook("onClose", async () => {
    if (rateLimitStore.redis) {
      await rateLimitStore.redis.quit();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: "validation_error",
        issues: error.issues
      });
      return;
    }

    const httpError = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : undefined;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send({
        error: typeof httpError.code === "string" ? httpError.code : "request_error",
        detail: typeof httpError.message === "string" ? httpError.message : "Request failed."
      });
      return;
    }

    app.log.error(error);
    reply.status(500).send({
      error: "internal_server_error"
    });
  });

  async function requireOpenFinancialGate(reply: FastifyReply, operation: string) {
    if (config.ACCOUNTING_MODE !== "house_book_usdc") return true;

    try {
      if (config.NODE_ENV === "production") {
        await assertRequiredFinancialWorkersHealthy({
          maxAgeMs: config.WORKER_HEARTBEAT_MAX_AGE_MS,
          successMaxAgeMs: config.WORKER_SUCCESS_MAX_AGE_MS
        });
      }
      await assertMoneyMovementAllowed({ operation });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "financial_gate_closed";
      reply.status(503).send({
        error: "financial_operations_unavailable",
        detail
      });
      return false;
    }
  }

  async function resolveTreasuryPaymentConfig(): Promise<TreasuryPaymentConfig | undefined> {
    if (config.NODE_ENV !== "production" && (config.DATABASE_URL || dependencies.getActiveTreasuryConfig)) {
      const dbConfig = await loadActiveTreasuryConfig(config.SETTLEMENT_CHAIN_ID, "USDC");
      if (dbConfig) {
        return {
          chainId: dbConfig.chainId,
          treasuryAddress: dbConfig.treasuryAddress,
          usdcContractAddress: dbConfig.usdcContractAddress,
          requiredConfirmations: dbConfig.requiredConfirmations
        };
      }
    }

    if (!config.TREASURY_SAFE_ADDRESS) return undefined;
    return {
      chainId: config.SETTLEMENT_CHAIN_ID,
      treasuryAddress: config.TREASURY_SAFE_ADDRESS,
      usdcContractAddress: config.USDC_CONTRACT_ADDRESS,
      requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS
    };
  }

  app.after((error) => {
    if (error) throw error;

  app.get("/healthz", async () => ({
    ok: true,
    service: "legwork-api",
    time: new Date().toISOString()
  }));

  app.get("/readyz", async (_request, reply) => {
    let workerHealth: WorkerHeartbeatHealth | undefined;
    try {
      if (config.DATABASE_URL && config.NODE_ENV !== "test") {
        await checkDatabase();
      }

      if (config.RATE_LIMIT_BACKEND === "redis" && config.NODE_ENV !== "test") {
        await checkRedis();
      }

      if (config.NODE_ENV === "production") {
        workerHealth = await loadWorkerHeartbeatHealth(REQUIRED_RUNTIME_WORKERS, {
          maxAgeMs: config.WORKER_HEARTBEAT_MAX_AGE_MS,
          successMaxAgeMs: config.WORKER_SUCCESS_MAX_AGE_MS
        });
        if (!workerHealth.healthy) {
          reply.status(503);
          return {
            ok: false,
            error: "required_workers_unhealthy",
            workers: workerHealth.workers
          };
        }
      }

      return reply.send({
        ok: true,
        database: config.DATABASE_URL ? (config.NODE_ENV === "test" ? "skipped" : "connected") : "not_configured",
        redis: config.RATE_LIMIT_BACKEND === "redis" ? (config.NODE_ENV === "test" ? "skipped" : "connected") : "not_required",
        ...(workerHealth ? { workers: workerHealth.workers } : {}),
        time: new Date().toISOString()
      });
    } catch (error) {
      _request.log.error(error);
      reply.status(503);
      return {
        ok: false,
        error: "service_dependencies_unavailable"
      };
    }
  });

  app.get("/api/markets", async (request, reply) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.MARKET_FETCH_TIMEOUT_MS);

    try {
      const parsed = marketCatalogQuerySchema.parse(request.query);
      const query: MarketCatalogQuery = {
        cursor: parsed.cursor,
        limit: parsed.limit,
        search: parsed.search || undefined,
        category: parsed.category,
        sort: parsed.sort,
        eventGroupKey: parsed.eventGroupKey || undefined
      };
      const usePersistedCatalog = Boolean(dependencies.getPersistedMarketCatalogPage) || Boolean(config.DATABASE_URL && config.NODE_ENV !== "test");
      const shouldRefreshPersistedPage = usePersistedCatalog && (config.NODE_ENV !== "test" || Boolean(dependencies.hydrateQuoteOutcomes));
      let catalog: Awaited<ReturnType<typeof loadMarketCatalog>> | MarketCatalogPage;

      if (shouldRefreshPersistedPage) {
        const requestedLimit = query.limit || 48;
        const publicOutcomes: MarketCatalogPage["outcomes"] = [];
        const publicMarketIds = new Set<string>();
        let cursor = query.cursor;
        let lastCandidatePage: MarketCatalogPage | undefined;

        for (let attempt = 0; attempt < MAX_MARKET_PAGE_FILL_ATTEMPTS; attempt += 1) {
          const remaining = requestedLimit - publicMarketIds.size;
          if (remaining <= 0) break;

          const candidatePage = await loadPersistedMarketCatalogPage({
            ...query,
            cursor,
            limit: remaining,
            requireFreshOrderBook: false,
            maxSnapshotAgeMs: config.MARKET_CATALOG_HARD_MAX_AGE_MS
          });
          lastCandidatePage = candidatePage;

          if (candidatePage.outcomes.length > 0) {
            const refreshed = await refreshQuoteOutcomes(candidatePage.outcomes, controller.signal, {
              requestedNotionalUsd: 25,
              retainUnexecutable: true,
              requireExplicitLifecycle: true
            });
            if (!refreshed.complete) {
              reply.status(503);
              return {
                error: "market_prices_unavailable",
                detail: "LEGWORK could not verify current Polymarket order books for this market page."
              };
            }

            const publicPage = publicCatalogWithFreshBooks(candidatePage, refreshed.outcomes);
            for (const outcome of publicPage.outcomes) {
              publicOutcomes.push(outcome);
              publicMarketIds.add(outcome.marketId);
            }
          }

          cursor = candidatePage.pageInfo.nextCursor;
          if (!candidatePage.pageInfo.hasMore || !cursor) break;
        }

        if (!lastCandidatePage) {
          throw new Error("No persisted market catalog page was returned");
        }

        const publicCatalog = publicCatalogWithFreshBooks(lastCandidatePage, publicOutcomes);
        publicCatalog.nextCursor = lastCandidatePage.pageInfo.nextCursor;
        publicCatalog.pageInfo = {
          ...lastCandidatePage.pageInfo,
          limit: requestedLimit,
          offset: 0,
          total: undefined
        };
        catalog = publicCatalog;
      } else {
        catalog = usePersistedCatalog
          ? await loadPersistedMarketCatalogPage(query)
          : await loadMarketCatalog(config.MARKET_CACHE_TTL_MS, controller.signal);
      }
      reply.header("cache-control", "private, max-age=30, stale-while-revalidate=30");
      return catalog;
    } catch (error) {
      const message = error instanceof Error ? error.message : "market_catalog_unavailable";
      if (message === "market_catalog_cursor_invalid" || message === "market_catalog_cursor_scope_mismatch") {
        reply.status(400);
        return { error: message };
      }
      if (
        message === "market_catalog_stale" ||
        message.startsWith("No persisted market catalog") ||
        message.startsWith("No public persisted market catalog")
      ) {
        reply.status(503);
        return {
          error: "market_catalog_unavailable",
          detail: "LEGWORK is refreshing live Polymarket markets."
        };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/api/auth/session", async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.listUserWallets) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    return {
      userId,
      wallets: await loadUserWallets(userId),
      authProvider: config.PRIVY_APP_ID ? "privy" : "beta"
    };
  });

  app.post("/api/auth/privy/sync", { config: { rateLimit: routeRateLimits.authSync } }, async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.syncPrivyIdentityToken) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    const body = z
      .object({
        identityToken: z.string().min(20)
      })
      .parse(request.body);

    try {
      const synced = await syncIdentityToken(body.identityToken, userId);
      if (synced.userId !== userId) {
        reply.status(403);
        return {
          error: "identity_token_user_mismatch"
        };
      }

      return synced;
    } catch (error) {
      const message = error instanceof Error ? error.message : "privy_sync_failed";
      if (message === "wallet_already_linked") {
        reply.status(409);
        return {
          error: "wallet_already_linked"
        };
      }
      if (message === "identity_token_user_mismatch") {
        reply.status(403);
        return {
          error: "identity_token_user_mismatch"
        };
      }

      reply.status(401);
      return {
        error: "invalid_identity_token"
      };
    }
  });

  app.get("/api/account", async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.getAccountSummary) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    return await loadAccountSummary(userId);
  });

  app.get("/api/withdrawals", { config: { rateLimit: routeRateLimits.portfolioRead } }, async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.listWithdrawalRequests) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    return {
      withdrawals: await loadWithdrawalRequests(userId)
    };
  });

  app.post("/api/withdrawals", { config: { rateLimit: routeRateLimits.withdrawal } }, async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.createWithdrawalRequest) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    if (!(await requireOpenFinancialGate(reply, "withdrawal_request"))) return;

    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!key) {
      reply.status(400);
      return {
        error: key === null ? "invalid_idempotency_key" : "idempotency_key_required",
        detail: "Use 8-200 URL-safe characters for Idempotency-Key."
      };
    }

    const body = z
      .object({
        amountUsdc: z.string().regex(/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/),
        destinationAddress: z.string().min(1)
      })
      .parse(request.body);
    const amountMicroUnits = parseUsdcMicroUnitsExact(body.amountUsdc);
    if (amountMicroUnits > 25_000_000_000n) {
      reply.status(422);
      return { error: "withdrawal_amount_limit" };
    }

    try {
      reply.status(201);
      return await requestWithdrawal({
        userId,
        destinationAddress: body.destinationAddress,
        amountMicroUnits,
        chainId: config.SETTLEMENT_CHAIN_ID,
        idempotencyKey: key
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "withdrawal_failed";
      if (
        message === "invalid_evm_address" ||
        message === "invalid_withdrawal_amount" ||
        message === "destination_wallet_not_linked" ||
        message === "insufficient_user_balance"
      ) {
        reply.status(422);
        return {
          error: message
        };
      }

      throw error;
    }
  });

  app.post("/api/withdrawals/:id/cancel", { config: { rateLimit: routeRateLimits.withdrawal } }, async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.cancelWithdrawalRequest) {
      reply.status(503);
      return { error: "database_unavailable" };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const body = z
      .object({ reason: z.string().trim().min(1).max(500).optional() })
      .parse(request.body || {});

    try {
      return await cancelWithdrawal({
        withdrawalRequestId: params.id,
        actor: "user",
        userId,
        reason: body.reason
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "withdrawal_cancellation_failed";
      if (message === "withdrawal_not_found" || message === "withdrawal_not_owned") {
        reply.status(404);
        return { error: "withdrawal_not_found" };
      }
      if (
        message === "withdrawal_terminal_state" ||
        message === "withdrawal_onchain_execution_exists" ||
        message === "withdrawal_not_cancelable"
      ) {
        reply.status(409);
        return { error: "withdrawal_not_cancelable" };
      }
      if (message === "invalid_withdrawal_cancellation_reason") {
        reply.status(400);
        return { error: message };
      }
      throw error;
    }
  });

  app.post("/api/quotes", { config: { rateLimit: routeRateLimits.quoteCreation } }, async (request, reply) => {
    const quoteRequest = quoteRequestSchema.parse(request.body);
    const userId = await requireUserId(request, reply);
    if (!userId) return;

    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (key === null) {
      reply.status(400);
      return {
        error: "invalid_idempotency_key",
        detail: "Use 8-200 URL-safe characters for Idempotency-Key."
      };
    }

    if (key && idempotencyEnabled) {
      const reservation = await reserveKey({
        route: "POST /api/quotes",
        key,
        userScope: userId,
        requestHash: requestHash(quoteRequest)
      });

      if (reservation.kind === "replay") {
        reply.header("idempotency-replayed", "true");
        reply.status(reservation.responseStatus);
        return reservation.responseBody;
      }

      if (reservation.kind === "conflict") {
        reply.status(409);
        return {
          error: "idempotency_key_conflict",
          detail: "This Idempotency-Key was already used with a different request."
        };
      }

      if (reservation.kind === "processing") {
        reply.status(409);
        return {
          error: "idempotency_key_processing",
          detail: "This Idempotency-Key is already processing. Retry with the same request shortly."
        };
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.MARKET_FETCH_TIMEOUT_MS);

    try {
      const useExactPersistedOutcomes =
        Boolean(dependencies.getPersistedMarketOutcomesByIds) || Boolean(config.DATABASE_URL && config.NODE_ENV !== "test");
      const catalog = useExactPersistedOutcomes
        ? await loadPersistedMarketOutcomesByIds(
            quoteRequest.legs.map((leg) => leg.id),
            { maxSnapshotAgeMs: config.MARKET_CATALOG_HARD_MAX_AGE_MS }
          )
        : await loadMarketCatalog(config.MARKET_CACHE_TTL_MS, controller.signal);
      const catalogById = new Map(catalog.outcomes.map((outcome) => [outcome.id, outcome]));
      const selectedOutcomes = quoteRequest.legs.map((leg) => catalogById.get(leg.id));
      if (selectedOutcomes.some((outcome) => !outcome)) {
        throw new Error(`Unknown market outcome id: ${quoteRequest.legs.filter((leg, index) => !selectedOutcomes[index]).map((leg) => leg.id).join(", ")}`);
      }

      const shouldHydrateQuote = config.NODE_ENV !== "test" || Boolean(dependencies.hydrateQuoteOutcomes);
      const executable =
        shouldHydrateQuote && selectedOutcomes.length > 0
          ? await refreshQuoteOutcomes(selectedOutcomes as NonNullable<(typeof selectedOutcomes)[number]>[], controller.signal, {
              requestedNotionalUsd: quoteRequest.stakeUsd,
              requireExplicitLifecycle: true
            })
          : { outcomes: selectedOutcomes as NonNullable<(typeof selectedOutcomes)[number]>[], complete: true };
      if (!executable.complete || executable.outcomes.length !== selectedOutcomes.length) {
        const body = {
          error: "executable_price_unavailable",
          detail: "LEGWORK could not verify current executable Polymarket ask prices for every selected leg."
        };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes",
            key,
            userScope: userId,
            responseStatus: 503,
            responseBody: body
          });
        }
        reply.status(503);
        return body;
      }

      const hydratedById = new Map(executable.outcomes.map((outcome) => [outcome.id, outcome]));
      const quoteCatalog = {
        ...catalog,
        asOf: new Date(Math.min(...executable.outcomes.map((outcome) => new Date(outcome.sourceAsOf || catalog.asOf).getTime()))).toISOString(),
        outcomes: catalog.outcomes.map((outcome) => hydratedById.get(outcome.id) || outcome)
      };
      const initialQuote = createQuote(quoteRequest, quoteCatalog);
      const quote =
        config.DATABASE_URL && config.NODE_ENV !== "test"
          ? applyAdditionalRiskChecks(
              initialQuote,
              await checkQuoteExposure(initialQuote, {
                maxMarketLiabilityUsd: config.MAX_MARKET_LIABILITY_USD,
                maxEventLiabilityUsd: config.MAX_EVENT_LIABILITY_USD
              })
            )
          : initialQuote;
      if (config.DATABASE_URL && config.NODE_ENV !== "test") {
        await storeQuote(quote, userId);
      }
      const statusCode = quote.status === "rejected" ? 422 : 201;
      if (key && idempotencyEnabled) {
        await completeKey({
          route: "POST /api/quotes",
          key,
          userScope: userId,
          responseStatus: statusCode,
          responseBody: quote
        });
      }
      reply.status(statusCode);
      return quote;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown market outcome id:")) {
        const body = {
          error: "unknown_market_outcome",
          detail: error.message
        };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes",
            key,
            userScope: userId,
            responseStatus: 400,
            responseBody: body
          });
        }
        reply.status(400);
        return body;
      }
      if (error instanceof Error && error.name === "AbortError") {
        const body = {
          error: "quote_pricing_timeout",
          detail: "LEGWORK could not refresh executable prices quickly enough. Retry the quote in a moment."
        };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes",
            key,
            userScope: userId,
            responseStatus: 503,
            responseBody: body
          });
        }
        reply.status(503);
        return body;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/api/quotes/:id", async (request, reply) => {
    const userId = await requireUserId(request, reply);
    if (!userId) return;

    const params = request.params as { id?: string };
    const quote = params.id
      ? config.DATABASE_URL && config.NODE_ENV !== "test"
        ? (await loadPersistedQuote(params.id, userId)) || getStoredQuote(params.id)
        : getStoredQuote(params.id)
      : undefined;

    if (!quote) {
      reply.status(404);
      return {
        error: "quote_not_found"
      };
    }

    return quote;
  });

  app.post("/api/quotes/:id/payment-intent", { config: { rateLimit: routeRateLimits.payment } }, async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.createQuotePaymentIntent) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "quote_id_required"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    if (!(await requireOpenFinancialGate(reply, "payment_intent_create"))) return;

    const treasuryConfig = await resolveTreasuryPaymentConfig();
    if (!treasuryConfig) {
      reply.status(503);
      return {
        error: "treasury_unconfigured",
        detail: "LEGWORK cannot accept USDC basket purchases until the treasury address is configured."
      };
    }

    try {
      reply.status(201);
      return await createPaymentIntent({
        quoteId: params.id,
        userId,
        treasuryConfig
      });
    } catch (error) {
      const mapped = paymentErrorResponse(error instanceof Error ? error.message : "payment_intent_failed");
      if (mapped) {
        reply.status(mapped.status);
        return mapped.body;
      }
      throw error;
    }
  });

  app.get("/api/quotes/:id/payment-intent", async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.getQuotePaymentIntent) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "quote_id_required"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    const intent = await loadPaymentIntent(params.id, userId);
    if (!intent) {
      reply.status(404);
      return {
        error: "payment_intent_not_found"
      };
    }

    return intent;
  });

  app.get("/api/payment-intents", async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.listPendingQuotePayments) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    return {
      paymentIntents: await loadPendingQuotePayments(userId)
    };
  });

  app.post("/api/quotes/:id/payment-transaction", { config: { rateLimit: routeRateLimits.payment } }, async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.submitQuotePaymentTransaction) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "quote_id_required"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;
    const body = z
      .object({
        txHash: z.string().min(1)
      })
      .parse(request.body);

    try {
      return await submitPaymentTransaction({
        quoteId: params.id,
        userId,
        txHash: body.txHash
      });
    } catch (error) {
      const mapped = paymentErrorResponse(error instanceof Error ? error.message : "payment_transaction_failed");
      if (mapped) {
        reply.status(mapped.status);
        return mapped.body;
      }
      throw error;
    }
  });

  app.post("/api/quotes/:id/payment-activate", { config: { rateLimit: routeRateLimits.payment } }, async (request, reply) => {
    if (!config.DATABASE_URL && (!dependencies.getQuotePaymentIntent || !dependencies.acceptQuote || !dependencies.markQuotePaymentActivated)) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "quote_id_required"
      };
    }
    const quoteId = params.id;

    const userId = await requireUserId(request, reply);
    if (!userId) return;
    if (!(await requireOpenFinancialGate(reply, "ticket_activation"))) return;
    const intent = await loadPaymentIntent(quoteId, userId);
    if (!intent) {
      reply.status(404);
      return {
        error: "payment_intent_not_found"
      };
    }

    if (intent.status === "expired") {
      reply.status(409);
      return {
        error: "payment_intent_expired",
        detail: "payment_intent_expired"
      };
    }

    if (intent.status === "recoverable") {
      const mapped = paymentErrorResponse(`payment_intent_recoverable:${intent.recoveryReason || "activation_failed"}`, intent)!;
      reply.status(mapped.status);
      return mapped.body;
    }

    if (intent.status !== "confirmed" && intent.status !== "activated") {
      reply.status(202);
      return {
        status: "payment_pending",
        paymentIntent: intent,
        detail: "Waiting for the confirmed USDC transfer before activating this basket."
      };
    }

    if (intent.status === "activated" && intent.ticketId) {
      const ticket = await loadTicket(intent.ticketId, userId);
      if (ticket) {
        reply.status(200);
        return ticket;
      }
    }

    try {
      const useInjectedPaymentActivation =
        config.NODE_ENV === "test" && Boolean(dependencies.acceptQuote || dependencies.markQuotePaymentActivated);
      const ticket =
        useInjectedPaymentActivation
          ? await (async () => {
              const accepted = await acceptStoredQuote(quoteId, userId, {
                accountingMode: "house_book_usdc",
                currency: "USDC",
                maxUserLiabilityUsd: config.MAX_USER_LIABILITY_USD,
                maxMarketLiabilityUsd: config.MAX_MARKET_LIABILITY_USD,
                maxEventLiabilityUsd: config.MAX_EVENT_LIABILITY_USD
              });
              await activatePaymentIntent({
                quoteId,
                userId,
                ticketId: accepted.ticketId
              });
              return accepted;
            })()
          : await activateConfirmedQuotePayment({ quoteId, userId });
      reply.status(201);
      return ticket;
    } catch (error) {
      const message = error instanceof Error ? error.message : "payment_activation_failed";
      const currentIntent = await loadPaymentIntent(quoteId, userId).catch(() => undefined);
      const mapped =
        currentIntent?.status === "recoverable"
          ? paymentErrorResponse(`payment_intent_recoverable:${currentIntent.recoveryReason || "activation_failed"}`, currentIntent)
          : paymentErrorResponse(message);
      if (mapped) {
        reply.status(mapped.status);
        return mapped.body;
      }
      throw error;
    }
  });

  app.post("/api/quotes/:id/accept", async (request, reply) => {
    if (config.ACCOUNTING_MODE === "house_book_usdc") {
      reply.status(409);
      return {
        error: "payment_required",
        detail: "Real-money baskets must be activated through a confirmed USDC payment intent."
      };
    }

    if (!config.DATABASE_URL && !dependencies.acceptQuote) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "quote_id_required"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    const key = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (key === null) {
      reply.status(400);
      return {
        error: "invalid_idempotency_key",
        detail: "Use 8-200 URL-safe characters for Idempotency-Key."
      };
    }

    if (key && idempotencyEnabled) {
      const reservation = await reserveKey({
        route: "POST /api/quotes/:id/accept",
        key,
        userScope: userId,
        requestHash: requestHash({ quoteId: params.id })
      });

      if (reservation.kind === "replay") {
        reply.header("idempotency-replayed", "true");
        reply.status(reservation.responseStatus);
        return reservation.responseBody;
      }

      if (reservation.kind === "conflict") {
        reply.status(409);
        return {
          error: "idempotency_key_conflict",
          detail: "This Idempotency-Key was already used with a different request."
        };
      }

      if (reservation.kind === "processing") {
        reply.status(409);
        return {
          error: "idempotency_key_processing",
          detail: "This Idempotency-Key is already processing. Retry with the same request shortly."
        };
      }
    }

    try {
      const ticket = await acceptStoredQuote(params.id, userId, {
        accountingMode: config.ACCOUNTING_MODE,
        currency: config.LEDGER_CURRENCY,
        maxUserLiabilityUsd: config.MAX_USER_LIABILITY_USD,
        maxMarketLiabilityUsd: config.MAX_MARKET_LIABILITY_USD,
        maxEventLiabilityUsd: config.MAX_EVENT_LIABILITY_USD
      });
      if (key && idempotencyEnabled) {
        await completeKey({
          route: "POST /api/quotes/:id/accept",
          key,
          userScope: userId,
          responseStatus: 201,
          responseBody: ticket
        });
      }
      reply.status(201);
      return ticket;
    } catch (error) {
      const message = error instanceof Error ? error.message : "accept_failed";
      if (message === "quote_not_found") {
        const body = { error: "quote_not_found" };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes/:id/accept",
            key,
            userScope: userId,
            responseStatus: 404,
            responseBody: body
          });
        }
        reply.status(404);
        return body;
      }
      if (message === "quote_expired") {
        const body = { error: "quote_expired" };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes/:id/accept",
            key,
            userScope: userId,
            responseStatus: 409,
            responseBody: body
          });
        }
        reply.status(409);
        return body;
      }
      if (message.startsWith("quote_not_acceptable")) {
        const body = { error: "quote_not_acceptable", detail: message };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes/:id/accept",
            key,
            userScope: userId,
            responseStatus: 409,
            responseBody: body
          });
        }
        reply.status(409);
        return body;
      }
      if (message.startsWith("quote_exposure_limit")) {
        const body = {
          error: "quote_exposure_limit",
          detail: message
        };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes/:id/accept",
            key,
            userScope: userId,
            responseStatus: 409,
            responseBody: body
          });
        }
        reply.status(409);
        return body;
      }
      if (message === "insufficient_user_balance" || message === "insufficient_house_reserve") {
        const body = {
          error: message
        };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes/:id/accept",
            key,
            userScope: userId,
            responseStatus: 409,
            responseBody: body
          });
        }
        reply.status(409);
        return body;
      }
      if (message === "invalid_house_book_currency" || message.startsWith("quote_requires_review")) {
        const body = {
          error: message.startsWith("quote_requires_review") ? "quote_requires_review" : message,
          detail: message
        };
        if (key && idempotencyEnabled) {
          await completeKey({
            route: "POST /api/quotes/:id/accept",
            key,
            userScope: userId,
            responseStatus: 409,
            responseBody: body
          });
        }
        reply.status(409);
        return body;
      }
      throw error;
    }
  });

  app.get("/api/tickets", async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.listTickets) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    return {
      tickets: await loadTickets(userId)
    };
  });

  app.get("/api/tickets/claimable", { config: { rateLimit: routeRateLimits.portfolioRead } }, async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.listClaimableTickets) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const query = claimableTicketsQuerySchema.parse(request.query);
    if (query.cursor) {
      try {
        parseClaimableTicketsCursor(query.cursor);
      } catch {
        reply.status(400);
        return { error: "invalid_claimable_ticket_cursor" };
      }
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    return loadClaimableTickets(userId, query);
  });

  app.get("/api/tickets/:id", async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.getTicket) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "ticket_id_required"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    const ticket = await loadTicket(params.id, userId);
    if (!ticket) {
      reply.status(404);
      return {
        error: "ticket_not_found"
      };
    }

    return ticket;
  });

  app.post("/api/tickets/:id/claim", { config: { rateLimit: routeRateLimits.claim } }, async (request, reply) => {
    if (!config.DATABASE_URL && !dependencies.claimTicketToAvailable) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "ticket_id_required"
      };
    }

    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) {
      reply.status(idempotencyKey === null ? 400 : 428);
      return {
        error: idempotencyKey === null ? "invalid_idempotency_key" : "idempotency_key_required"
      };
    }

    const userId = await requireUserId(request, reply);
    if (!userId) return;

    try {
      const result = await claimTicket({
        ticketId: params.id,
        userId,
        idempotencyKey
      });
      reply.status(result.status === "claimed" ? 201 : 200);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "ticket_claim_failed";
      if (message === "ticket_not_found") {
        reply.status(404);
        return { error: message };
      }
      if (message === "ticket_not_claimable" || message === "settlement_claim_idempotency_conflict") {
        reply.status(409);
        return { error: message };
      }
      if (message === "insufficient_claimable_balance" || message === "ticket_claimable_amount_missing") {
        reply.status(503);
        return {
          error: "ticket_claim_unavailable",
          detail: message
        };
      }
      throw error;
    }
  });

  app.get("/api/ops/exposure", { config: { rateLimit: routeRateLimits.ops } }, async (_request, reply) => {
    if (!hasOpsAccess(_request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (!config.DATABASE_URL && !dependencies.listOpenMarketExposure) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    return {
      markets: await loadOpenMarketExposure()
    };
  });

  app.get("/api/ops/treasury/config", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (config.NODE_ENV === "production" || (!config.DATABASE_URL && !dependencies.getActiveTreasuryConfig)) {
      return {
        config: config.TREASURY_SAFE_ADDRESS
          ? {
              chainId: config.SETTLEMENT_CHAIN_ID,
              currency: "USDC",
              treasuryAddress: config.TREASURY_SAFE_ADDRESS,
              usdcContractAddress: config.USDC_CONTRACT_ADDRESS,
              requiredConfirmations: config.USDC_REQUIRED_CONFIRMATIONS,
              source: "env"
            }
          : null
      };
    }

    return {
      config: (await loadActiveTreasuryConfig(config.SETTLEMENT_CHAIN_ID, "USDC")) || null
    };
  });

  app.post("/api/ops/treasury/config", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (config.NODE_ENV === "production") {
      reply.status(404);
      return {
        error: "treasury_config_mutation_disabled",
        detail: "Staging treasury configuration is static and can only be changed through a reviewed deployment."
      };
    }

    if (!config.DATABASE_URL && !dependencies.proposeTreasuryConfigChange) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const operatorId = parseOperatorId(request.headers["x-operator-id"]);
    if (!operatorId) {
      reply.status(400);
      return {
        error: "operator_id_required",
        detail: "Set X-Operator-Id to a stable operator identifier for treasury changes."
      };
    }

    const body = z
      .object({
        treasuryAddress: z.string().min(1),
        usdcContractAddress: z.string().min(1).optional(),
        requiredConfirmations: z.number().int().positive().max(128).optional(),
        reason: z.string().min(8).max(500)
      })
      .parse(request.body);

    try {
      const change = await proposeTreasuryChange({
        chainId: config.SETTLEMENT_CHAIN_ID,
        currency: "USDC",
        treasuryAddress: body.treasuryAddress,
        usdcContractAddress: body.usdcContractAddress || config.USDC_CONTRACT_ADDRESS,
        requiredConfirmations: body.requiredConfirmations || config.USDC_REQUIRED_CONFIRMATIONS,
        requestedBy: operatorId,
        reason: body.reason
      });
      reply.status(202);
      return {
        ...change,
        detail: "Treasury config change is pending second-operator approval."
      };
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_evm_address") {
        reply.status(400);
        return {
          error: "invalid_evm_address"
        };
      }

      throw error;
    }
  });

  app.post("/api/ops/treasury/config/:id/approve", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (config.NODE_ENV === "production") {
      reply.status(404);
      return {
        error: "treasury_config_mutation_disabled",
        detail: "Staging treasury configuration is static and can only be changed through a reviewed deployment."
      };
    }

    if (!config.DATABASE_URL && !dependencies.approveTreasuryConfigChange) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const operatorId = parseOperatorId(request.headers["x-operator-id"]);
    if (!operatorId) {
      reply.status(400);
      return {
        error: "operator_id_required",
        detail: "Set X-Operator-Id to a stable operator identifier for treasury approvals."
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "treasury_change_id_required"
      };
    }

    const body = z
      .object({
        reason: z.string().min(8).max(500).optional()
      })
      .parse(request.body || {});

    try {
      return await approveTreasuryChange({
        id: params.id,
        approvedBy: operatorId,
        reason: body.reason
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "treasury_approval_failed";
      if (message === "treasury_change_not_found") {
        reply.status(404);
        return {
          error: message
        };
      }
      if (message === "treasury_change_not_pending" || message === "treasury_change_second_approval_required") {
        reply.status(409);
        return {
          error: message
        };
      }

      throw error;
    }
  });

  app.get("/api/ops/financial-gate", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (!config.DATABASE_URL && !dependencies.getFinancialGateDecision) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    return {
      gate: await loadFinancialGateDecision({})
    };
  });

  app.get("/api/ops/reconciliation/latest", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return { error: "unauthorized" };
    }
    if (!config.DATABASE_URL && !dependencies.getLatestReconciliationSnapshot) {
      reply.status(503);
      return { error: "database_unavailable" };
    }

    const snapshot = await (dependencies.getLatestReconciliationSnapshot || getLatestReconciliationSnapshot)();
    if (!snapshot) {
      reply.status(404);
      return { error: "reconciliation_snapshot_not_found" };
    }
    return { snapshot };
  });

  app.post("/api/ops/withdrawals/:id/propose", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (!config.DATABASE_URL && !dependencies.buildAndPersistSafeWithdrawalProposal) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const operatorId = parseOperatorId(request.headers["x-operator-id"]);
    if (!operatorId) {
      reply.status(operatorId === null ? 400 : 401);
      return {
        error: operatorId === null ? "invalid_operator_id" : "operator_id_required"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "withdrawal_id_required"
      };
    }

    if (!(await requireOpenFinancialGate(reply, "withdrawal_safe_propose"))) return;

    try {
      reply.status(201);
      return await proposeSafeWithdrawal({
        withdrawalRequestId: params.id,
        operatorId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "withdrawal_proposal_failed";
      if (message === "withdrawal_not_found") {
        reply.status(404);
        return { error: message };
      }
      if (
        message === "withdrawal_not_requested" ||
        message === "withdrawal_request_hash_mismatch" ||
        message === "active_treasury_config_missing"
      ) {
        reply.status(409);
        return { error: message };
      }
      if (message === "invalid_evm_address" || message === "invalid_withdrawal_amount") {
        reply.status(422);
        return { error: message };
      }
      throw error;
    }
  });

  app.post("/api/ops/withdrawals/:id/mark-sent", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (!config.DATABASE_URL && !dependencies.markWithdrawalSent) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const operatorId = parseOperatorId(request.headers["x-operator-id"]);
    if (!operatorId) {
      reply.status(400);
      return {
        error: "operator_id_required",
        detail: "Set X-Operator-Id to a stable operator identifier for withdrawal operations."
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "withdrawal_id_required"
      };
    }

    const body = z
      .object({
        onchainTxHash: z.string().min(66).max(66)
      })
      .parse(request.body);

    try {
      return await setWithdrawalSent({
        id: params.id,
        operatorId,
        onchainTxHash: body.onchainTxHash
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "withdrawal_mark_sent_failed";
      if (message === "withdrawal_not_found") {
        reply.status(404);
        return {
          error: message
        };
      }
      if (
        message === "withdrawal_not_pending" ||
        message === "invalid_tx_hash" ||
        message === "withdrawal_tx_hash_conflict" ||
        message === "withdrawal_tx_not_found" ||
        message === "withdrawal_tx_failed" ||
        message === "withdrawal_tx_transfer_mismatch" ||
        message === "active_treasury_config_missing" ||
        message === "withdrawal_not_proposed" ||
        message === "withdrawal_safe_proposal_missing" ||
        message === "withdrawal_safe_proposal_mismatch" ||
        message === "withdrawal_tx_uncanonical" ||
        message === "withdrawal_tx_not_canonical" ||
        message === "withdrawal_tx_unfinalized"
      ) {
        reply.status(409);
        return {
          error: message
        };
      }
      if (message === "withdrawal_receipt_verification_unavailable" || message.startsWith("ethereum_rpc_")) {
        reply.status(503);
        return {
          error: message
        };
      }

      throw error;
    }
  });

  app.get("/api/ops/settlements/pending", { config: { rateLimit: routeRateLimits.ops } }, async (_request, reply) => {
    if (!hasOpsAccess(_request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (!config.DATABASE_URL && !dependencies.listPendingSettlementLegs) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    return {
      legs: await loadPendingSettlementLegs()
    };
  });

  app.get("/api/ops/settlements/alerts", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (!config.DATABASE_URL && !dependencies.listOpenSettlementOperationalAlerts) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional()
      })
      .parse(request.query);
    const loadAlerts = dependencies.listOpenSettlementOperationalAlerts || listOpenSettlementOperationalAlerts;

    return {
      alerts: await loadAlerts(query.limit)
    };
  });

  app.get("/api/ops/ticket-legs/:id/proofs", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (!config.DATABASE_URL && !dependencies.listSettlementProofs) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "ticket_leg_id_required"
      };
    }

    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional()
      })
      .parse(request.query);

    return {
      proofs: await loadSettlementProofs(params.id, query.limit)
    };
  });

  app.post("/api/ops/ticket-legs/:id/settle", { config: { rateLimit: routeRateLimits.ops } }, async (request, reply) => {
    if (!hasOpsAccess(request.headers.authorization)) {
      reply.status(401);
      return {
        error: "unauthorized"
      };
    }

    if (config.ACCOUNTING_MODE === "house_book_usdc") {
      reply.status(409);
      return {
        error: "verified_settlement_authority_required",
        detail: "Real-money ticket legs can only be finalized by the configured verified settlement authority."
      };
    }

    if (!config.DATABASE_URL && !dependencies.recordLegSettlement) {
      reply.status(503);
      return {
        error: "database_unavailable"
      };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return {
        error: "ticket_leg_id_required"
      };
    }

    const body = z
      .object({
        result: z.enum(["won", "lost", "voided", "disputed"]),
        proofReference: z.string().max(500).optional(),
        raw: z.unknown().optional()
      })
      .parse(request.body);

    try {
      const settlement = await settleTicketLeg({
        ticketLegId: params.id,
        result: body.result,
        proofReference: body.proofReference,
        raw: body.raw
      });
      reply.status(201);
      return settlement;
    } catch (error) {
      if (error instanceof Error && error.message === "ticket_leg_not_found") {
        reply.status(404);
        return {
          error: "ticket_leg_not_found"
        };
      }
      if (error instanceof Error && error.message.startsWith("settlement_conflict")) {
        reply.status(409);
        return {
          error: "settlement_conflict",
          detail: error.message
        };
      }

      throw error;
    }
  });

  if (serveFrontend) {
    app.setNotFoundHandler((request, reply) => {
      const acceptsHtml = request.headers.accept?.includes("text/html");
      const isAppRoute = request.url === "/" || (acceptsHtml && !request.url.startsWith("/api/"));
      if (request.method === "GET" && isAppRoute) {
        return reply.header("Cache-Control", "no-cache").type("text/html").sendFile("index.html");
      }

      return reply.status(404).send({ error: "not_found" });
    });
  }

  });

  return app;
}
