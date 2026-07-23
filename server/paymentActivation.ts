import { config } from "./config";
import { getPool } from "./db/client";
import { hydrateOutcomesWithOrderBooks } from "../src/marketData";
import { exposureChecksForQuote } from "./db/exposureRepository";
import {
  assertWorkerHeartbeatsHealthy,
  REQUIRED_FINANCIAL_WORKERS
} from "./db/workerHeartbeatRepository";
import { assertFinancialGateOpen } from "./financialGate";
import {
  activateQuotePaymentWithFinalQuote,
  claimQuotePaymentActivation,
  getQuotePaymentIntent,
  markQuotePaymentActivated,
  markQuotePaymentRecoverable,
  persistFinalQuoteForQuotePayment,
  prepareQuotePaymentCheckoutFundsForActivation,
  recoverStaleConfirmedQuotePaymentIntents,
  restoreQuotePaymentCheckoutFundsAfterActivationFailure,
  type PaymentRecoveryReason
} from "./db/paymentIntentRepository";
import { getPersistedQuote } from "./db/quoteRepository";
import { getPersistedMarketOutcomesByIds } from "./db/marketRepository";
import { acceptQuote, type AcceptedTicket } from "./db/ticketRepository";
import type { MarketCatalogSnapshot } from "./marketCatalog";
import { applyAdditionalRiskChecks, createPaymentActivationRequote, type QuoteResponse } from "./quoteService";

type RequoteCatalogProvider = (input: {
  quoteId: string;
  userId: string;
  requestedNotionalUsdPerLeg: number;
  outcomeIds: string[];
}) => Promise<MarketCatalogSnapshot>;

type ActivateQuotePaymentDependencies = {
  getPaymentIntent?: typeof getQuotePaymentIntent;
  getOriginalQuote?: typeof getPersistedQuote;
  getRequoteCatalog?: RequoteCatalogProvider;
  exposureChecks?: typeof exposureChecksForQuote;
  persistFinalQuote?: typeof persistFinalQuoteForQuotePayment;
  prepareCheckoutFunds?: typeof prepareQuotePaymentCheckoutFundsForActivation;
  restoreCheckoutFunds?: typeof restoreQuotePaymentCheckoutFundsAfterActivationFailure;
  acceptFinalQuote?: typeof acceptQuote;
  markActivated?: typeof markQuotePaymentActivated;
  markRecoverable?: typeof markQuotePaymentRecoverable;
  assertFinancialGateOpen?: typeof assertFinancialGateOpen;
  assertWorkerHeartbeatsHealthy?: typeof assertWorkerHeartbeatsHealthy;
  requiredWorkerNames?: readonly string[];
  nowMs?: number;
};

type ActivateConfirmedQuotePaymentsDependencies = {
  recoverStale?: typeof recoverStaleConfirmedQuotePaymentIntents;
  listCandidates?: (limit: number) => Promise<Array<{ quoteId: string; userId: string }>>;
  activate?: typeof activateConfirmedQuotePayment;
  requiredWorkerNames?: readonly string[];
};

function microUsd(value: number) {
  return Math.round(value * 1_000_000);
}

export async function getFreshRequoteCatalog(
  input: { requestedNotionalUsdPerLeg: number; outcomeIds: string[] },
  dependencies: {
    getCandidates?: typeof getPersistedMarketOutcomesByIds;
    hydrate?: typeof hydrateOutcomesWithOrderBooks;
  } = {}
) {
  const candidates = await (dependencies.getCandidates || getPersistedMarketOutcomesByIds)(input.outcomeIds, {
    maxSnapshotAgeMs: config.MARKET_CATALOG_HARD_MAX_AGE_MS
  });
  const candidatesById = new Map(candidates.outcomes.map((outcome) => [outcome.id, outcome]));
  const selected = input.outcomeIds.map((outcomeId) => candidatesById.get(outcomeId));
  if (selected.some((outcome) => !outcome || !outcome.conditionId || !outcome.tokenId)) {
    throw new Error("market_closed");
  }

  const refreshed = await (dependencies.hydrate || hydrateOutcomesWithOrderBooks)(selected as NonNullable<(typeof selected)[number]>[], undefined, {
    requestedNotionalUsd: input.requestedNotionalUsdPerLeg,
    requireExplicitLifecycle: true
  });
  if (!refreshed.complete || refreshed.outcomes.length !== selected.length) {
    throw new Error("stale_book");
  }

  return {
    ...candidates,
    asOf: new Date().toISOString(),
    outcomes: refreshed.outcomes
  };
}

function activationRecoveryReason(error: unknown): PaymentRecoveryReason {
  const message = error instanceof Error ? error.message : String(error || "activation_failed");
  if (message === "market_closed") return "market_closed";
  if (message === "stale_book") return "stale_book";
  if (message === "late_confirmation") return "late_confirmation";
  if (message === "requote_adverse") return "requote_adverse";
  if (message === "insufficient_depth") return "insufficient_depth";
  if (message === "quote_not_found") return "quote_not_found";
  if (
    message === "final_quote_evidence_required" ||
    message === "final_quote_evidence_incomplete" ||
    message === "final_quote_provenance_required"
  ) {
    return "stale_book";
  }
  if (message.startsWith("quote_exposure_limit")) return "exposure_limit";
  if (message.startsWith("quote_requires_review:reject")) return "risk_rejected";
  if (message.startsWith("quote_requires_review")) return "risk_review";
  return "activation_failed";
}

function recoveryDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error || "activation_failed");
}

function shouldMoveActivationErrorToRecoverable(error: unknown) {
  const message = recoveryDetail(error);
  if (message.startsWith("financial_gate_closed:")) return false;
  if (message.startsWith("required_financial_workers_unhealthy:")) return false;
  return ![
    "payment_activation_claim_conflict",
    "payment_activation_in_progress",
    "payment_intent_already_activated"
  ].includes(message);
}

function recoverableFromRisk(quote: QuoteResponse): PaymentRecoveryReason {
  if (quote.riskChecks.some((check) => check.level === "block" && /exposure/i.test(check.label))) return "exposure_limit";
  return quote.riskDecision === "reject" ? "risk_rejected" : "risk_review";
}

async function moveToRecoverable(
  input: { quoteId: string; userId: string; reason: PaymentRecoveryReason; detail: string; finalQuote?: QuoteResponse },
  markRecoverable: typeof markQuotePaymentRecoverable
) {
  await markRecoverable({
    quoteId: input.quoteId,
    userId: input.userId,
    reason: input.reason,
    detail: input.detail,
    finalPayoutMicroUsd: input.finalQuote ? microUsd(input.finalQuote.potentialPayoutUsd) : undefined
  });
}

function usesInjectedActivationPath(dependencies: ActivateQuotePaymentDependencies) {
  return Boolean(
    dependencies.getPaymentIntent ||
      dependencies.getOriginalQuote ||
      dependencies.getRequoteCatalog ||
      dependencies.exposureChecks ||
      dependencies.persistFinalQuote ||
      dependencies.prepareCheckoutFunds ||
      dependencies.restoreCheckoutFunds ||
      dependencies.acceptFinalQuote ||
      dependencies.markActivated ||
      dependencies.markRecoverable
  );
}

function bindLiveOrderbookProvenance(
  evidenceByLegId: ReturnType<typeof createPaymentActivationRequote>["evidenceByLegId"],
  catalog: MarketCatalogSnapshot
) {
  const outcomesById = new Map(catalog.outcomes.map((outcome) => [outcome.id, outcome]));
  return new Map(
    [...evidenceByLegId].map(([legId, evidence]) => [
      legId,
      {
        ...evidence,
        liveOrderbookFetchedAt: outcomesById.get(legId)?.sourceAsOf
      }
    ])
  );
}

export async function activateConfirmedQuotePayment(input: { quoteId: string; userId: string }, dependencies: ActivateQuotePaymentDependencies = {}) {
  const loadIntent = dependencies.getPaymentIntent || getQuotePaymentIntent;
  const loadOriginalQuote = dependencies.getOriginalQuote || getPersistedQuote;
  const loadRequoteCatalog = dependencies.getRequoteCatalog || ((request) => getFreshRequoteCatalog(request));
  const checkExposure = dependencies.exposureChecks || exposureChecksForQuote;
  const persistFinalQuote = dependencies.persistFinalQuote || persistFinalQuoteForQuotePayment;
  const prepareCheckoutFunds = dependencies.prepareCheckoutFunds || prepareQuotePaymentCheckoutFundsForActivation;
  const restoreCheckoutFunds = dependencies.restoreCheckoutFunds || restoreQuotePaymentCheckoutFundsAfterActivationFailure;
  const acceptFinalQuote = dependencies.acceptFinalQuote || acceptQuote;
  const markActivated = dependencies.markActivated || markQuotePaymentActivated;
  const markRecoverable = dependencies.markRecoverable || markQuotePaymentRecoverable;
  const assertActivationAllowed = dependencies.assertFinancialGateOpen || assertFinancialGateOpen;
  const assertRequiredWorkersHealthy = dependencies.assertWorkerHeartbeatsHealthy || assertWorkerHeartbeatsHealthy;
  const requiredWorkerNames =
    dependencies.requiredWorkerNames ?? (config.NODE_ENV === "production" ? REQUIRED_FINANCIAL_WORKERS : undefined);
  const nowMs = dependencies.nowMs ?? Date.now();

  if (requiredWorkerNames?.length) {
    await assertRequiredWorkersHealthy(requiredWorkerNames, {
      now: new Date(nowMs),
      maxAgeMs: config.WORKER_HEARTBEAT_MAX_AGE_MS,
      successMaxAgeMs: config.WORKER_SUCCESS_MAX_AGE_MS
    });
  }

  if (!usesInjectedActivationPath(dependencies)) {
    const passiveIntent = await loadIntent(input.quoteId, input.userId);
    if (!passiveIntent) throw new Error("payment_intent_not_found");
    if (passiveIntent.status === "activated") throw new Error("payment_intent_already_activated");
    if (passiveIntent.status === "recoverable") {
      throw new Error(`payment_intent_recoverable:${passiveIntent.recoveryReason || "activation_failed"}`);
    }
    await assertActivationAllowed({ operation: "direct_pay_activation" });
    const claim = await claimQuotePaymentActivation({
      quoteId: input.quoteId,
      userId: input.userId,
      now: new Date(nowMs)
    });
    if (claim.alreadyActivated) {
      throw new Error("payment_intent_already_activated");
    }

    let finalQuote: QuoteResponse | undefined;
    try {
      const originalQuote = await loadOriginalQuote(input.quoteId, input.userId);
      if (!originalQuote) throw new Error("quote_not_found");

      const catalog = await loadRequoteCatalog({
        quoteId: input.quoteId,
        userId: input.userId,
        requestedNotionalUsdPerLeg: originalQuote.stakeUsd,
        outcomeIds: originalQuote.legs.map((leg) => leg.id)
      });
      const requote = createPaymentActivationRequote(originalQuote, catalog, {
        requestedNotionalUsdPerLeg: originalQuote.stakeUsd,
        requireDepthEvidence: true,
        maxEvidenceAgeMs: config.MARKET_CATALOG_MAX_AGE_MS,
        nowMs
      });
      finalQuote = requote.quote;
      const evidenceByLegId = bindLiveOrderbookProvenance(requote.evidenceByLegId, catalog);

      if (finalQuote.riskDecision !== "accept" || finalQuote.status !== "quoted") {
        const reason = recoverableFromRisk(finalQuote);
        await moveToRecoverable(
          {
            quoteId: input.quoteId,
            userId: input.userId,
            reason,
            detail: `Final quote requires ${finalQuote.riskDecision}.`,
            finalQuote
          },
          markRecoverable
        );
        throw new Error(reason);
      }

      const minFinalPayout = BigInt(claim.intent.minFinalPayoutMicroUsd || "0");
      const finalPayout = BigInt(microUsd(finalQuote.potentialPayoutUsd));
      if (finalPayout < minFinalPayout) {
        await moveToRecoverable(
          {
            quoteId: input.quoteId,
            userId: input.userId,
            reason: "requote_adverse",
            detail: "Final payout fell below the checkout tolerance.",
            finalQuote
          },
          markRecoverable
        );
        throw new Error("requote_adverse");
      }

      return await activateQuotePaymentWithFinalQuote({
        quoteId: input.quoteId,
        userId: input.userId,
        activationClaimToken: claim.claimToken,
        finalQuote,
        evidenceByLegId,
        exposureLimits: {
          maxUserLiabilityUsd: config.MAX_USER_LIABILITY_USD,
          maxMarketLiabilityUsd: config.MAX_MARKET_LIABILITY_USD,
          maxEventLiabilityUsd: config.MAX_EVENT_LIABILITY_USD
        },
        requiredWorkerNames,
        workerHeartbeatMaxAgeMs: config.WORKER_HEARTBEAT_MAX_AGE_MS,
        workerSuccessMaxAgeMs: config.WORKER_SUCCESS_MAX_AGE_MS,
        now: new Date(nowMs)
      });
    } catch (error) {
      const reason = activationRecoveryReason(error);
      if (shouldMoveActivationErrorToRecoverable(error)) {
        await moveToRecoverable(
          {
            quoteId: input.quoteId,
            userId: input.userId,
            reason,
            detail: recoveryDetail(error),
            finalQuote
          },
          markRecoverable
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  const intent = await loadIntent(input.quoteId, input.userId);
  if (!intent) throw new Error("payment_intent_not_found");
  if (intent.status === "activated") throw new Error("payment_intent_already_activated");
  if (intent.status === "recoverable") throw new Error(`payment_intent_recoverable:${intent.recoveryReason || "activation_failed"}`);
  if (intent.status !== "confirmed") throw new Error("payment_intent_not_confirmed");
  if (dependencies.assertFinancialGateOpen) {
    await assertActivationAllowed({ operation: "direct_pay_activation" });
  }

  let finalQuote: QuoteResponse | undefined;
  try {
    const originalQuote = await loadOriginalQuote(input.quoteId, input.userId);
    if (!originalQuote) throw new Error("quote_not_found");

    const catalog = await loadRequoteCatalog({
      quoteId: input.quoteId,
      userId: input.userId,
      requestedNotionalUsdPerLeg: originalQuote.stakeUsd,
      outcomeIds: originalQuote.legs.map((leg) => leg.id)
    });
    const requote = createPaymentActivationRequote(originalQuote, catalog, {
      requestedNotionalUsdPerLeg: originalQuote.stakeUsd,
      requireDepthEvidence: true,
      maxEvidenceAgeMs: config.MARKET_CATALOG_MAX_AGE_MS,
      nowMs
    });
    const evidenceByLegId = bindLiveOrderbookProvenance(requote.evidenceByLegId, catalog);
    const exposureChecks = await checkExposure(requote.quote, {
      maxUserLiabilityUsd: config.MAX_USER_LIABILITY_USD,
      maxMarketLiabilityUsd: config.MAX_MARKET_LIABILITY_USD,
      maxEventLiabilityUsd: config.MAX_EVENT_LIABILITY_USD,
      userId: input.userId,
      excludePaymentIntentId: intent.id,
      includeSoftReservations: true
    });
    finalQuote = applyAdditionalRiskChecks(requote.quote, exposureChecks);

    if (finalQuote.riskDecision !== "accept" || finalQuote.status !== "quoted") {
      const reason = recoverableFromRisk(finalQuote);
      await moveToRecoverable(
        {
          quoteId: input.quoteId,
          userId: input.userId,
          reason,
          detail: `Final quote requires ${finalQuote.riskDecision}.`,
          finalQuote
        },
        markRecoverable
      );
      throw new Error(reason);
    }

    const minFinalPayout = BigInt(intent.minFinalPayoutMicroUsd || "0");
    const finalPayout = BigInt(microUsd(finalQuote.potentialPayoutUsd));
    if (finalPayout < minFinalPayout) {
      await moveToRecoverable(
        {
          quoteId: input.quoteId,
          userId: input.userId,
          reason: "requote_adverse",
          detail: "Final payout fell below the checkout tolerance.",
          finalQuote
        },
        markRecoverable
      );
      throw new Error("requote_adverse");
    }

    const finalIntent = await persistFinalQuote({
      quoteId: input.quoteId,
      userId: input.userId,
      finalQuote,
      evidenceByLegId
    });
    const finalQuoteId = finalIntent.finalQuoteId || finalQuote.id;
    await prepareCheckoutFunds({
      quoteId: input.quoteId,
      userId: input.userId
    });

    let ticket: AcceptedTicket;
    try {
      ticket = await acceptFinalQuote(finalQuoteId, input.userId, {
        accountingMode: "house_book_usdc",
        currency: "USDC",
        maxUserLiabilityUsd: config.MAX_USER_LIABILITY_USD,
        maxMarketLiabilityUsd: config.MAX_MARKET_LIABILITY_USD,
        maxEventLiabilityUsd: config.MAX_EVENT_LIABILITY_USD
      });
    } catch (error) {
      await restoreCheckoutFunds({
        quoteId: input.quoteId,
        userId: input.userId
      });
      throw error;
    }

    await markActivated({
      quoteId: input.quoteId,
      userId: input.userId,
      ticketId: ticket.ticketId
    });

    return ticket;
  } catch (error) {
    const reason = activationRecoveryReason(error);
    if (shouldMoveActivationErrorToRecoverable(error)) {
      await moveToRecoverable(
        {
          quoteId: input.quoteId,
          userId: input.userId,
          reason,
          detail: recoveryDetail(error),
          finalQuote
        },
        markRecoverable
      ).catch(() => undefined);
    }
    throw error;
  }
}

export async function activateConfirmedQuotePayments(limit = 25, dependencies: ActivateConfirmedQuotePaymentsDependencies = {}) {
  const recoverStale = dependencies.recoverStale || recoverStaleConfirmedQuotePaymentIntents;
  const listCandidates =
    dependencies.listCandidates ||
    (async (candidateLimit: number) => {
      const result = await getPool().query<{
        quoteId: string;
        userId: string;
      }>(
        `
          SELECT quote_id AS "quoteId", user_id AS "userId"
          FROM quote_payment_intents
          WHERE (
              status = 'confirmed'
              OR (status = 'activating' AND (activation_lease_expires_at IS NULL OR activation_lease_expires_at <= now()))
            )
            AND (activation_deadline_at IS NULL OR activation_deadline_at > now())
          ORDER BY confirmed_at ASC NULLS LAST, updated_at ASC
          LIMIT $1
        `,
        [candidateLimit]
      );
      return result.rows;
    });
  const activate =
    dependencies.activate ||
    ((input: { quoteId: string; userId: string }) =>
      activateConfirmedQuotePayment(input, { requiredWorkerNames: dependencies.requiredWorkerNames }));

  await recoverStale(limit);
  const candidates = await listCandidates(limit);

  let activated = 0;
  const failed: Array<{ quoteId: string; userId: string; error: string }> = [];

  for (const intent of candidates) {
    try {
      await activate(intent);
      activated += 1;
    } catch (error) {
      failed.push({
        ...intent,
        error: error instanceof Error ? error.message : "activation_failed"
      });
    }
  }

  return {
    scanned: candidates.length,
    activated,
    failed
  };
}
