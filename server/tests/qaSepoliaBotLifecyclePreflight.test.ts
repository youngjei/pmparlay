import { describe, expect, it } from "vitest";
import {
  loadSepoliaBotLifecyclePreflightConfiguration,
  redactPreflightReport,
  runSepoliaBotLifecyclePreflight,
  runSepoliaBotLifecyclePreflightCli,
  type PreflightFetch
} from "../qaSepoliaBotLifecyclePreflight";

const userToken = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
const opsApiKey = "ops-api-key-that-must-not-appear-in-output";

function response(status: number, body: unknown) {
  return { status, json: async () => body };
}

function baseEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    QA_SEPOLIA_API_BASE_URL: "http://127.0.0.1:8790",
    QA_SEPOLIA_BOT_ACCESS_TOKEN: userToken,
    QA_SEPOLIA_OPS_API_KEY: opsApiKey,
    QA_SEPOLIA_EXPECTED_FINANCIAL_GATE_REASON: "reconciliation_snapshot_absent",
    ...overrides
  };
}

function successfulFetch(options: { includeFinancialState?: boolean; quoteLegs?: unknown[] } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: PreflightFetch = async (url, init) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const paymentIntents = options.includeFinancialState
      ? [{ quoteId: "quote-preflight" }]
      : [];
    if (parsed.pathname === "/readyz") return response(200, { ok: true });
    if (parsed.pathname === "/api/account") return response(200, { balances: [], openTickets: 0 });
    if (parsed.pathname === "/api/payment-intents") return response(200, { paymentIntents });
    if (parsed.pathname === "/api/tickets") return response(200, { tickets: [] });
    if (parsed.pathname === "/api/ops/financial-gate") {
      return response(200, {
        gate: {
          allowed: false,
          launchGate: "blocked",
          operationGate: "blocked",
          reasons: ["reconciliation_snapshot_absent"]
        }
      });
    }
    if (parsed.pathname === "/api/markets") {
      return response(200, {
        outcomes: [
          {
            id: "market-a-yes",
            marketId: "market-a",
            eventGroupKey: "event-a",
            eligibility: { eligible: true },
            sourceActive: true,
            acceptingOrders: true,
            enableOrderBook: true
          },
          {
            id: "market-b-no",
            marketId: "market-b",
            eventGroupKey: "event-b",
            eligibility: { eligible: true },
            sourceActive: true,
            acceptingOrders: true,
            enableOrderBook: true
          }
        ]
      });
    }
    if (parsed.pathname === "/api/quotes" && init.method === "POST") {
      return response(201, {
        id: "quote-preflight",
        status: "quoted",
        legs: options.quoteLegs || [{ id: "market-a-yes" }, { id: "market-b-no" }]
      });
    }
    if (parsed.pathname === "/api/quotes/quote-preflight" && init.method === "GET") {
      return response(200, {
        id: "quote-preflight",
        status: "quoted",
        legs: options.quoteLegs || [{ id: "market-a-yes" }, { id: "market-b-no" }]
      });
    }
    if (parsed.pathname === "/api/quotes/quote-preflight/payment-intent" && init.method === "POST") {
      return response(503, {
        error: "financial_operations_unavailable",
        detail: "reconciliation_snapshot_absent"
      });
    }
    if (parsed.pathname === "/api/quotes/quote-preflight/payment-intent" && init.method === "GET") {
      return response(404, { error: "payment_intent_not_found" });
    }
    throw new Error(`unexpected request: ${init.method} ${parsed.pathname}`);
  };
  return { calls, fetch };
}

describe("Sepolia bot lifecycle preflight", () => {
  it("runs only the non-financial HTTP preflight and emits a redacted report", async () => {
    const { calls, fetch } = successfulFetch();
    const reports: Record<string, unknown>[] = [];

    const report = await runSepoliaBotLifecyclePreflight({
      environment: baseEnvironment(),
      fetch,
      randomId: () => "run-12345678",
      now: () => new Date("2026-07-14T08:00:00.000Z"),
      writeReport: (item) => reports.push(item)
    });

    expect(report.checks.quote.idempotencyKey).toBe("sepolia-bot-preflight-run-12345678");
    expect(report.mode).toBe("non_fund_moving_preflight");
    expect(report.checks.paymentIntentCreation).toEqual({ status: 503, error: "financial_operations_unavailable" });
    expect(report.checks.quote).toMatchObject({ legCount: 2, persistence: "expected_non_financial_write" });
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0])).not.toContain(userToken);
    expect(JSON.stringify(reports[0])).not.toContain(opsApiKey);
    expect(calls.filter((call) => call.init.method === "POST").map((call) => new URL(call.url).pathname)).toEqual([
      "/api/quotes",
      "/api/quotes/quote-preflight/payment-intent"
    ]);
    expect(calls.find((call) => new URL(call.url).pathname === "/api/account")?.init.headers).toMatchObject({
      authorization: `Bearer ${userToken}`
    });
    expect(calls.find((call) => new URL(call.url).pathname === "/api/ops/financial-gate")?.init.headers).toMatchObject({
      authorization: `Bearer ${opsApiKey}`
    });
  });

  it("fails when the blocked payment-intent probe leaves financial state", async () => {
    const { fetch } = successfulFetch({ includeFinancialState: true });

    await expect(
      runSepoliaBotLifecyclePreflight({
        environment: baseEnvironment(),
        fetch,
        randomId: () => "run-12345678"
      })
    ).rejects.toThrow("preflight_blocked_quote_financial_state_appeared");
  });

  it("rejects malformed or substituted quote legs before probing payment", async () => {
    for (const quoteLegs of [[{}, {}], [{ id: "market-a-yes" }, { id: "substituted-market" }]]) {
      const { fetch } = successfulFetch({ quoteLegs });
      await expect(
        runSepoliaBotLifecyclePreflight({
          environment: baseEnvironment(),
          fetch,
          randomId: () => "run-12345678"
        })
      ).rejects.toThrow(/preflight_quote_(response_invalid|not_eligible)/);
    }
  });

  it("refuses transaction, activation, secret-output, and non-local configurations before requests", async () => {
    expect(() =>
      loadSepoliaBotLifecyclePreflightConfiguration({
        environment: baseEnvironment({ QA_SEPOLIA_LIFECYCLE_SUBMIT_TX: "true" })
      })
    ).toThrow("preflight_unsafe_configuration_forbidden");
    expect(() =>
      loadSepoliaBotLifecyclePreflightConfiguration({
        environment: baseEnvironment({ QA_SEPOLIA_LIFECYCLE_ACTIVATE: "true" })
      })
    ).toThrow("preflight_unsafe_configuration_forbidden");
    expect(() =>
      loadSepoliaBotLifecyclePreflightConfiguration({
        environment: baseEnvironment({ QA_SEPOLIA_PREFLIGHT_INCLUDE_SECRETS: "true" })
      })
    ).toThrow("preflight_unsafe_configuration_forbidden");
    expect(() =>
      loadSepoliaBotLifecyclePreflightConfiguration({
        environment: baseEnvironment({ QA_SEPOLIA_API_BASE_URL: "https://staging.example.test" })
      })
    ).toThrow("preflight_api_base_url_must_be_local_http");
  });

  it("redacts secret-shaped values in reports and CLI failures", async () => {
    expect(
      redactPreflightReport({
        authorization: `Bearer ${userToken}`,
        nested: { opsApiKey, detail: `token=${userToken}` }
      })
    ).toEqual({ authorization: "[redacted]", nested: { opsApiKey: "[redacted]", detail: "[redacted]" } });

    const reports: Record<string, unknown>[] = [];
    const result = await runSepoliaBotLifecyclePreflightCli({
      environment: baseEnvironment({ QA_SEPOLIA_LIFECYCLE_ACTIVATE: "true" }),
      writeReport: (item) => reports.push(item)
    });
    expect(result).toBe(1);
    expect(reports).toEqual([
      { runner: "qa-sepolia-bot-lifecycle-preflight", status: "failed", error: "preflight_unsafe_configuration_forbidden" }
    ]);
  });
});
