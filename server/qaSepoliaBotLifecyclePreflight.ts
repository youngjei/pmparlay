import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_NAME = "qa-sepolia-bot-lifecycle-preflight";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8790";
const DEFAULT_STAKE_USD = 1;

type JsonObject = Record<string, unknown>;

export type PreflightFetchResponse = {
  status: number;
  json(): Promise<unknown>;
};

export type PreflightFetch = (url: string, init: RequestInit) => Promise<PreflightFetchResponse>;

export type SepoliaBotLifecyclePreflightDependencies = {
  fetch?: PreflightFetch;
  environment?: NodeJS.ProcessEnv;
  argv?: string[];
  apiBaseUrl?: string;
  userAccessToken?: string;
  opsApiKey?: string;
  expectedFinancialGateReason?: string;
  stakeUsd?: number;
  now?: () => Date;
  randomId?: () => string;
  writeReport?: (report: JsonObject) => void;
};

export type SepoliaBotLifecyclePreflightReport = {
  runner: typeof RUNNER_NAME;
  status: "passed";
  mode: "non_fund_moving_preflight";
  runId: string;
  startedAt: string;
  apiBaseUrl: string;
  checks: {
    ready: true;
    userAuthentication: true;
    opsAuthentication: true;
    account: { balanceCount: number; openTickets: number };
    paymentIntents: { observed: number; noIntentForQuote: true };
    tickets: { observed: number; noTicketForQuote: true };
    quote: {
      id: string;
      status: "quoted";
      legCount: number;
      idempotencyKey: string;
      persistence: "expected_non_financial_write";
    };
    financialGate: {
      allowed: false;
      launchGate: string;
      operationGate: string;
      expectedReason: string;
    };
    paymentIntentCreation: { status: 503; error: "financial_operations_unavailable" };
  };
};

class PreflightError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type PreflightConfiguration = {
  apiBaseUrl: URL;
  userAccessToken: string;
  opsApiKey: string;
  expectedFinancialGateReason: string;
  stakeUsd: number;
};

type MarketOutcome = {
  id: string;
  marketId?: string;
  eventGroupKey?: string;
  eligibility?: { eligible?: boolean };
  sourceActive?: boolean;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
};

type Quote = {
  id: string;
  status: string;
  legs: Array<{ id: string }>;
};

function valueFrom(deps: SepoliaBotLifecyclePreflightDependencies, key: string, injected?: string) {
  return injected?.trim() || deps.environment?.[key]?.trim() || process.env[key]?.trim();
}

function rejectUnsafeOptions(environment: NodeJS.ProcessEnv, argv: string[]) {
  const forbiddenEnvironment = /(?:^|_)(?:SUBMIT(?:_TX|_TRANSACTION)?|TX_SUBMISSION|TRANSACTION_SUBMISSION|SIGN(?:ING)?|WRITE_CONTRACT|ACTIVATE|ACTIVATION|INCLUDE_SECRETS?|OUTPUT_SECRETS?)(?:$|_)/;
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith("QA_SEPOLIA_") && forbiddenEnvironment.test(key) && value && value.trim().toLowerCase() !== "false") {
      throw new PreflightError("preflight_unsafe_configuration_forbidden");
    }
  }

  if (argv.some((argument) => /^(--(?:submit(?:-tx|-transaction)?|sign|write-contract|activate|include-secrets?|output-secrets?))(?:=|$)/.test(argument))) {
    throw new PreflightError("preflight_unsafe_configuration_forbidden");
  }
}

function localApiBaseUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreflightError("preflight_api_base_url_invalid");
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new PreflightError("preflight_api_base_url_must_be_local_http");
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

export function loadSepoliaBotLifecyclePreflightConfiguration(
  deps: SepoliaBotLifecyclePreflightDependencies = {}
): PreflightConfiguration {
  const environment = deps.environment || process.env;
  rejectUnsafeOptions(environment, deps.argv || process.argv.slice(2));

  const userAccessToken = valueFrom(deps, "QA_SEPOLIA_BOT_ACCESS_TOKEN", deps.userAccessToken);
  const opsApiKey =
    valueFrom(deps, "QA_SEPOLIA_OPS_API_KEY", deps.opsApiKey) ||
    deps.environment?.OPS_API_KEY?.trim() ||
    process.env.OPS_API_KEY?.trim();
  const expectedFinancialGateReason = valueFrom(
    deps,
    "QA_SEPOLIA_EXPECTED_FINANCIAL_GATE_REASON",
    deps.expectedFinancialGateReason
  );
  const configuredStake = valueFrom(deps, "QA_SEPOLIA_PREFLIGHT_STAKE_USD");
  const rawStake = deps.stakeUsd ?? (configuredStake ? Number(configuredStake) : DEFAULT_STAKE_USD);

  if (!userAccessToken) throw new PreflightError("preflight_user_access_token_missing");
  if (!opsApiKey) throw new PreflightError("preflight_ops_api_key_missing");
  if (!expectedFinancialGateReason || !/^[A-Za-z0-9._:-]{1,200}$/.test(expectedFinancialGateReason)) {
    throw new PreflightError("preflight_expected_financial_gate_reason_missing");
  }
  if (!Number.isFinite(rawStake) || rawStake <= 0 || rawStake > 10_000) {
    throw new PreflightError("preflight_stake_usd_invalid");
  }

  return {
    apiBaseUrl: localApiBaseUrl(deps.apiBaseUrl || valueFrom(deps, "QA_SEPOLIA_API_BASE_URL") || DEFAULT_API_BASE_URL),
    userAccessToken,
    opsApiKey,
    expectedFinancialGateReason,
    stakeUsd: rawStake
  };
}

function object(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PreflightError(code);
  return value as JsonObject;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new PreflightError(code);
  return value;
}

function responseStatus(response: PreflightFetchResponse, expected: number, code: string) {
  if (response.status !== expected) throw new PreflightError(code);
}

function apiUrl(baseUrl: URL, path: string) {
  return new URL(path, baseUrl).toString();
}

function userHeaders(accessToken: string, extra: Record<string, string> = {}) {
  return {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    ...extra
  };
}

function opsHeaders(opsApiKey: string) {
  return {
    accept: "application/json",
    authorization: `Bearer ${opsApiKey}`
  };
}

function eligibleQuoteLegs(payload: unknown) {
  const outcomes = array(object(payload, "preflight_market_response_invalid").outcomes, "preflight_market_response_invalid") as MarketOutcome[];
  const selected: MarketOutcome[] = [];
  const marketIds = new Set<string>();
  const eventGroups = new Set<string>();

  for (const outcome of outcomes) {
    if (
      !outcome ||
      typeof outcome.id !== "string" ||
      outcome.eligibility?.eligible !== true ||
      outcome.sourceActive === false ||
      outcome.closed === true ||
      outcome.archived === true ||
      outcome.acceptingOrders === false ||
      outcome.enableOrderBook !== true
    ) {
      continue;
    }
    const marketId = outcome.marketId || outcome.id;
    const eventGroup = outcome.eventGroupKey || marketId;
    if (marketIds.has(marketId) || eventGroups.has(eventGroup)) continue;
    selected.push(outcome);
    marketIds.add(marketId);
    eventGroups.add(eventGroup);
    if (selected.length === 2) return selected.map((item) => ({ id: item.id }));
  }

  throw new PreflightError("preflight_eligible_quote_legs_unavailable");
}

function quoteFrom(payload: unknown, code: string): Quote {
  const quote = object(payload, code);
  if (typeof quote.id !== "string" || !quote.id.trim() || typeof quote.status !== "string" || !Array.isArray(quote.legs)) {
    throw new PreflightError(code);
  }
  const legs = quote.legs.map((leg) => {
    const parsed = object(leg, code);
    if (typeof parsed.id !== "string" || !parsed.id.trim()) throw new PreflightError(code);
    return { id: parsed.id };
  });
  return { id: quote.id, status: quote.status, legs };
}

function quoteMatchesRequestedLegs(quote: Quote, requestedLegs: Array<{ id: string }>) {
  return quote.legs.length === requestedLegs.length && quote.legs.every((leg, index) => leg.id === requestedLegs[index]?.id);
}

function ticketReferencesQuote(tickets: unknown[], quoteId: string) {
  return tickets.some((ticket) => object(ticket, "preflight_ticket_response_invalid").quoteId === quoteId);
}

function paymentIntentReferencesQuote(paymentIntents: unknown[], quoteId: string) {
  return paymentIntents.some((intent) => object(intent, "preflight_payment_intent_response_invalid").quoteId === quoteId);
}

const sensitiveKey = /authorization|api[_-]?key|token|secret|password|private|signature/i;
const jwtPattern = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

export function redactPreflightReport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPreflightReport);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, item]) => [key, sensitiveKey.test(key) ? "[redacted]" : redactPreflightReport(item)])
    );
  }
  if (typeof value === "string") {
    if (jwtPattern.test(value) || /\bBearer\s+/i.test(value) || /(?:api[_-]?key|token|secret|password|private[_-]?key)\s*[=:]/i.test(value)) {
      return "[redacted]";
    }
  }
  return value;
}

function emitReport(report: JsonObject, writeReport?: (report: JsonObject) => void) {
  const redacted = redactPreflightReport(report) as JsonObject;
  if (writeReport) {
    writeReport(redacted);
    return;
  }
  process.stdout.write(`${JSON.stringify(redacted)}\n`);
}

export async function runSepoliaBotLifecyclePreflight(
  deps: SepoliaBotLifecyclePreflightDependencies = {}
): Promise<SepoliaBotLifecyclePreflightReport> {
  const configuration = loadSepoliaBotLifecyclePreflightConfiguration(deps);
  const request = deps.fetch || ((url: string, init: RequestInit) => fetch(url, init));
  const now = deps.now || (() => new Date());
  const startedAt = now().toISOString();
  const runId = (deps.randomId || randomUUID)();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(runId)) throw new PreflightError("preflight_run_id_invalid");
  const idempotencyKey = `sepolia-bot-preflight-${runId}`;

  const readyResponse = await request(apiUrl(configuration.apiBaseUrl, "/readyz"), { method: "GET", headers: { accept: "application/json" } });
  responseStatus(readyResponse, 200, "preflight_ready_check_failed");
  const ready = object(await readyResponse.json(), "preflight_ready_response_invalid");
  if (ready.ok !== true) throw new PreflightError("preflight_ready_response_invalid");

  const accountResponse = await request(apiUrl(configuration.apiBaseUrl, "/api/account"), {
    method: "GET",
    headers: userHeaders(configuration.userAccessToken)
  });
  responseStatus(accountResponse, 200, "preflight_user_auth_or_account_failed");
  const account = object(await accountResponse.json(), "preflight_account_response_invalid");
  const balances = array(account.balances, "preflight_account_response_invalid");
  if (typeof account.openTickets !== "number") throw new PreflightError("preflight_account_response_invalid");

  const gateResponse = await request(apiUrl(configuration.apiBaseUrl, "/api/ops/financial-gate"), {
    method: "GET",
    headers: opsHeaders(configuration.opsApiKey)
  });
  responseStatus(gateResponse, 200, "preflight_ops_auth_or_gate_read_failed");
  const gate = object(object(await gateResponse.json(), "preflight_financial_gate_response_invalid").gate, "preflight_financial_gate_response_invalid");
  const gateReasons = array(gate.reasons, "preflight_financial_gate_response_invalid");
  if (
    gate.allowed !== false ||
    typeof gate.launchGate !== "string" ||
    typeof gate.operationGate !== "string" ||
    !gateReasons.includes(configuration.expectedFinancialGateReason)
  ) {
    throw new PreflightError("preflight_financial_gate_not_closed_as_expected");
  }

  const marketsResponse = await request(apiUrl(configuration.apiBaseUrl, "/api/markets?limit=100"), {
    method: "GET",
    headers: { accept: "application/json" }
  });
  responseStatus(marketsResponse, 200, "preflight_market_read_failed");
  const legs = eligibleQuoteLegs(await marketsResponse.json());

  const createQuoteResponse = await request(apiUrl(configuration.apiBaseUrl, "/api/quotes"), {
    method: "POST",
    headers: userHeaders(configuration.userAccessToken, {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    }),
    body: JSON.stringify({ stakeUsd: configuration.stakeUsd, legs })
  });
  responseStatus(createQuoteResponse, 201, "preflight_quote_create_failed");
  const quote = quoteFrom(await createQuoteResponse.json(), "preflight_quote_response_invalid");
  if (quote.status !== "quoted" || !quoteMatchesRequestedLegs(quote, legs)) {
    throw new PreflightError("preflight_quote_not_eligible");
  }

  const readQuoteResponse = await request(apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(quote.id)}`), {
    method: "GET",
    headers: userHeaders(configuration.userAccessToken)
  });
  responseStatus(readQuoteResponse, 200, "preflight_quote_read_failed");
  const readQuote = quoteFrom(await readQuoteResponse.json(), "preflight_quote_read_response_invalid");
  if (
    readQuote.id !== quote.id ||
    readQuote.status !== "quoted" ||
    !quoteMatchesRequestedLegs(readQuote, legs)
  ) {
    throw new PreflightError("preflight_quote_read_mismatch");
  }

  const createPaymentIntentResponse = await request(
    apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(quote.id)}/payment-intent`),
    { method: "POST", headers: userHeaders(configuration.userAccessToken) }
  );
  responseStatus(createPaymentIntentResponse, 503, "preflight_payment_intent_creation_not_blocked");
  const paymentIntentFailure = object(await createPaymentIntentResponse.json(), "preflight_payment_intent_failure_response_invalid");
  if (
    paymentIntentFailure.error !== "financial_operations_unavailable" ||
    typeof paymentIntentFailure.detail !== "string" ||
    !paymentIntentFailure.detail.includes(configuration.expectedFinancialGateReason)
  ) {
    throw new PreflightError("preflight_payment_intent_gate_reason_mismatch");
  }

  const readPaymentIntentResponse = await request(
    apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(quote.id)}/payment-intent`),
    { method: "GET", headers: userHeaders(configuration.userAccessToken) }
  );
  responseStatus(readPaymentIntentResponse, 404, "preflight_payment_intent_state_appeared");

  const paymentsAfterResponse = await request(apiUrl(configuration.apiBaseUrl, "/api/payment-intents"), {
    method: "GET",
    headers: userHeaders(configuration.userAccessToken)
  });
  responseStatus(paymentsAfterResponse, 200, "preflight_payment_intents_recheck_failed");
  const paymentIntents = array(
    object(await paymentsAfterResponse.json(), "preflight_payment_intents_response_invalid").paymentIntents,
    "preflight_payment_intents_response_invalid"
  );

  const ticketsAfterResponse = await request(apiUrl(configuration.apiBaseUrl, "/api/tickets"), {
    method: "GET",
    headers: userHeaders(configuration.userAccessToken)
  });
  responseStatus(ticketsAfterResponse, 200, "preflight_tickets_recheck_failed");
  const tickets = array(
    object(await ticketsAfterResponse.json(), "preflight_tickets_response_invalid").tickets,
    "preflight_tickets_response_invalid"
  );

  if (
    paymentIntentReferencesQuote(paymentIntents, quote.id) ||
    ticketReferencesQuote(tickets, quote.id)
  ) {
    throw new PreflightError("preflight_blocked_quote_financial_state_appeared");
  }

  const report: SepoliaBotLifecyclePreflightReport = {
    runner: RUNNER_NAME,
    status: "passed",
    mode: "non_fund_moving_preflight",
    runId,
    startedAt,
    apiBaseUrl: configuration.apiBaseUrl.toString(),
    checks: {
      ready: true,
      userAuthentication: true,
      opsAuthentication: true,
      account: { balanceCount: balances.length, openTickets: account.openTickets },
      paymentIntents: { observed: paymentIntents.length, noIntentForQuote: true },
      tickets: { observed: tickets.length, noTicketForQuote: true },
      quote: {
        id: quote.id,
        status: "quoted",
        legCount: quote.legs.length,
        idempotencyKey,
        persistence: "expected_non_financial_write"
      },
      financialGate: {
        allowed: false,
        launchGate: gate.launchGate,
        operationGate: gate.operationGate,
        expectedReason: configuration.expectedFinancialGateReason
      },
      paymentIntentCreation: { status: 503, error: "financial_operations_unavailable" }
    }
  };
  emitReport(report, deps.writeReport);
  return report;
}

export async function runSepoliaBotLifecyclePreflightCli(deps: SepoliaBotLifecyclePreflightDependencies = {}) {
  try {
    await runSepoliaBotLifecyclePreflight(deps);
    return 0;
  } catch (error) {
    const code = error instanceof PreflightError ? error.code : "preflight_failed";
    emitReport({ runner: RUNNER_NAME, status: "failed", error: code }, deps.writeReport);
    return 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  process.exitCode = await runSepoliaBotLifecyclePreflightCli();
}
