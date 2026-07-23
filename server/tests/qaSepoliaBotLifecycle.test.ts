import { describe, expect, it, vi } from "vitest";
import { getAddress, type Hash } from "viem";
import type { FinancialReconciliationSnapshot } from "../db/reconciliationRepository";
import {
  redactLifecycleReport,
  runSepoliaBotLifecycle,
  type LifecycleFetch,
  type SepoliaBotLifecycleDependencies,
  type SepoliaBurnerWallet
} from "../qaSepoliaBotLifecycle";

const now = new Date("2026-07-21T00:00:00.000Z");
const burnerAddress = getAddress("0x1111111111111111111111111111111111111111");
const treasuryAddress = getAddress("0x2222222222222222222222222222222222222222");
const usdcAddress = getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
const txHash = `0x${"ab".repeat(32)}` as Hash;
const accessToken = "eyJhbGciOiJIUzI1NiJ9.access-payload.access-signature";
const identityToken = "eyJhbGciOiJIUzI1NiJ9.identity-payload.identity-signature";
const opsApiKey = "ops-api-key-that-must-never-appear";

function response(status: number, body: unknown) {
  return { status, json: async () => body };
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    ACCOUNTING_MODE: "house_book_usdc",
    SETTLEMENT_CHAIN_ID: "11155111",
    USDC_REQUIRED_CONFIRMATIONS: "12",
    USDC_CONTRACT_ADDRESS: usdcAddress,
    TREASURY_SAFE_ADDRESS: treasuryAddress,
    ETHEREUM_RPC_URL: "https://sepolia-rpc.example.test",
    QA_SEPOLIA_API_BASE_URL: "http://127.0.0.1:8790",
    QA_SEPOLIA_BOT_ACCESS_TOKEN: accessToken,
    QA_SEPOLIA_BOT_IDENTITY_TOKEN: identityToken,
    QA_SEPOLIA_OPS_API_KEY: opsApiKey,
    QA_SEPOLIA_LIFECYCLE_CONFIRM: "sepolia-positive-lifecycle",
    ...overrides
  };
}

function reconciliationSnapshot(): FinancialReconciliationSnapshot {
  return {
    id: "reconciliation-1",
    chainId: 11155111,
    currency: "USDC",
    treasuryAssetsMicroUnits: "100000000",
    internalCustodyMicroUnits: "100000000",
    userAvailableMicroUnits: "0",
    userClaimableMicroUnits: "0",
    userCheckoutMicroUnits: "0",
    openStakeMicroUnits: "1000000",
    openReserveMicroUnits: "1000000",
    pendingWithdrawalMicroUnits: "0",
    houseEquityMicroUnits: "98000000",
    unexplainedDeltaMicroUnits: "0",
    launchGate: "ready",
    operationGate: "open",
    gateReasons: [],
    treasuryAssets: [],
    metrics: {},
    source: "worker",
    createdAt: now.toISOString()
  };
}

type FixtureOptions = {
  expiresAt?: string;
  quoteExpiresAt?: string;
  existingStatus?: "pending" | "submitted" | "confirmed" | "activating" | "activated";
  quoteReadStatus?: "quoted" | "accepted";
  retryQuote?: boolean;
  retryTransactionSubmission?: boolean;
  intentOverrides?: Record<string, unknown>;
};

function lifecycleFixture(options: FixtureOptions = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let quoteAttempts = 0;
  let transactionSubmissionAttempts = 0;
  let intentCreated = Boolean(options.existingStatus);
  let intentStatus = options.existingStatus || "pending";
  let activated = intentStatus === "activated";
  const sendExactUsdcTransfer = vi.fn(async () => txHash);
  const assertOnchainReady = vi.fn(async () => undefined);
  const verifyTransfer = vi.fn(async () => undefined);
  const writeReport = vi.fn();

  const intent = (status = intentStatus) => ({
    id: "payment-1",
    quoteId: "quote-1",
    chainId: 11155111,
    currency: "USDC",
    treasuryAddress,
    usdcContractAddress: usdcAddress,
    amountMicroUnits: "1020000",
    requiredConfirmations: 12,
    status,
    ...(status === "pending" && !options.existingStatus ? {} : { txHash }),
    ...(status === "activated" ? { ticketId: "ticket-1" } : {}),
    expiresAt: options.expiresAt || "2026-07-21T01:00:00.000Z",
    ...options.intentOverrides
  });

  const fetch: LifecycleFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push({ url, init });
    if (url.pathname === "/api/auth/privy/sync") {
      return response(200, { wallets: [{ address: burnerAddress }] });
    }
    if (url.pathname === "/api/auth/session") {
      return response(200, { authProvider: "privy", wallets: [{ address: burnerAddress }] });
    }
    if (url.pathname === "/api/markets") {
      return response(200, {
        outcomes: [
          {
            id: "outcome-a",
            marketId: "market-a",
            outcome: "Yes",
            eventGroupKey: "event-a",
            sourceActive: true,
            acceptingOrders: true,
            enableOrderBook: true,
            eligibility: { eligible: true }
          },
          {
            id: "outcome-b",
            marketId: "market-b",
            outcome: "No",
            eventGroupKey: "event-b",
            sourceActive: true,
            acceptingOrders: true,
            enableOrderBook: true,
            eligibility: { eligible: true }
          }
        ],
        pageInfo: { hasMore: false }
      });
    }
    if (url.pathname === "/api/quotes" && init.method === "POST") {
      quoteAttempts += 1;
      if (options.retryQuote && quoteAttempts === 1) throw new Error("connection_reset");
      return response(201, {
        id: "quote-1",
        status: "quoted",
        expiresAt: options.quoteExpiresAt || "2026-07-21T00:10:00.000Z",
        totalCostUsd: 1.02,
        legs: [{ id: "outcome-a" }, { id: "outcome-b" }]
      });
    }
    if (url.pathname === "/api/quotes/quote-1" && init.method === "GET") {
      return response(200, {
        id: "quote-1",
        status: options.quoteReadStatus || "quoted",
        expiresAt: options.quoteExpiresAt || "2026-07-21T00:10:00.000Z",
        totalCostUsd: 1.02,
        legs: [{ id: "outcome-a" }, { id: "outcome-b" }]
      });
    }
    if (url.pathname === "/api/quotes/quote-1/payment-intent" && init.method === "GET") {
      if (!intentCreated) return response(404, { error: "payment_intent_not_found" });
      if (activated) intentStatus = "activated";
      else if (intentStatus === "submitted") intentStatus = "confirmed";
      return response(200, intent(intentStatus));
    }
    if (url.pathname === "/api/quotes/quote-1/payment-intent" && init.method === "POST") {
      intentCreated = true;
      intentStatus = "pending";
      return response(201, intent("pending"));
    }
    if (url.pathname === "/api/quotes/quote-1/payment-transaction" && init.method === "POST") {
      transactionSubmissionAttempts += 1;
      if (options.retryTransactionSubmission && transactionSubmissionAttempts === 1) {
        return response(503, { error: "temporarily_unavailable" });
      }
      intentStatus = "submitted";
      return response(200, intent("submitted"));
    }
    if (url.pathname === "/api/quotes/quote-1/payment-activate" && init.method === "POST") {
      activated = true;
      return response(201, { ticketId: "ticket-1", quoteId: "quote-1", status: "accepted" });
    }
    if (url.pathname === "/api/tickets" && init.method === "GET") {
      return response(200, { tickets: [{ ticketId: "ticket-1", quoteId: "quote-1", status: "open" }] });
    }
    if (url.pathname === "/api/tickets/ticket-1" && init.method === "GET") {
      return response(200, {
        ticketId: "ticket-1",
        quoteId: "quote-1",
        status: "open",
        purchaseTxHash: txHash,
        purchaseChainId: 11155111,
        legs: [{ ticketLegId: "leg-1" }, { ticketLegId: "leg-2" }]
      });
    }
    if (url.pathname === "/api/ops/reconciliation/latest") {
      return response(200, { snapshot: reconciliationSnapshot() });
    }
    throw new Error(`unexpected_request:${init.method}:${url.pathname}`);
  };

  const wallet: SepoliaBurnerWallet = { address: burnerAddress, sendExactUsdcTransfer };
  const dependencies: SepoliaBotLifecycleDependencies = {
    environment: environment(),
    argv: [],
    fetch,
    randomId: () => "run-12345678",
    now: () => now,
    sleep: async () => undefined,
    pollIntervalMs: 0,
    maxPollAttempts: 5,
    requestAttempts: 2,
    loadBurnerWallet: async () => wallet,
    assertOnchainReady,
    verifyTransfer,
    runReconciliation: async () => reconciliationSnapshot(),
    verifyFrozenSettlementIdentities: async () => [
      {
        ticketLegId: "leg-1",
        authority: "polymarket_api",
        sourceMarketId: "market-a",
        sourceSnapshotId: "snapshot-a",
        validationProofId: "proof-a",
        frozenAt: now.toISOString()
      },
      {
        ticketLegId: "leg-2",
        authority: "polymarket_api",
        sourceMarketId: "market-b",
        sourceSnapshotId: "snapshot-b",
        validationProofId: "proof-b",
        frozenAt: now.toISOString()
      }
    ],
    writeReport
  };
  return {
    calls,
    dependencies,
    sendExactUsdcTransfer,
    assertOnchainReady,
    verifyTransfer,
    writeReport,
    counts: () => ({ quoteAttempts, transactionSubmissionAttempts })
  };
}

describe("supervised Sepolia bot lifecycle", () => {
  it("completes the positive lifecycle while retrying idempotently without sending twice", async () => {
    const fixture = lifecycleFixture({ retryQuote: true, retryTransactionSubmission: true });

    const report = await runSepoliaBotLifecycle(fixture.dependencies);

    expect(fixture.sendExactUsdcTransfer).toHaveBeenCalledTimes(1);
    expect(fixture.verifyTransfer).toHaveBeenCalledWith(txHash, expect.objectContaining({
      chainId: 11155111,
      from: burnerAddress,
      tokenAddress: usdcAddress,
      treasuryAddress,
      amountMicroUnits: 1020000n
    }));
    expect(fixture.counts()).toEqual({ quoteAttempts: 2, transactionSubmissionAttempts: 2 });
    const quoteCalls = fixture.calls.filter((call) => call.url.pathname === "/api/quotes");
    expect(quoteCalls).toHaveLength(2);
    expect(quoteCalls.map((call) => (call.init.headers as Record<string, string>)["idempotency-key"])).toEqual([
      "sepolia-positive-run-12345678",
      "sepolia-positive-run-12345678"
    ]);
    const transactionBodies = fixture.calls
      .filter((call) => call.url.pathname.endsWith("/payment-transaction"))
      .map((call) => JSON.parse(String(call.init.body)));
    expect(transactionBodies).toEqual([{ txHash }, { txHash }]);
    expect(report.paymentIntent.transitions.map((transition) => transition.status)).toEqual([
      "pending",
      "submitted",
      "confirmed",
      "activated"
    ]);
    expect(report).toMatchObject({
      txHash,
      quote: { id: "quote-1" },
      paymentIntent: { id: "payment-1", requiredConfirmations: 12 },
      ticket: { id: "ticket-1", portfolioVerified: true },
      reconciliation: { snapshotId: "reconciliation-1", launchGate: "ready", operationGate: "open" }
    });
    expect(fixture.writeReport).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(fixture.writeReport.mock.calls[0][0]);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(identityToken);
    expect(serialized).not.toContain(opsApiKey);
  });

  it("fails closed on an expired intent before chain inspection or signing", async () => {
    const fixture = lifecycleFixture({ expiresAt: now.toISOString() });

    await expect(runSepoliaBotLifecycle(fixture.dependencies)).rejects.toThrow("lifecycle_payment_intent_expired");
    expect(fixture.assertOnchainReady).not.toHaveBeenCalled();
    expect(fixture.sendExactUsdcTransfer).not.toHaveBeenCalled();
  });

  it.each([
    [{ chainId: 1 }, "lifecycle_payment_intent_chain_mismatch"],
    [{ treasuryAddress: burnerAddress }, "lifecycle_payment_intent_treasury_mismatch"],
    [{ amountMicroUnits: "1019999" }, "lifecycle_payment_intent_amount_mismatch"]
  ])("fails closed on payment intent invariant mismatch %#", async (intentOverrides, expectedError) => {
    const fixture = lifecycleFixture({ intentOverrides });

    await expect(runSepoliaBotLifecycle(fixture.dependencies)).rejects.toThrow(expectedError);
    expect(fixture.sendExactUsdcTransfer).not.toHaveBeenCalled();
  });

  it("resumes an already activated idempotent run without creating an intent or resending funds", async () => {
    const fixture = lifecycleFixture({
      existingStatus: "activated",
      quoteReadStatus: "accepted",
      quoteExpiresAt: "2026-07-20T00:00:00.000Z"
    });

    const report = await runSepoliaBotLifecycle(fixture.dependencies);

    expect(fixture.sendExactUsdcTransfer).not.toHaveBeenCalled();
    expect(fixture.assertOnchainReady).not.toHaveBeenCalled();
    expect(fixture.verifyTransfer).toHaveBeenCalledTimes(1);
    expect(fixture.calls.filter((call) => call.url.pathname.endsWith("/payment-intent") && call.init.method === "POST")).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.url.pathname.endsWith("/payment-transaction"))).toHaveLength(0);
    expect(report.paymentIntent.transitions.map((transition) => transition.status)).toEqual(["activated"]);
    expect(report.ticket.id).toBe("ticket-1");
  });

  it("redacts credentials and private-key-shaped fields while retaining public transaction identifiers", () => {
    const privateKey = `0x${"cd".repeat(32)}`;
    expect(
      redactLifecycleReport(
        {
          txHash,
          authorization: `Bearer ${accessToken}`,
          nested: { privateKey, identityToken, note: `credential=${opsApiKey}` }
        },
        [accessToken, identityToken, opsApiKey, privateKey]
      )
    ).toEqual({
      txHash,
      authorization: "[redacted]",
      nested: { privateKey: "[redacted]", identityToken: "[redacted]", note: "[redacted]" }
    });
  });
});
