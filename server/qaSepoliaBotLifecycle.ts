import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type Hash,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS, SEPOLIA_PAYMENT_CHAIN_ID, SEPOLIA_REQUIRED_CONFIRMATIONS } from "./config";
import { getPool } from "./db/client";
import type { FinancialReconciliationSnapshot } from "./db/reconciliationRepository";
import { processFinancialReconciliation } from "./workers/reconciliationWorker";

const RUNNER_NAME = "qa-sepolia-bot-lifecycle";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8790";
const DEFAULT_STAKE_USD = 1;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 240;
const DEFAULT_REQUEST_ATTEMPTS = 3;
const DEFAULT_BURNER_FILE = path.resolve(".context/sepolia-burner.env");
const FUND_MOVEMENT_CONFIRMATION = "sepolia-positive-lifecycle";

type JsonObject = Record<string, unknown>;
type PaymentStatus = "pending" | "submitted" | "confirmed" | "activating" | "activated" | "expired" | "failed" | "recoverable";

export type LifecycleFetchResponse = {
  status: number;
  json(): Promise<unknown>;
};

export type LifecycleFetch = (url: string, init: RequestInit) => Promise<LifecycleFetchResponse>;

export type ExactUsdcTransfer = {
  chainId: typeof SEPOLIA_PAYMENT_CHAIN_ID;
  from: Address;
  tokenAddress: Address;
  treasuryAddress: Address;
  amountMicroUnits: bigint;
};

export type SepoliaBurnerWallet = {
  address: Address;
  sendExactUsdcTransfer(input: ExactUsdcTransfer & { rpcUrl: string }): Promise<Hash>;
};

export type FrozenSettlementIdentitySummary = {
  ticketLegId: string;
  authority: string;
  sourceMarketId: string;
  sourceSnapshotId: string;
  validationProofId: string;
  frozenAt: string;
};

export type SepoliaBotLifecycleDependencies = {
  fetch?: LifecycleFetch;
  environment?: NodeJS.ProcessEnv;
  argv?: string[];
  apiBaseUrl?: string;
  userAccessToken?: string;
  identityToken?: string;
  opsApiKey?: string;
  stakeUsd?: number;
  now?: () => Date;
  randomId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  requestAttempts?: number;
  loadBurnerWallet?: () => Promise<SepoliaBurnerWallet>;
  assertOnchainReady?: (input: ExactUsdcTransfer & { rpcUrl: string }) => Promise<void>;
  verifyTransfer?: (txHash: Hash, expected: ExactUsdcTransfer & { rpcUrl: string }) => Promise<void>;
  runReconciliation?: () => Promise<FinancialReconciliationSnapshot>;
  verifyFrozenSettlementIdentities?: (ticketId: string) => Promise<FrozenSettlementIdentitySummary[]>;
  writeReport?: (report: JsonObject) => void;
};

export type LifecycleStateTransition = {
  status: PaymentStatus;
  observedAt: string;
};

export type SepoliaBotLifecycleReport = {
  runner: typeof RUNNER_NAME;
  status: "passed";
  mode: "supervised_fund_moving";
  runId: string;
  startedAt: string;
  completedAt: string;
  chainId: typeof SEPOLIA_PAYMENT_CHAIN_ID;
  burnerAddress: Address;
  treasuryAddress: Address;
  usdcContractAddress: Address;
  txHash: Hash;
  quote: { id: string; idempotencyKey: string; legIds: string[] };
  paymentIntent: { id: string; amountMicroUnits: string; requiredConfirmations: number; transitions: LifecycleStateTransition[] };
  ticket: { id: string; portfolioVerified: true; frozenSettlementIdentities: FrozenSettlementIdentitySummary[] };
  reconciliation: {
    snapshotId: string;
    launchGate: "ready";
    operationGate: "open";
    unexplainedDeltaMicroUnits: string;
  };
};

type LifecycleConfiguration = {
  apiBaseUrl: URL;
  accessToken: string;
  identityToken: string;
  opsApiKey: string;
  rpcUrl: string;
  treasuryAddress: Address;
  usdcContractAddress: Address;
  stakeUsd: number;
  runId?: string;
  outcomeIds: string[];
  marketOutcomePairs: Array<{ marketId: string; outcome: string }>;
};

type MarketOutcome = {
  id?: unknown;
  marketId?: unknown;
  outcome?: unknown;
  eventGroupKey?: unknown;
  sourceActive?: unknown;
  closed?: unknown;
  archived?: unknown;
  acceptingOrders?: unknown;
  enableOrderBook?: unknown;
  eligibility?: { eligible?: unknown };
};

type Quote = {
  id: string;
  status: string;
  expiresAt: string;
  totalCostUsd: number;
  legs: Array<{ id: string }>;
};

type PaymentIntent = {
  id: string;
  quoteId: string;
  chainId: number;
  currency: string;
  treasuryAddress: string;
  usdcContractAddress: string;
  amountMicroUnits: string;
  requiredConfirmations: number;
  status: PaymentStatus;
  txHash?: string;
  ticketId?: string;
  expiresAt: string;
};

type Ticket = {
  ticketId: string;
  quoteId: string;
  status: string;
  purchaseTxHash?: string;
  purchaseChainId?: number;
  legs: unknown[];
};

export class SepoliaBotLifecycleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new SepoliaBotLifecycleError(code);
}

function object(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonObject;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) fail(code);
  return value;
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string, injected?: string) {
  return injected?.trim() || environment[key]?.trim();
}

function flagValues(argv: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === name) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("lifecycle_cli_option_value_missing");
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    }
  }
  return values.map((value) => value.trim()).filter(Boolean);
}

function singleFlagValue(argv: string[], name: string) {
  const values = flagValues(argv, name);
  if (values.length > 1) fail("lifecycle_cli_option_duplicated");
  return values[0];
}

function parseCsv(value?: string) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function localApiBaseUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("lifecycle_api_base_url_invalid");
  }
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail("lifecycle_api_base_url_must_be_local_http");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function requiredAddress(value: string | undefined, code: string) {
  if (!value || !isAddress(value, { strict: false })) fail(code);
  const address = getAddress(value);
  if (address === zeroAddress) fail(code);
  return address;
}

export function loadSepoliaBotLifecycleConfiguration(
  deps: SepoliaBotLifecycleDependencies = {}
): LifecycleConfiguration {
  const environment = deps.environment || process.env;
  const argv = deps.argv || process.argv.slice(2);
  const accessToken = environmentValue(environment, "QA_SEPOLIA_BOT_ACCESS_TOKEN", deps.userAccessToken);
  const identityToken = environmentValue(environment, "QA_SEPOLIA_BOT_IDENTITY_TOKEN", deps.identityToken);
  const opsApiKey = environmentValue(environment, "QA_SEPOLIA_OPS_API_KEY", deps.opsApiKey) || environment.OPS_API_KEY?.trim();
  const rpcUrl = environment.ETHEREUM_RPC_URL?.trim();
  const rawStake = deps.stakeUsd ?? Number(singleFlagValue(argv, "--stake-usd") || environment.QA_SEPOLIA_STAKE_USD || DEFAULT_STAKE_USD);
  const outcomeIds = [
    ...flagValues(argv, "--outcome-id"),
    ...parseCsv(environment.QA_SEPOLIA_OUTCOME_IDS)
  ];
  const markets = [...flagValues(argv, "--market"), ...parseCsv(environment.QA_SEPOLIA_MARKET_IDS)];
  const outcomes = [...flagValues(argv, "--outcome"), ...parseCsv(environment.QA_SEPOLIA_OUTCOMES)];

  if (environment.NODE_ENV !== "production" || environment.ACCOUNTING_MODE !== "house_book_usdc") {
    fail("lifecycle_requires_production_house_book_staging");
  }
  if (environment.QA_SEPOLIA_LIFECYCLE_CONFIRM !== FUND_MOVEMENT_CONFIRMATION) {
    fail("lifecycle_fund_movement_not_confirmed");
  }
  if (Number(environment.SETTLEMENT_CHAIN_ID) !== SEPOLIA_PAYMENT_CHAIN_ID) fail("lifecycle_payment_chain_mismatch");
  if (Number(environment.USDC_REQUIRED_CONFIRMATIONS) !== SEPOLIA_REQUIRED_CONFIRMATIONS) {
    fail("lifecycle_confirmation_policy_mismatch");
  }
  if (!accessToken || accessToken.length < 20) fail("lifecycle_privy_access_token_missing");
  if (!identityToken || identityToken.length < 20) fail("lifecycle_privy_identity_token_missing");
  if (!opsApiKey || opsApiKey.length < 20) fail("lifecycle_ops_api_key_missing");
  if (!rpcUrl) fail("lifecycle_rpc_url_missing");
  try {
    new URL(rpcUrl);
  } catch {
    fail("lifecycle_rpc_url_invalid");
  }
  if (!Number.isFinite(rawStake) || rawStake <= 0 || rawStake > 10_000) fail("lifecycle_stake_invalid");
  if (outcomeIds.length > 0 && (markets.length > 0 || outcomes.length > 0)) fail("lifecycle_cli_selector_conflict");
  if (markets.length !== outcomes.length) fail("lifecycle_market_outcome_pair_mismatch");
  if ((outcomeIds.length > 0 && (outcomeIds.length < 2 || outcomeIds.length > 12)) || (markets.length > 0 && (markets.length < 2 || markets.length > 12))) {
    fail("lifecycle_leg_count_invalid");
  }

  const treasuryAddress = requiredAddress(environment.TREASURY_SAFE_ADDRESS, "lifecycle_treasury_address_invalid");
  const usdcContractAddress = requiredAddress(environment.USDC_CONTRACT_ADDRESS, "lifecycle_usdc_address_invalid");
  if (usdcContractAddress.toLowerCase() !== CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS.toLowerCase()) {
    fail("lifecycle_usdc_contract_mismatch");
  }

  return {
    apiBaseUrl: localApiBaseUrl(deps.apiBaseUrl || environment.QA_SEPOLIA_API_BASE_URL || DEFAULT_API_BASE_URL),
    accessToken,
    identityToken,
    opsApiKey,
    rpcUrl,
    treasuryAddress,
    usdcContractAddress,
    stakeUsd: rawStake,
    runId: singleFlagValue(argv, "--run-id") || environment.QA_SEPOLIA_LIFECYCLE_RUN_ID?.trim(),
    outcomeIds,
    marketOutcomePairs: markets.map((marketId, index) => ({ marketId, outcome: outcomes[index]! }))
  };
}

export async function loadSepoliaBurnerWallet(filename = DEFAULT_BURNER_FILE): Promise<SepoliaBurnerWallet> {
  const resolvedFilename = path.resolve(filename);
  const expectedDirectory = path.resolve(".context");
  let metadata;
  try {
    metadata = await lstat(resolvedFilename);
  } catch {
    fail("lifecycle_burner_file_missing");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    fail("lifecycle_burner_file_permissions_invalid");
  }
  if (path.dirname(await realpath(resolvedFilename)) !== await realpath(expectedDirectory)) {
    fail("lifecycle_burner_file_location_invalid");
  }

  const values = parse(await readFile(resolvedFilename));
  const privateKey = values.SEPOLIA_BURNER_PRIVATE_KEY;
  const configuredAddress = values.SEPOLIA_BURNER_ADDRESS;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey) || !configuredAddress) {
    fail("lifecycle_burner_configuration_invalid");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address !== requiredAddress(configuredAddress, "lifecycle_burner_address_invalid")) {
    fail("lifecycle_burner_address_mismatch");
  }

  return {
    address: account.address,
    async sendExactUsdcTransfer(input) {
      const client = createWalletClient({ account, chain: sepolia, transport: http(input.rpcUrl) });
      const publicClient = createPublicClient({ chain: sepolia, transport: http(input.rpcUrl) });
      const simulation = await publicClient.simulateContract({
        account,
        address: input.tokenAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [input.treasuryAddress, input.amountMicroUnits]
      });
      return await client.writeContract(simulation.request);
    }
  };
}

async function assertDefaultOnchainReady(input: ExactUsdcTransfer & { rpcUrl: string }) {
  const client = createPublicClient({ chain: sepolia, transport: http(input.rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== input.chainId) fail("lifecycle_rpc_chain_mismatch");
  const [safeCode, tokenCode, ethBalance, usdcBalance] = await Promise.all([
    client.getCode({ address: input.treasuryAddress }),
    client.getCode({ address: input.tokenAddress }),
    client.getBalance({ address: input.from }),
    client.readContract({ address: input.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [input.from] })
  ]);
  if (!safeCode || safeCode === "0x") fail("lifecycle_treasury_not_deployed");
  if (!tokenCode || tokenCode === "0x") fail("lifecycle_usdc_not_deployed");
  if (ethBalance <= 0n) fail("lifecycle_burner_eth_balance_empty");
  if (usdcBalance < input.amountMicroUnits) fail("lifecycle_burner_usdc_balance_insufficient");
}

async function verifyDefaultTransfer(txHash: Hash, expected: ExactUsdcTransfer & { rpcUrl: string }) {
  const client = createPublicClient({ chain: sepolia, transport: http(expected.rpcUrl) });
  let transaction;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      transaction = await client.getTransaction({ hash: txHash });
      break;
    } catch {
      if (attempt === 9) fail("lifecycle_transaction_unavailable");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!transaction || getAddress(transaction.from) !== expected.from) fail("lifecycle_transaction_sender_mismatch");
  if (!transaction.to || getAddress(transaction.to) !== expected.tokenAddress || transaction.value !== 0n) {
    fail("lifecycle_transaction_contract_mismatch");
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.input });
  } catch {
    fail("lifecycle_transaction_calldata_invalid");
  }
  if (
    decoded.functionName !== "transfer" ||
    decoded.args.length !== 2 ||
    getAddress(String(decoded.args[0])) !== expected.treasuryAddress ||
    BigInt(decoded.args[1] as bigint) !== expected.amountMicroUnits
  ) {
    fail("lifecycle_transaction_transfer_mismatch");
  }
}

async function verifyDefaultFrozenSettlementIdentities(ticketId: string) {
  const result = await getPool().query<{
    ticketLegId: string;
    authority: string | null;
    sourceMarketId: string | null;
    sourceSnapshotId: string | null;
    validationProofId: string | null;
    frozenAt: Date | null;
  }>(
    `SELECT
       id AS "ticketLegId",
       settlement_authority AS authority,
       settlement_source_market_id AS "sourceMarketId",
       settlement_source_snapshot_id::text AS "sourceSnapshotId",
       settlement_identity_validation_proof_id::text AS "validationProofId",
       settlement_frozen_at AS "frozenAt"
     FROM ticket_legs
     WHERE ticket_id = $1
     ORDER BY created_at, id`,
    [ticketId]
  );
  if (result.rows.length === 0) fail("lifecycle_ticket_settlement_identity_missing");
  return result.rows.map((row) => {
    if (!row.authority || !row.sourceMarketId || !row.sourceSnapshotId || !row.validationProofId || !row.frozenAt) {
      fail("lifecycle_ticket_settlement_identity_not_frozen");
    }
    return {
      ticketLegId: row.ticketLegId,
      authority: row.authority,
      sourceMarketId: row.sourceMarketId,
      sourceSnapshotId: row.sourceSnapshotId,
      validationProofId: row.validationProofId,
      frozenAt: row.frozenAt.toISOString()
    };
  });
}

const sensitiveKey = /authorization|access[_-]?token|identity[_-]?token|api[_-]?key|secret|password|private[_-]?key|signature/i;
const jwtPattern = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

export function redactLifecycleReport(value: unknown, secrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactLifecycleReport(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[redacted]" : redactLifecycleReport(item, secrets)
      ])
    );
  }
  if (typeof value === "string") {
    if (
      jwtPattern.test(value) ||
      /\bBearer\s+/i.test(value) ||
      secrets.some((secret) => secret.length >= 8 && value.includes(secret))
    ) {
      return "[redacted]";
    }
  }
  return value;
}

function emitReport(report: JsonObject, secrets: string[], writeReport?: (report: JsonObject) => void) {
  const redacted = redactLifecycleReport(report, secrets) as JsonObject;
  if (writeReport) writeReport(redacted);
  else process.stdout.write(`${JSON.stringify(redacted)}\n`);
}

function apiUrl(baseUrl: URL, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

function userHeaders(accessToken: string, extra: Record<string, string> = {}) {
  return { accept: "application/json", authorization: `Bearer ${accessToken}`, ...extra };
}

function opsHeaders(opsApiKey: string) {
  return { accept: "application/json", authorization: `Bearer ${opsApiKey}` };
}

async function requestWithRetry(
  request: LifecycleFetch,
  url: string,
  init: RequestInit,
  code: string,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(url, init);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) return response;
    } catch {
      if (attempt === attempts) fail(`${code}_request_failed`);
    }
    await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
  }
  fail(`${code}_request_failed`);
}

async function responseJson(response: LifecycleFetchResponse, code: string) {
  try {
    return await response.json();
  } catch {
    fail(code);
  }
}

function expectStatus(response: LifecycleFetchResponse, expected: number | number[], code: string) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(response.status)) fail(code);
}

function normalizedHash(value: unknown, code: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail(code);
  return value.toLowerCase() as Hash;
}

function parseQuote(value: unknown, code: string): Quote {
  const quote = object(value, code);
  const legs = array(quote.legs, code).map((leg) => {
    const item = object(leg, code);
    if (typeof item.id !== "string" || !item.id) fail(code);
    return { id: item.id };
  });
  if (
    typeof quote.id !== "string" ||
    !quote.id ||
    typeof quote.status !== "string" ||
    typeof quote.expiresAt !== "string" ||
    typeof quote.totalCostUsd !== "number" ||
    !Number.isFinite(quote.totalCostUsd)
  ) {
    fail(code);
  }
  return { id: quote.id, status: quote.status, expiresAt: quote.expiresAt, totalCostUsd: quote.totalCostUsd, legs };
}

function parsePaymentIntent(value: unknown, code: string): PaymentIntent {
  const intent = object(value, code);
  const statuses = new Set<PaymentStatus>(["pending", "submitted", "confirmed", "activating", "activated", "expired", "failed", "recoverable"]);
  if (
    typeof intent.id !== "string" ||
    typeof intent.quoteId !== "string" ||
    typeof intent.chainId !== "number" ||
    typeof intent.currency !== "string" ||
    typeof intent.treasuryAddress !== "string" ||
    typeof intent.usdcContractAddress !== "string" ||
    typeof intent.amountMicroUnits !== "string" ||
    !/^[1-9][0-9]*$/.test(intent.amountMicroUnits) ||
    typeof intent.requiredConfirmations !== "number" ||
    typeof intent.status !== "string" ||
    !statuses.has(intent.status as PaymentStatus) ||
    typeof intent.expiresAt !== "string"
  ) {
    fail(code);
  }
  return intent as unknown as PaymentIntent;
}

function parseTicket(value: unknown, code: string): Ticket {
  const ticket = object(value, code);
  if (
    typeof ticket.ticketId !== "string" ||
    typeof ticket.quoteId !== "string" ||
    typeof ticket.status !== "string" ||
    !Array.isArray(ticket.legs)
  ) {
    fail(code);
  }
  return ticket as unknown as Ticket;
}

function parseActivationTicket(value: unknown, code: string) {
  const ticket = object(value, code);
  if (typeof ticket.ticketId !== "string" || typeof ticket.quoteId !== "string" || ticket.status !== "accepted") fail(code);
  return { ticketId: ticket.ticketId, quoteId: ticket.quoteId };
}

function assertFuture(value: string, now: Date, code: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= now.getTime()) fail(code);
}

function amountMicroUnitsFromQuote(totalCostUsd: number) {
  const scaled = totalCostUsd * 1_000_000;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-6 || rounded <= 0) {
    fail("lifecycle_quote_amount_invalid");
  }
  return BigInt(rounded);
}

function isEligibleOutcome(outcome: MarketOutcome): outcome is MarketOutcome & { id: string; marketId: string; outcome: string } {
  return Boolean(
    typeof outcome.id === "string" &&
      outcome.id &&
      typeof outcome.marketId === "string" &&
      outcome.marketId &&
      typeof outcome.outcome === "string" &&
      outcome.outcome &&
      outcome.eligibility?.eligible === true &&
      outcome.sourceActive !== false &&
      outcome.closed !== true &&
      outcome.archived !== true &&
      outcome.acceptingOrders !== false &&
      outcome.enableOrderBook === true
  );
}

function selectLegs(outcomes: MarketOutcome[], configuration: LifecycleConfiguration) {
  const eligible = outcomes.filter(isEligibleOutcome);
  let selected: Array<MarketOutcome & { id: string; marketId: string; outcome: string }>;
  if (configuration.outcomeIds.length > 0) {
    selected = configuration.outcomeIds.map((id) => eligible.find((outcome) => outcome.id === id) || fail("lifecycle_selected_outcome_ineligible"));
  } else if (configuration.marketOutcomePairs.length > 0) {
    selected = configuration.marketOutcomePairs.map(
      (selector) =>
        eligible.find(
          (outcome) =>
            outcome.marketId === selector.marketId &&
            (outcome.outcome.toLowerCase() === selector.outcome.toLowerCase() || outcome.id === selector.outcome)
        ) || fail("lifecycle_selected_market_outcome_ineligible")
    );
  } else {
    selected = [];
    const marketIds = new Set<string>();
    const eventGroups = new Set<string>();
    for (const outcome of eligible) {
      const eventGroup = typeof outcome.eventGroupKey === "string" && outcome.eventGroupKey ? outcome.eventGroupKey : outcome.marketId;
      if (marketIds.has(outcome.marketId) || eventGroups.has(eventGroup)) continue;
      selected.push(outcome);
      marketIds.add(outcome.marketId);
      eventGroups.add(eventGroup);
      if (selected.length === 2) break;
    }
  }
  if (selected.length < 2 || selected.length > 12) fail("lifecycle_eligible_legs_unavailable");
  if (new Set(selected.map((item) => item.id)).size !== selected.length || new Set(selected.map((item) => item.marketId)).size !== selected.length) {
    fail("lifecycle_duplicate_market_selection");
  }
  const eventGroups = selected.map((item) => (typeof item.eventGroupKey === "string" && item.eventGroupKey ? item.eventGroupKey : item.marketId));
  if (new Set(eventGroups).size !== eventGroups.length) fail("lifecycle_duplicate_event_selection");
  return selected.map((item) => ({ id: item.id }));
}

function assertQuote(quote: Quote, legIds: string[], now: Date, allowAccepted = false, requireUnexpired = true) {
  if (quote.status !== "quoted" && !(allowAccepted && quote.status === "accepted")) fail("lifecycle_quote_rejected_or_unexpected");
  if (quote.legs.length !== legIds.length || quote.legs.some((leg, index) => leg.id !== legIds[index])) fail("lifecycle_quote_legs_mismatch");
  if (requireUnexpired && quote.status === "quoted") assertFuture(quote.expiresAt, now, "lifecycle_quote_expired");
}

function assertIntentInvariant(intent: PaymentIntent, input: {
  quoteId: string;
  treasuryAddress: Address;
  usdcContractAddress: Address;
  amountMicroUnits: bigint;
}) {
  if (intent.quoteId !== input.quoteId) fail("lifecycle_payment_intent_quote_mismatch");
  if (intent.chainId !== SEPOLIA_PAYMENT_CHAIN_ID) fail("lifecycle_payment_intent_chain_mismatch");
  if (intent.currency !== "USDC") fail("lifecycle_payment_intent_currency_mismatch");
  if (!isAddress(intent.treasuryAddress) || getAddress(intent.treasuryAddress) !== input.treasuryAddress) {
    fail("lifecycle_payment_intent_treasury_mismatch");
  }
  if (!isAddress(intent.usdcContractAddress) || getAddress(intent.usdcContractAddress) !== input.usdcContractAddress) {
    fail("lifecycle_payment_intent_usdc_mismatch");
  }
  if (BigInt(intent.amountMicroUnits) !== input.amountMicroUnits) fail("lifecycle_payment_intent_amount_mismatch");
  if (intent.requiredConfirmations !== SEPOLIA_REQUIRED_CONFIRMATIONS) fail("lifecycle_payment_intent_confirmations_mismatch");
  if (["expired", "failed", "recoverable"].includes(intent.status)) fail(`lifecycle_payment_intent_${intent.status}`);
}

function observeTransition(transitions: LifecycleStateTransition[], status: PaymentStatus, now: () => Date) {
  if (transitions.at(-1)?.status !== status) transitions.push({ status, observedAt: now().toISOString() });
}

async function fetchCatalog(
  request: LifecycleFetch,
  configuration: LifecycleConfiguration,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>
) {
  const outcomes: MarketOutcome[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await requestWithRetry(
      request,
      apiUrl(configuration.apiBaseUrl, `/api/markets?${query}`),
      { method: "GET", headers: { accept: "application/json" } },
      "lifecycle_markets",
      attempts,
      sleep
    );
    expectStatus(response, 200, "lifecycle_market_read_failed");
    const payload = object(await responseJson(response, "lifecycle_market_response_invalid"), "lifecycle_market_response_invalid");
    outcomes.push(...(array(payload.outcomes, "lifecycle_market_response_invalid") as MarketOutcome[]));
    const selectedIds = new Set(configuration.outcomeIds);
    const selectedPairsFound = configuration.marketOutcomePairs.every((selector) =>
      outcomes.some((outcome) => outcome.marketId === selector.marketId && (outcome.outcome === selector.outcome || outcome.id === selector.outcome))
    );
    if ((selectedIds.size > 0 && [...selectedIds].every((id) => outcomes.some((outcome) => outcome.id === id))) || selectedPairsFound) break;
    const pageInfo = payload.pageInfo && typeof payload.pageInfo === "object" ? (payload.pageInfo as JsonObject) : undefined;
    const nextCursor = typeof payload.nextCursor === "string" ? payload.nextCursor : typeof pageInfo?.nextCursor === "string" ? pageInfo.nextCursor : undefined;
    const hasMore = pageInfo?.hasMore === true || Boolean(nextCursor);
    if (!hasMore || !nextCursor) break;
    cursor = nextCursor;
  }
  return outcomes;
}

export async function runSepoliaBotLifecycle(
  deps: SepoliaBotLifecycleDependencies = {}
): Promise<SepoliaBotLifecycleReport> {
  const configuration = loadSepoliaBotLifecycleConfiguration(deps);
  const request = deps.fetch || ((url: string, init: RequestInit) => fetch(url, init));
  const now = deps.now || (() => new Date());
  const sleep = deps.sleep || ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = deps.requestAttempts ?? DEFAULT_REQUEST_ATTEMPTS;
  const maxPollAttempts = deps.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) fail("lifecycle_request_attempts_invalid");
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1 || maxPollAttempts > 10_000) fail("lifecycle_poll_attempts_invalid");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000) fail("lifecycle_poll_interval_invalid");

  const runId = configuration.runId || (deps.randomId || randomUUID)();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(runId)) fail("lifecycle_run_id_invalid");
  const startedAt = now().toISOString();
  const quoteIdempotencyKey = `sepolia-positive-${runId}`;
  const burner = await (deps.loadBurnerWallet || loadSepoliaBurnerWallet)();

  const syncResponse = await requestWithRetry(
    request,
    apiUrl(configuration.apiBaseUrl, "/api/auth/privy/sync"),
    {
      method: "POST",
      headers: userHeaders(configuration.accessToken, { "content-type": "application/json" }),
      body: JSON.stringify({ identityToken: configuration.identityToken })
    },
    "lifecycle_privy_sync",
    attempts,
    sleep
  );
  expectStatus(syncResponse, 200, "lifecycle_privy_sync_failed");
  const synced = object(await responseJson(syncResponse, "lifecycle_privy_sync_response_invalid"), "lifecycle_privy_sync_response_invalid");
  const syncedWallets = array(synced.wallets, "lifecycle_privy_sync_response_invalid");
  if (!syncedWallets.some((wallet) => {
    const address = object(wallet, "lifecycle_privy_sync_response_invalid").address;
    return typeof address === "string" && isAddress(address) && getAddress(address) === burner.address;
  })) {
    fail("lifecycle_privy_wallet_not_linked");
  }

  const sessionResponse = await requestWithRetry(
    request,
    apiUrl(configuration.apiBaseUrl, "/api/auth/session"),
    { method: "GET", headers: userHeaders(configuration.accessToken) },
    "lifecycle_auth_session",
    attempts,
    sleep
  );
  expectStatus(sessionResponse, 200, "lifecycle_privy_authentication_failed");
  const session = object(await responseJson(sessionResponse, "lifecycle_auth_session_response_invalid"), "lifecycle_auth_session_response_invalid");
  if (session.authProvider !== "privy") fail("lifecycle_auth_provider_mismatch");
  const sessionWallets = array(session.wallets, "lifecycle_auth_session_response_invalid");
  if (!sessionWallets.some((wallet) => {
    const address = object(wallet, "lifecycle_auth_session_response_invalid").address;
    return typeof address === "string" && isAddress(address) && getAddress(address) === burner.address;
  })) {
    fail("lifecycle_session_wallet_mismatch");
  }

  const marketOutcomes = await fetchCatalog(request, configuration, attempts, sleep);
  const legs = selectLegs(marketOutcomes, configuration);
  const legIds = legs.map((leg) => leg.id);
  const quoteResponse = await requestWithRetry(
    request,
    apiUrl(configuration.apiBaseUrl, "/api/quotes"),
    {
      method: "POST",
      headers: userHeaders(configuration.accessToken, {
        "content-type": "application/json",
        "idempotency-key": quoteIdempotencyKey
      }),
      body: JSON.stringify({ stakeUsd: configuration.stakeUsd, legs })
    },
    "lifecycle_quote_create",
    attempts,
    sleep
  );
  expectStatus(quoteResponse, 201, quoteResponse.status === 422 ? "lifecycle_quote_rejected" : "lifecycle_quote_create_failed");
  const createdQuote = parseQuote(await responseJson(quoteResponse, "lifecycle_quote_response_invalid"), "lifecycle_quote_response_invalid");
  // A repeated run can replay the original creation payload after its quote was
  // activated. The authenticated read below is the current authoritative state.
  assertQuote(createdQuote, legIds, now(), false, false);

  const quoteReadResponse = await requestWithRetry(
    request,
    apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(createdQuote.id)}`),
    { method: "GET", headers: userHeaders(configuration.accessToken) },
    "lifecycle_quote_read",
    attempts,
    sleep
  );
  expectStatus(quoteReadResponse, 200, "lifecycle_quote_read_failed");
  const quote = parseQuote(await responseJson(quoteReadResponse, "lifecycle_quote_read_response_invalid"), "lifecycle_quote_read_response_invalid");
  if (quote.id !== createdQuote.id) fail("lifecycle_quote_id_mismatch");
  assertQuote(quote, legIds, now(), true, false);
  const amountMicroUnits = amountMicroUnitsFromQuote(quote.totalCostUsd);

  let intent: PaymentIntent;
  const existingIntentResponse = await requestWithRetry(
    request,
    apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(quote.id)}/payment-intent`),
    { method: "GET", headers: userHeaders(configuration.accessToken) },
    "lifecycle_payment_intent_read",
    attempts,
    sleep
  );
  if (existingIntentResponse.status === 404) {
    if (quote.status !== "quoted") fail("lifecycle_quote_payment_state_mismatch");
    assertFuture(quote.expiresAt, now(), "lifecycle_quote_expired");
    const createIntentResponse = await requestWithRetry(
      request,
      apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(quote.id)}/payment-intent`),
      { method: "POST", headers: userHeaders(configuration.accessToken) },
      "lifecycle_payment_intent_create",
      attempts,
      sleep
    );
    expectStatus(createIntentResponse, 201, "lifecycle_payment_intent_create_failed");
    intent = parsePaymentIntent(await responseJson(createIntentResponse, "lifecycle_payment_intent_response_invalid"), "lifecycle_payment_intent_response_invalid");
  } else {
    expectStatus(existingIntentResponse, 200, "lifecycle_payment_intent_read_failed");
    intent = parsePaymentIntent(await responseJson(existingIntentResponse, "lifecycle_payment_intent_response_invalid"), "lifecycle_payment_intent_response_invalid");
  }
  assertIntentInvariant(intent, { quoteId: quote.id, treasuryAddress: configuration.treasuryAddress, usdcContractAddress: configuration.usdcContractAddress, amountMicroUnits });
  if (quote.status === "accepted" && intent.status !== "activated") fail("lifecycle_quote_payment_state_mismatch");
  if (["pending", "submitted"].includes(intent.status)) assertFuture(intent.expiresAt, now(), "lifecycle_payment_intent_expired");

  const expectedTransfer: ExactUsdcTransfer & { rpcUrl: string } = {
    chainId: SEPOLIA_PAYMENT_CHAIN_ID,
    from: burner.address,
    tokenAddress: configuration.usdcContractAddress,
    treasuryAddress: configuration.treasuryAddress,
    amountMicroUnits,
    rpcUrl: configuration.rpcUrl
  };
  const transitions: LifecycleStateTransition[] = [];
  observeTransition(transitions, intent.status, now);

  let txHash: Hash;
  if (intent.txHash) {
    txHash = normalizedHash(intent.txHash, "lifecycle_payment_intent_tx_hash_invalid");
  } else {
    if (intent.status !== "pending") fail("lifecycle_payment_intent_tx_hash_missing");
    assertFuture(intent.expiresAt, now(), "lifecycle_payment_intent_expired");
    await (deps.assertOnchainReady || assertDefaultOnchainReady)(expectedTransfer);
    txHash = normalizedHash(await burner.sendExactUsdcTransfer(expectedTransfer), "lifecycle_submitted_tx_hash_invalid");
  }
  await (deps.verifyTransfer || verifyDefaultTransfer)(txHash, expectedTransfer);

  if (intent.status === "pending") {
    const submitResponse = await requestWithRetry(
      request,
      apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(quote.id)}/payment-transaction`),
      {
        method: "POST",
        headers: userHeaders(configuration.accessToken, { "content-type": "application/json" }),
        body: JSON.stringify({ txHash })
      },
      "lifecycle_payment_transaction_submit",
      attempts,
      sleep
    );
    expectStatus(submitResponse, 200, "lifecycle_payment_transaction_submit_failed");
    intent = parsePaymentIntent(await responseJson(submitResponse, "lifecycle_payment_transaction_response_invalid"), "lifecycle_payment_transaction_response_invalid");
    assertIntentInvariant(intent, { quoteId: quote.id, treasuryAddress: configuration.treasuryAddress, usdcContractAddress: configuration.usdcContractAddress, amountMicroUnits });
    if (!intent.txHash || normalizedHash(intent.txHash, "lifecycle_payment_intent_tx_hash_invalid") !== txHash) {
      fail("lifecycle_payment_transaction_hash_mismatch");
    }
    if (!["submitted", "confirmed", "activating", "activated"].includes(intent.status)) fail("lifecycle_payment_transaction_status_unexpected");
    observeTransition(transitions, intent.status, now);
  }

  let activationTicket: { ticketId: string; quoteId: string } | undefined;
  for (let poll = 0; intent.status !== "activated" && poll < maxPollAttempts; poll += 1) {
    if (intent.status === "confirmed") {
      const activationResponse = await requestWithRetry(
        request,
        apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(quote.id)}/payment-activate`),
        { method: "POST", headers: userHeaders(configuration.accessToken) },
        "lifecycle_payment_activation",
        attempts,
        sleep
      );
      expectStatus(activationResponse, [200, 201, 202], "lifecycle_payment_activation_failed");
      const activationPayload = await responseJson(activationResponse, "lifecycle_payment_activation_response_invalid");
      if (activationResponse.status === 200 || activationResponse.status === 201) {
        activationTicket = parseActivationTicket(activationPayload, "lifecycle_payment_activation_response_invalid");
      }
    } else if (!["submitted", "activating"].includes(intent.status)) {
      fail("lifecycle_payment_status_unexpected");
    }
    await sleep(pollIntervalMs);
    const pollResponse = await requestWithRetry(
      request,
      apiUrl(configuration.apiBaseUrl, `/api/quotes/${encodeURIComponent(quote.id)}/payment-intent`),
      { method: "GET", headers: userHeaders(configuration.accessToken) },
      "lifecycle_payment_intent_poll",
      attempts,
      sleep
    );
    expectStatus(pollResponse, 200, "lifecycle_payment_intent_poll_failed");
    intent = parsePaymentIntent(await responseJson(pollResponse, "lifecycle_payment_intent_poll_response_invalid"), "lifecycle_payment_intent_poll_response_invalid");
    assertIntentInvariant(intent, { quoteId: quote.id, treasuryAddress: configuration.treasuryAddress, usdcContractAddress: configuration.usdcContractAddress, amountMicroUnits });
    if (!intent.txHash || normalizedHash(intent.txHash, "lifecycle_payment_intent_tx_hash_invalid") !== txHash) fail("lifecycle_payment_transaction_hash_mismatch");
    observeTransition(transitions, intent.status, now);
  }
  if (intent.status !== "activated" || !intent.ticketId) fail("lifecycle_payment_activation_timeout");

  const ticketsResponse = await requestWithRetry(
    request,
    apiUrl(configuration.apiBaseUrl, "/api/tickets"),
    { method: "GET", headers: userHeaders(configuration.accessToken) },
    "lifecycle_portfolio",
    attempts,
    sleep
  );
  expectStatus(ticketsResponse, 200, "lifecycle_portfolio_read_failed");
  const portfolio = array(object(await responseJson(ticketsResponse, "lifecycle_portfolio_response_invalid"), "lifecycle_portfolio_response_invalid").tickets, "lifecycle_portfolio_response_invalid");
  const portfolioTicket = portfolio.find((item) => {
    const candidate = object(item, "lifecycle_portfolio_response_invalid");
    return candidate.ticketId === intent.ticketId && candidate.quoteId === quote.id;
  });
  if (!portfolioTicket) fail("lifecycle_ticket_missing_from_portfolio");

  const ticketResponse = await requestWithRetry(
    request,
    apiUrl(configuration.apiBaseUrl, `/api/tickets/${encodeURIComponent(intent.ticketId)}`),
    { method: "GET", headers: userHeaders(configuration.accessToken) },
    "lifecycle_ticket",
    attempts,
    sleep
  );
  expectStatus(ticketResponse, 200, "lifecycle_ticket_read_failed");
  const ticket = parseTicket(await responseJson(ticketResponse, "lifecycle_ticket_response_invalid"), "lifecycle_ticket_response_invalid");
  if (ticket.ticketId !== intent.ticketId || ticket.quoteId !== quote.id) fail("lifecycle_ticket_identity_mismatch");
  if (activationTicket && (activationTicket.ticketId !== ticket.ticketId || activationTicket.quoteId !== ticket.quoteId)) {
    fail("lifecycle_activation_ticket_mismatch");
  }
  if (!ticket.purchaseTxHash || normalizedHash(ticket.purchaseTxHash, "lifecycle_ticket_tx_hash_invalid") !== txHash) fail("lifecycle_ticket_tx_hash_mismatch");
  if (ticket.purchaseChainId !== SEPOLIA_PAYMENT_CHAIN_ID) fail("lifecycle_ticket_chain_mismatch");
  if (ticket.legs.length !== legs.length) fail("lifecycle_ticket_leg_count_mismatch");

  const frozenIdentities = await (deps.verifyFrozenSettlementIdentities || verifyDefaultFrozenSettlementIdentities)(ticket.ticketId);
  if (frozenIdentities.length !== ticket.legs.length) fail("lifecycle_ticket_settlement_identity_count_mismatch");

  const reconciliation = await (deps.runReconciliation || processFinancialReconciliation)();
  const reconciliationResponse = await requestWithRetry(
    request,
    apiUrl(configuration.apiBaseUrl, "/api/ops/reconciliation/latest"),
    { method: "GET", headers: opsHeaders(configuration.opsApiKey) },
    "lifecycle_reconciliation_read",
    attempts,
    sleep
  );
  expectStatus(reconciliationResponse, 200, "lifecycle_reconciliation_read_failed");
  const latest = object(object(await responseJson(reconciliationResponse, "lifecycle_reconciliation_response_invalid"), "lifecycle_reconciliation_response_invalid").snapshot, "lifecycle_reconciliation_response_invalid");
  if (latest.id !== reconciliation.id) fail("lifecycle_reconciliation_snapshot_mismatch");
  if (reconciliation.chainId !== SEPOLIA_PAYMENT_CHAIN_ID || reconciliation.currency !== "USDC") fail("lifecycle_reconciliation_scope_mismatch");
  if (reconciliation.launchGate !== "ready" || reconciliation.operationGate !== "open" || reconciliation.unexplainedDeltaMicroUnits !== "0") {
    fail("lifecycle_reconciliation_not_clean");
  }

  const report: SepoliaBotLifecycleReport = {
    runner: RUNNER_NAME,
    status: "passed",
    mode: "supervised_fund_moving",
    runId,
    startedAt,
    completedAt: now().toISOString(),
    chainId: SEPOLIA_PAYMENT_CHAIN_ID,
    burnerAddress: burner.address,
    treasuryAddress: configuration.treasuryAddress,
    usdcContractAddress: configuration.usdcContractAddress,
    txHash,
    quote: { id: quote.id, idempotencyKey: quoteIdempotencyKey, legIds },
    paymentIntent: {
      id: intent.id,
      amountMicroUnits: intent.amountMicroUnits,
      requiredConfirmations: intent.requiredConfirmations,
      transitions
    },
    ticket: { id: ticket.ticketId, portfolioVerified: true, frozenSettlementIdentities: frozenIdentities },
    reconciliation: {
      snapshotId: reconciliation.id,
      launchGate: "ready",
      operationGate: "open",
      unexplainedDeltaMicroUnits: "0"
    }
  };
  emitReport(report as unknown as JsonObject, [configuration.accessToken, configuration.identityToken, configuration.opsApiKey], deps.writeReport);
  return report;
}

export async function runSepoliaBotLifecycleCli(deps: SepoliaBotLifecycleDependencies = {}) {
  const environment = deps.environment || process.env;
  const secrets = [
    deps.userAccessToken || environment.QA_SEPOLIA_BOT_ACCESS_TOKEN || "",
    deps.identityToken || environment.QA_SEPOLIA_BOT_IDENTITY_TOKEN || "",
    deps.opsApiKey || environment.QA_SEPOLIA_OPS_API_KEY || environment.OPS_API_KEY || ""
  ];
  try {
    await runSepoliaBotLifecycle(deps);
    return 0;
  } catch (error) {
    const code = error instanceof SepoliaBotLifecycleError ? error.code : "lifecycle_failed";
    emitReport({ runner: RUNNER_NAME, status: "failed", error: code }, secrets, deps.writeReport);
    return 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  process.exitCode = await runSepoliaBotLifecycleCli();
}
