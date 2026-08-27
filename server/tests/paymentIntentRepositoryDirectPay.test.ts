import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteResponse } from "../quoteService";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  acceptQuoteInTransaction: vi.fn()
}));
const gateMocks = vi.hoisted(() => ({
  assertOpenInTransaction: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({
    connect: async () => ({
      query: dbMocks.query,
      release: dbMocks.release
    })
  })
}));

vi.mock("../db/ticketRepository", () => ({
  acceptQuoteInTransaction: dbMocks.acceptQuoteInTransaction
}));

vi.mock("../financialGate", () => ({
  assertFinancialGateOpenInTransaction: gateMocks.assertOpenInTransaction
}));

import {
  activateQuotePaymentWithFinalQuote,
  claimQuotePaymentActivation,
  createQuotePaymentIntent,
  paymentExposureExceedsLimit,
  submitQuotePaymentTransaction
} from "../db/paymentIntentRepository";

const userId = "00000000-0000-0000-0000-000000000001";
const intentRow = {
  id: "11111111-1111-1111-1111-111111111111",
  quote_id: "quote-estimate",
  user_id: userId,
  chain_id: 1,
  currency: "USDC",
  treasury_address: "0x1234567890abcdef1234567890abcdef12345678",
  usdc_contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  amount_micro_units: "27000000",
  required_confirmations: 12,
  status: "activating",
  tx_hash: null,
  ticket_id: null,
  expires_at: new Date("2026-07-13T12:15:00.000Z"),
  submission_deadline_at: new Date("2026-07-13T12:03:00.000Z"),
  tracking_deadline_at: new Date("2026-07-13T12:15:00.000Z"),
  activation_deadline_at: new Date("2026-07-13T12:05:00.000Z"),
  activation_claim_token: "claim-token",
  activation_claimed_at: new Date("2026-07-13T12:00:30.000Z"),
  activation_lease_expires_at: new Date("2026-07-13T12:01:30.000Z"),
  max_adverse_bps: 50,
  estimated_payout_micro_usd: "90000000",
  min_final_payout_micro_usd: "89550000",
  final_payout_micro_usd: null,
  final_quote_id: null,
  amount_received_micro_units: "27000000",
  surplus_micro_units: "0",
  checkout_ledger_transaction_id: "22222222-2222-2222-2222-222222222222",
  recovery_release_transaction_id: null,
  surplus_release_transaction_id: null,
  activation_funding_transaction_id: null,
  recovery_reason: null,
  recovery_detail: null,
  submitted_at: new Date("2026-07-13T12:00:10.000Z"),
  confirmed_at: new Date("2026-07-13T12:00:20.000Z"),
  activated_at: null,
  created_at: new Date("2026-07-13T12:00:00.000Z"),
  updated_at: new Date("2026-07-13T12:00:30.000Z")
};

const finalQuote: QuoteResponse = {
  id: "quote-final",
  status: "quoted",
  createdAt: "2026-07-13T12:00:31.000Z",
  expiresAt: "2026-07-13T12:00:46.000Z",
  sourceAsOf: "2026-07-13T12:00:30.000Z",
  stakeUsd: 25,
  operationFeeUsd: 2,
  totalCostUsd: 27,
  basketPrice: 0.25,
  basketProbability: 0.25,
  quoteSpread: 0.1,
  payoutMultiple: 3.6,
  potentialPayoutUsd: 90,
  riskDecision: "accept",
  riskChecks: [],
  legs: [
    {
      id: "btc-up-yes",
      marketId: "btc-up",
      question: "Bitcoin Up?",
      outcome: "Yes",
      price: 0.5
    },
    {
      id: "eth-up-yes",
      marketId: "eth-up",
      question: "Ethereum Up?",
      outcome: "Yes",
      price: 0.5
    }
  ]
};

function evidence(bookHash: string) {
  return {
    requestedNotionalUsd: 25,
    availableNotionalUsd: 250,
    bestAsk: 0.5,
    executablePrice: 0.5,
    vwapAsk: 0.5,
    orderbookTimestamp: "2026-07-13T12:00:30.000Z",
    orderbookHash: bookHash,
    liveOrderbookFetchedAt: "2026-07-13T12:00:31.000Z",
    sufficientDepth: true
  };
}

beforeEach(() => {
  dbMocks.query.mockReset();
  dbMocks.release.mockReset();
  dbMocks.acceptQuoteInTransaction.mockReset();
  gateMocks.assertOpenInTransaction.mockReset();
  gateMocks.assertOpenInTransaction.mockResolvedValue({ allowed: true });
});

describe("direct-pay payment intent activation repository", () => {
  it("rolls back before quote, payment intent, or exposure mutations when the creation gate is closed", async () => {
    const events: string[] = [];
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") {
        events.push(text);
        return { rows: [] };
      }
      throw new Error(`query_after_closed_gate: ${text}`);
    });
    gateMocks.assertOpenInTransaction.mockImplementation(async () => {
      events.push("gate");
      throw new Error("financial_gate_closed:reconciliation_snapshot_stale");
    });

    await expect(
      createQuotePaymentIntent({
        quoteId: "quote-estimate",
        userId,
        treasuryConfig: {
          chainId: 1,
          treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
          usdcContractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          requiredConfirmations: 12
        }
      })
    ).rejects.toThrow("financial_gate_closed");

    expect(events).toEqual(["BEGIN", "gate", "ROLLBACK"]);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO quote_payment_intents"))).toBe(false);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("quote_payment_exposure_reservations"))).toBe(false);
    expect(gateMocks.assertOpenInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query: dbMocks.query }),
      { operation: "quote_payment_intent.create" }
    );
  });

  it("creates the payment intent and soft exposure reservation when the creation gate is open", async () => {
    const pendingIntent = {
      ...intentRow,
      status: "pending",
      activation_claim_token: null,
      activation_claimed_at: null,
      activation_lease_expires_at: null
    };
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM quotes") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "quote-estimate",
              user_id: userId,
              status: "quoted",
              risk_decision: "accept",
              stake_micro_usd: "25000000",
              operation_fee_micro_usd: "2000000",
              offered_payout_micro_usd: "90000000",
              expires_at: new Date("2030-07-13T12:15:00.000Z")
            }
          ]
        };
      }
      if (text.includes("FROM quote_payment_intents") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("FROM quote_legs") && text.includes("ORDER BY markets.source_market_id")) return { rows: [] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM open_market_exposure_with_soft")) return { rows: [] };
      if (text.includes("FROM open_event_exposure_with_soft")) return { rows: [] };
      if (text.includes("UPDATE quotes SET user_id")) return { rows: [] };
      if (text.includes("INSERT INTO quote_payment_intents")) return { rows: [pendingIntent] };
      if (text.includes("INSERT INTO quote_payment_exposure_reservations")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await createQuotePaymentIntent({
      quoteId: "quote-estimate",
      userId,
      treasuryConfig: {
        chainId: 1,
        treasuryAddress: "0x1234567890abcdef1234567890abcdef12345678",
        usdcContractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        requiredConfirmations: 12
      },
      exposureLimits: {
        maxMarketLiabilityUsd: 1_000,
        maxEventLiabilityUsd: 1_000
      }
    });

    expect(result.status).toBe("pending");
    expect(gateMocks.assertOpenInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query: dbMocks.query }),
      { operation: "quote_payment_intent.create" }
    );
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO quote_payment_intents"))).toBe(true);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO quote_payment_exposure_reservations"))).toBe(true);
    expect(dbMocks.query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe("COMMIT");
  });

  it("keeps soft-reservation boundary decisions in bigint micro-units", () => {
    const boundary = 9_007_199_254_740_992n;
    expect(
      paymentExposureExceedsLimit({
        currentMicroUsd: boundary - 1n,
        incrementalMicroUsd: 1n,
        limitMicroUsd: boundary
      })
    ).toBe(false);
    expect(
      paymentExposureExceedsLimit({
        currentMicroUsd: boundary,
        incrementalMicroUsd: 1n,
        limitMicroUsd: boundary
      })
    ).toBe(true);
  });

  it("keeps a spent generic deposit unbound and makes a late hash submission recoverable", async () => {
    const txHash = `0x${"c".repeat(64)}`;
    const depositId = "33333333-3333-3333-3333-333333333333";
    const submittedIntent = {
      ...intentRow,
      status: "submitted",
      tx_hash: txHash,
      checkout_ledger_transaction_id: null,
      amount_received_micro_units: null,
      surplus_micro_units: null,
      recovery_reason: "late_submission",
      recovery_detail: "Transaction hash was submitted after the payment request deadline."
    };
    const recoverableIntent = { ...submittedIntent, status: "recoverable" };
    let recovered = false;

    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes('expires_at <= now() AS "isExpired"')) {
        return {
          rows: [
            recovered
              ? recoverableIntent
              : {
                  ...intentRow,
                  status: "expired",
                  tx_hash: null,
                  checkout_ledger_transaction_id: null,
                  amount_received_micro_units: null,
                  surplus_micro_units: null,
                  recovery_reason: null,
                  recovery_detail: null
                }
          ]
        };
      }
      if (text.includes("SELECT id") && text.includes("id <> $3")) return { rows: [] };
      if (text.includes("SET\n          tx_hash = $3")) return { rows: [submittedIntent] };
      if (text.includes("FROM onchain_deposits")) {
        return { rows: [{ id: depositId, amount_micro_units: "27000000", credited_transaction_id: "deposit-credit" }] };
      }
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: params?.[1] }] };
      if (text.includes("id = ANY($1::uuid[])") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("COALESCE(sum(amount_micro_units)")) return { rows: [{ balance: "7000000" }] };
      if (text.includes("status = 'recoverable'")) {
        recovered = true;
        return { rows: [recoverableIntent] };
      }
      if (text.includes("UPDATE quote_payment_exposure_reservations")) return { rows: [] };
      if (text.includes("INSERT INTO audit_log")) return { rows: [] };
      if (text.includes("FROM quote_payment_intents") && text.includes("WHERE id = $1")) {
        return { rows: [recoverableIntent] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await submitQuotePaymentTransaction({ quoteId: "quote-estimate", userId, txHash });
    const replay = await submitQuotePaymentTransaction({ quoteId: "quote-estimate", userId, txHash });

    expect(result).toMatchObject({ status: "recoverable", recoveryReason: "late_submission", txHash });
    expect(replay).toMatchObject({ status: "recoverable", recoveryReason: "late_submission", txHash });
    const accountLock = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("id = ANY($1::uuid[])"));
    expect(accountLock?.[1]).toEqual([["user_usdc_available", "user_usdc_checkout"]]);
    expect(dbMocks.query.mock.calls.filter(([sql]) => String(sql).includes("COALESCE(sum(amount_micro_units)"))).toHaveLength(1);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("SET payment_intent_id"))).toBe(false);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("quote payment held for checkout"))).toBe(false);
    expect(dbMocks.query.mock.calls.filter(([sql]) => String(sql).includes("status = 'recoverable'"))).toHaveLength(1);
  });

  it("serializes activation by claiming a confirmed intent with a lease", async () => {
    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM quote_payment_intents") && text.includes("FOR UPDATE")) {
        return { rows: [{ ...intentRow, status: "confirmed", activation_claim_token: null, activation_lease_expires_at: null }] };
      }
      if (text.includes("status = 'activating'")) {
        return { rows: [{ ...intentRow, status: "activating", activation_claim_token: params?.[2] }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const claim = await claimQuotePaymentActivation({
      quoteId: "quote-estimate",
      userId,
      now: new Date("2026-07-13T12:00:30.000Z")
    });

    expect(claim.intent.status).toBe("activating");
    expect(claim.claimToken).toBeTruthy();
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("activation_lease_expires_at"))).toBe(true);
  });

  it("recovers stale confirmed intents and releases their soft reservation", async () => {
    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM quote_payment_intents") && text.includes("FOR UPDATE")) {
        return { rows: [{ ...intentRow, status: "confirmed", activation_deadline_at: new Date("2026-07-13T11:59:00.000Z") }] };
      }
      if (text.includes("status = 'recoverable'")) {
        return { rows: [{ ...intentRow, status: "recoverable", recovery_reason: "late_confirmation" }] };
      }
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: params?.[1] }] };
      if (text.includes("SELECT id FROM ledger_accounts")) return { rows: [] };
      if (text.includes("COALESCE(sum(amount_micro_units)")) return { rows: [{ balance: "27000000" }] };
      if (text.includes("quote payment released from checkout for recovery")) return { rows: [] };
      if (text.includes("recovery_release_transaction_id")) {
        return { rows: [{ ...intentRow, status: "recoverable", recovery_reason: "late_confirmation", recovery_release_transaction_id: "release-test" }] };
      }
      if (text.includes("UPDATE quote_payment_exposure_reservations")) return { rows: [] };
      if (text.includes("INSERT INTO audit_log")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      claimQuotePaymentActivation({
        quoteId: "quote-estimate",
        userId,
        now: new Date("2026-07-13T12:00:30.000Z")
      })
    ).rejects.toThrow("late_confirmation");

    expect(dbMocks.query.mock.calls.some(([sql, params]) => String(sql).includes("UPDATE quote_payment_exposure_reservations") && params?.[1] === "released")).toBe(true);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("quote payment released from checkout for recovery"))).toBe(true);
    expect(dbMocks.query.mock.calls.filter(([sql]) => String(sql).includes("quote payment released from checkout for recovery"))).toHaveLength(1);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql) === "COMMIT")).toBe(true);
  });

  it("steals an expired activation lease before the activation deadline", async () => {
    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM quote_payment_intents") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              ...intentRow,
              status: "activating",
              activation_claim_token: "abandoned-claim",
              activation_lease_expires_at: new Date("2026-07-13T12:00:10.000Z")
            }
          ]
        };
      }
      if (text.includes("status = 'activating'")) return { rows: [{ ...intentRow, status: "activating", activation_claim_token: params?.[2] }] };
      throw new Error(`unexpected query: ${text}`);
    });

    const claim = await claimQuotePaymentActivation({
      quoteId: "quote-estimate",
      userId,
      now: new Date("2026-07-13T12:00:30.000Z")
    });

    expect(claim.intent.activationClaimToken).toBe(claim.claimToken);
    expect(claim.claimToken).not.toBe("abandoned-claim");
  });

  it("fails the activation transaction before persistence, reservation, ledger, or ticket mutations when the gate closes", async () => {
    const events: string[] = [];
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") {
        events.push(text);
        return { rows: [] };
      }
      throw new Error(`mutation_before_gate_failure: ${text}`);
    });

    await expect(
      activateQuotePaymentWithFinalQuote({
        quoteId: "quote-estimate",
        userId,
        activationClaimToken: "claim-token",
        finalQuote,
        evidenceByLegId: new Map([
          ["btc-up-yes", evidence("book-btc")],
          ["eth-up-yes", evidence("book-eth")]
        ]),
        assertFinancialGateOpenInTransaction: async () => {
          events.push("gate");
          throw new Error("financial_gate_closed:reconciliation_snapshot_stale");
        },
        now: new Date("2026-07-13T12:00:31.000Z")
      })
    ).rejects.toThrow("financial_gate_closed");

    expect(events).toEqual(["BEGIN", "gate", "ROLLBACK"]);
    expect(dbMocks.acceptQuoteInTransaction).not.toHaveBeenCalled();
  });

  it("rechecks required worker health inside the activation transaction before locking the intent", async () => {
    const events: string[] = [];
    dbMocks.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") {
        events.push(text);
        return { rows: [] };
      }
      throw new Error(`mutation_before_worker_health_failure: ${text}`);
    });

    await expect(
      activateQuotePaymentWithFinalQuote({
        quoteId: "quote-estimate",
        userId,
        activationClaimToken: "claim-token",
        finalQuote,
        evidenceByLegId: new Map([
          ["btc-up-yes", evidence("book-btc")],
          ["eth-up-yes", evidence("book-eth")]
        ]),
        requiredWorkerNames: ["financial-reconciliation", "settlement-worker"],
        assertFinancialGateOpenInTransaction: async () => {
          events.push("gate");
          return undefined as never;
        },
        assertWorkerHeartbeatsHealthyInTransaction: async (_client, workerNames) => {
          events.push(`workers:${workerNames.join(",")}`);
          throw new Error("required_financial_workers_unhealthy:settlement-worker");
        },
        now: new Date("2026-07-13T12:00:31.000Z")
      })
    ).rejects.toThrow("required_financial_workers_unhealthy:settlement-worker");

    expect(events).toEqual([
      "BEGIN",
      "gate",
      "workers:financial-reconciliation,settlement-worker",
      "ROLLBACK"
    ]);
    expect(dbMocks.acceptQuoteInTransaction).not.toHaveBeenCalled();
  });

  it("releases successful overpayment surplus exactly once while the ticket receives only the amount due", async () => {
    const overpaidIntent = {
      ...intentRow,
      amount_received_micro_units: "30000000",
      surplus_micro_units: "3000000"
    };
    const gateAndMutationOrder: string[] = [];
    let quoteLegIndex = 0;
    let balanceReadCount = 0;
    let activated = false;

    dbMocks.acceptQuoteInTransaction.mockResolvedValueOnce({
      ticketId: "ticket-final",
      quoteId: "quote-final",
      status: "accepted",
      ledgerTransactionId: "ticket-ledger-test",
      accountingMode: "house_book_usdc",
      currency: "USDC"
    });
    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") {
        gateAndMutationOrder.push(text);
        return { rows: [] };
      }
      if (text.includes("FROM quote_payment_intents") && text.includes("FOR UPDATE")) {
        gateAndMutationOrder.push("intent-lock");
        return {
          rows: [
            activated
              ? {
                  ...overpaidIntent,
                  status: "activated",
                  ticket_id: "ticket-final",
                  final_quote_id: "quote-final",
                  activation_funding_transaction_id: "funding-test",
                  surplus_release_transaction_id: "surplus-release-test"
                }
              : overpaidIntent
          ]
        };
      }
      if (text.includes("INSERT INTO policy_versions")) return { rows: [] };
      if (text.includes("FROM policy_versions")) return { rows: [{ id: "policy-test" }] };
      if (text.includes("INSERT INTO quotes")) return { rows: [] };
      if (text.includes("SELECT id, parent_quote_id, quote_kind")) {
        return { rows: [{ id: "quote-final", parent_quote_id: "quote-estimate", quote_kind: "final" }] };
      }
      if (text.includes("FROM quote_legs estimate_quote_legs") && text.includes("market_snapshots")) {
        const sourceMarketId = String(params?.[1]);
        return {
          rows: [
            {
              estimate_quote_leg_id: `estimate-leg-${sourceMarketId}`,
              market_id: `market-${sourceMarketId}`,
              outcome_id: `${sourceMarketId}-yes`,
              snapshot_id: `snapshot-${sourceMarketId}`,
              source_market_id: sourceMarketId,
              condition_id: `${sourceMarketId}-condition`,
              token_id: `${sourceMarketId}-token`,
              snapshot_hash: `${sourceMarketId}-snapshot-hash`,
              snapshot_captured_at: new Date("2026-07-13T11:59:45.000Z")
            }
          ]
        };
      }
      if (text.includes("INSERT INTO quote_legs")) {
        quoteLegIndex += 1;
        return { rows: [{ id: `quote-leg-${quoteLegIndex}` }] };
      }
      if (text.includes("INSERT INTO quote_reprice_evidence")) return { rows: [] };
      if (text.includes("catalog_evidence_count")) {
        return { rows: [{ catalog_evidence_count: "2", live_evidence_count: "2", leg_count: "2" }] };
      }
      if (text.includes("final_quote_id = $3")) return { rows: [{ ...overpaidIntent, final_quote_id: "quote-final" }] };
      if (text.includes("payment.final_quote_applied")) return { rows: [] };
      if (text.includes("UPDATE quote_payment_exposure_reservations")) return { rows: [{ id: "reservation-test" }] };
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: params?.[1] }] };
      if (text.includes("SELECT id FROM ledger_accounts")) return { rows: [] };
      if (text.includes("COALESCE(sum(amount_micro_units)")) {
        balanceReadCount += 1;
        return { rows: [{ balance: balanceReadCount === 1 ? "30000000" : "3000000" }] };
      }
      if (text.includes("quote payment released for activation")) return { rows: [] };
      if (text.includes("activation_funding_transaction_id = $3")) {
        return { rows: [{ ...overpaidIntent, activation_funding_transaction_id: "funding-test" }] };
      }
      if (text.includes("payment.checkout_released_for_activation")) return { rows: [] };
      if (text.includes("quote payment surplus released from checkout")) return { rows: [] };
      if (text.includes("surplus_release_transaction_id = $3")) {
        return {
          rows: [
            {
              ...overpaidIntent,
              activation_funding_transaction_id: "funding-test",
              surplus_release_transaction_id: "surplus-release-test"
            }
          ]
        };
      }
      if (text.includes("payment.surplus_released")) return { rows: [] };
      if (text.includes("status = 'activated'")) {
        activated = true;
        return { rows: [{ ...overpaidIntent, status: "activated", ticket_id: "ticket-final" }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const ticket = await activateQuotePaymentWithFinalQuote({
      quoteId: "quote-estimate",
      userId,
      activationClaimToken: "claim-token",
      finalQuote,
      evidenceByLegId: new Map([
        ["btc-up-yes", evidence("book-btc")],
        ["eth-up-yes", evidence("book-eth")]
      ]),
      assertFinancialGateOpenInTransaction: async () => {
        gateAndMutationOrder.push("gate");
        return undefined as never;
      },
      now: new Date("2026-07-13T12:00:31.000Z")
    });
    const replayedTicket = await activateQuotePaymentWithFinalQuote({
      quoteId: "quote-estimate",
      userId,
      activationClaimToken: "claim-token",
      finalQuote,
      evidenceByLegId: new Map([
        ["btc-up-yes", evidence("book-btc")],
        ["eth-up-yes", evidence("book-eth")]
      ]),
      assertFinancialGateOpenInTransaction: async () => undefined as never,
      now: new Date("2026-07-13T12:00:32.000Z")
    });

    expect(ticket.ticketId).toBe("ticket-final");
    expect(replayedTicket.ticketId).toBe("ticket-final");
    expect(gateAndMutationOrder.slice(0, 3)).toEqual(["BEGIN", "gate", "intent-lock"]);
    const activationTransfer = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("quote payment released for activation"));
    expect(activationTransfer?.[1]?.slice(2)).toEqual(["-27000000", "user_usdc_available", "27000000"]);
    const surplusTransfers = dbMocks.query.mock.calls.filter(([sql]) => String(sql).includes("quote payment surplus released from checkout"));
    expect(surplusTransfers).toHaveLength(1);
    expect(surplusTransfers[0]?.[1]?.slice(2)).toEqual(["-3000000", "user_usdc_available", "3000000"]);
    expect(dbMocks.query.mock.calls.filter(([sql]) => String(sql).includes("surplus_release_transaction_id = $3"))).toHaveLength(1);
    expect(dbMocks.acceptQuoteInTransaction).toHaveBeenCalledTimes(1);
  });

  it("rolls back atomic activation when CTF position validation fails before payment activation", async () => {
    dbMocks.acceptQuoteInTransaction.mockRejectedValueOnce(new Error("ctf_position_id_mismatch"));
    let quoteLegIndex = 0;
    dbMocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text === "COMMIT") throw new Error("should_not_commit");
      if (text.includes("FROM quote_payment_intents") && text.includes("FOR UPDATE")) return { rows: [intentRow] };
      if (text.includes("INSERT INTO policy_versions")) return { rows: [] };
      if (text.includes("FROM policy_versions")) return { rows: [{ id: "policy-test" }] };
      if (text.includes("INSERT INTO quotes")) return { rows: [] };
      if (text.includes("SELECT id, parent_quote_id, quote_kind")) {
        return { rows: [{ id: "quote-final", parent_quote_id: "quote-estimate", quote_kind: "final" }] };
      }
      if (text.includes("FROM quote_legs estimate_quote_legs") && text.includes("market_snapshots")) {
        const marketId = params?.[1] === "btc-up" ? "market-btc" : "market-eth";
        return {
          rows: [
            {
              estimate_quote_leg_id: params?.[1] === "btc-up" ? "estimate-leg-btc" : "estimate-leg-eth",
              market_id: marketId,
              outcome_id: params?.[1] === "btc-up" ? "btc-up-yes" : "eth-up-yes",
              snapshot_id: params?.[1] === "btc-up" ? "snapshot-btc" : "snapshot-eth",
              source_market_id: params?.[1],
              condition_id: `${params?.[1]}-condition`,
              token_id: `${params?.[1]}-token`,
              snapshot_hash: `${params?.[1]}-snapshot-hash`,
              snapshot_captured_at: new Date("2026-07-13T11:59:45.000Z")
            }
          ]
        };
      }
      if (text.includes("INSERT INTO quote_legs")) {
        quoteLegIndex += 1;
        return { rows: [{ id: `quote-leg-${quoteLegIndex}` }] };
      }
      if (text.includes("INSERT INTO quote_reprice_evidence")) return { rows: [] };
      if (text.includes("catalog_evidence_count")) {
        return { rows: [{ catalog_evidence_count: "2", live_evidence_count: "2", leg_count: "2" }] };
      }
      if (text.includes("final_quote_id = $3")) return { rows: [{ ...intentRow, final_quote_id: "quote-final" }] };
      if (text.includes("payment.final_quote_applied")) return { rows: [] };
      if (text.includes("UPDATE quote_payment_exposure_reservations")) return { rows: [{ id: "reservation-test" }] };
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: params?.[1] }] };
      if (text.includes("SELECT id FROM ledger_accounts")) return { rows: [] };
      if (text.includes("COALESCE(sum(amount_micro_units)")) return { rows: [{ balance: "27000000" }] };
      if (text.includes("quote payment released for activation")) return { rows: [] };
      if (text.includes("activation_funding_transaction_id")) return { rows: [{ ...intentRow, activation_funding_transaction_id: "funding-test" }] };
      if (text.includes("payment.checkout_released_for_activation")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      activateQuotePaymentWithFinalQuote({
        quoteId: "quote-estimate",
        userId,
        activationClaimToken: "claim-token",
        finalQuote,
        evidenceByLegId: new Map([
          ["btc-up-yes", evidence("book-btc")],
          ["eth-up-yes", evidence("book-eth")]
        ]),
        assertFinancialGateOpenInTransaction: async () => undefined as never,
        now: new Date("2026-07-13T12:00:31.000Z")
      })
    ).rejects.toThrow("ctf_position_id_mismatch");

    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql) === "ROLLBACK")).toBe(true);
    expect(dbMocks.query.mock.calls.some(([sql]) => String(sql).includes("status = 'activated'"))).toBe(false);
    const snapshotQuery = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("FROM quote_legs estimate_quote_legs"));
    expect(String(snapshotQuery?.[0])).toContain("estimate_quote_legs.quote_id = $1");
    expect(snapshotQuery?.[1]?.[0]).toBe("quote-estimate");
    const evidenceInsert = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO quote_reprice_evidence"));
    expect(String(evidenceInsert?.[0])).toContain("'catalog_snapshot'");
    expect(String(evidenceInsert?.[0])).toContain("'live_orderbook'");
    expect(evidenceInsert?.[1]?.[2]).toMatchObject({
      estimateQuoteId: "quote-estimate",
      snapshot: { capturedAt: "2026-07-13T11:59:45.000Z" }
    });
    expect(evidenceInsert?.[1]?.[3]).toMatchObject({
      orderbook: {
        fetchedAt: "2026-07-13T12:00:31.000Z",
        sourceTimestamp: "2026-07-13T12:00:30.000Z"
      }
    });
  });
});
