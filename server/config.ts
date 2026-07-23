import "dotenv/config";
import { createHash } from "node:crypto";
import { getAddress, zeroAddress } from "viem";
import { z } from "zod";

export const SEPOLIA_PAYMENT_CHAIN_ID = 11155111;
export const CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const SEPOLIA_REQUIRED_CONFIRMATIONS = 12;
export const DATABASE_APPLICATION_NAME = "legwork-api";

export type SettlementAuthority = "polygon_ctf" | "polymarket_api";

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());
const optionalSecret = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(20).optional());
const optionalNumber = z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().nonnegative().optional());

export type SettlementRpcEndpoint = {
  url: string;
  normalizedUrl: string;
  endpointId: string;
  operator: string;
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(8787),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  MARKET_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  MARKET_CATALOG_MAX_AGE_MS: z.coerce.number().int().positive().default(30_000),
  MARKET_CATALOG_HARD_MAX_AGE_MS: z.coerce.number().int().positive().default(30 * 60_000),
  MARKET_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MARKET_INDEX_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_HEARTBEAT_MAX_AGE_MS: z.coerce.number().int().positive().default(45_000),
  WORKER_SUCCESS_MAX_AGE_MS: z.coerce.number().int().positive().default(180_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  RATE_LIMIT_BACKEND: z.enum(["memory", "redis"]).default("memory"),
  RATE_LIMIT_SKIP_ON_REDIS_ERROR: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ACCOUNTING_MODE: z.enum(["play_money", "house_book_usdc"]).default("play_money"),
  LEDGER_CURRENCY: z.enum(["USD", "USDC"]).default("USD"),
  SETTLEMENT_CHAIN_ID: z.coerce.number().int().positive().default(SEPOLIA_PAYMENT_CHAIN_ID),
  MAX_USER_LIABILITY_USD: z.coerce.number().positive().default(500),
  MAX_MARKET_LIABILITY_USD: z.coerce.number().positive().default(1_000),
  MAX_EVENT_LIABILITY_USD: z.coerce.number().positive().default(1_000),
  SETTLEMENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  SETTLEMENT_BATCH_SIZE: z.coerce.number().int().positive().max(250).default(25),
  SETTLEMENT_BLOCKED_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(5),
  SETTLEMENT_ALERT_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(250),
  SETTLEMENT_OVERDUE_WARNING_MS: z.coerce.number().int().positive().default(24 * 60 * 60_000),
  SETTLEMENT_OVERDUE_CRITICAL_MS: z.coerce.number().int().positive().default(72 * 60 * 60_000),
  SETTLEMENT_REQUIRE_ONCHAIN: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : undefined)),
  SETTLEMENT_AUTHORITY: z.enum(["polygon_ctf", "polymarket_api"]).optional(),
  SETTLEMENT_API_STABILITY_MS: z.coerce.number().int().min(30_000).max(30 * 60_000).default(120_000),
  POLYMARKET_SETTLEMENT_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  POLYMARKET_GAMMA_API_BASE_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_API_BASE_URL: z.string().url().default("https://clob.polymarket.com"),
  SETTLEMENT_RPC_QUORUM: z.coerce.number().int().positive().max(3).default(2),
  POLYGON_SETTLEMENT_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLYMARKET_CTF_ADDRESS: optionalString,
  POLYMARKET_COLLATERAL_ADDRESS: optionalString,
  POLYGON_RPC_URL: optionalUrl,
  POLYGON_SECONDARY_RPC_URL: optionalUrl,
  POLYGON_TERTIARY_RPC_URL: optionalUrl,
  POLYGON_RPC_OPERATOR: optionalString,
  POLYGON_SECONDARY_RPC_OPERATOR: optionalString,
  POLYGON_TERTIARY_RPC_OPERATOR: optionalString,
  PRIVY_APP_ID: optionalString,
  PRIVY_JWKS_URL: optionalUrl,
  TREASURY_SAFE_ADDRESS: optionalString,
  SAFE_API_BASE_URL: z.string().url().default("https://api.safe.global"),
  SAFE_API_KEY: optionalSecret,
  ETHEREUM_RPC_URL: optionalUrl,
  USDC_CONTRACT_ADDRESS: z.string().default(CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS),
  USDC_REQUIRED_CONFIRMATIONS: z.coerce.number().int().positive().default(SEPOLIA_REQUIRED_CONFIRMATIONS),
  USDC_DEPOSIT_START_BLOCK: optionalNumber,
  USDC_DEPOSIT_SCAN_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(5_000),
  USDC_DEPOSIT_SCAN_BATCH_BLOCKS: z.coerce.number().int().positive().max(10_000).default(2_000),
  USDC_DEPOSIT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  BETA_USER_API_KEY: optionalString,
  BETA_USER_EMAIL: z.string().email().default("dev@legwork.local"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  OPS_API_KEY: optionalSecret,
  DATABASE_URL: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(5),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000)
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(environment);
  const settlementAuthority: SettlementAuthority =
    parsed.SETTLEMENT_AUTHORITY ||
    (parsed.SETTLEMENT_REQUIRE_ONCHAIN === false ? "polymarket_api" : "polygon_ctf");
  const settlementRequiresOnchain = settlementAuthority === "polygon_ctf";
  const accountingMode = parsed.ACCOUNTING_MODE;
  const ledgerCurrency = accountingMode === "house_book_usdc" ? "USDC" : parsed.LEDGER_CURRENCY;
  let treasurySafeAddress = parsed.TREASURY_SAFE_ADDRESS;

  if (accountingMode === "house_book_usdc" && parsed.NODE_ENV === "production" && treasurySafeAddress) {
    try {
      treasurySafeAddress = getAddress(treasurySafeAddress);
    } catch {
      throw new Error("TREASURY_SAFE_ADDRESS must be a valid EVM address");
    }
    if (treasurySafeAddress === zeroAddress) {
      throw new Error("TREASURY_SAFE_ADDRESS must not be the zero address");
    }
  }

  if (parsed.NODE_ENV === "production" && parsed.SETTLEMENT_CHAIN_ID !== SEPOLIA_PAYMENT_CHAIN_ID) {
    throw new Error(`SETTLEMENT_CHAIN_ID must be ${SEPOLIA_PAYMENT_CHAIN_ID} for the current Sepolia staging deployment`);
  }

  if (
    parsed.NODE_ENV === "production" &&
    parsed.USDC_CONTRACT_ADDRESS.toLowerCase() !== CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS.toLowerCase()
  ) {
    throw new Error(`USDC_CONTRACT_ADDRESS must be ${CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS} for the current Sepolia staging deployment`);
  }

  if (parsed.NODE_ENV === "production" && parsed.USDC_REQUIRED_CONFIRMATIONS !== SEPOLIA_REQUIRED_CONFIRMATIONS) {
    throw new Error(`USDC_REQUIRED_CONFIRMATIONS must be ${SEPOLIA_REQUIRED_CONFIRMATIONS} for supervised Sepolia staging`);
  }

  if (parsed.NODE_ENV === "production" && parsed.RATE_LIMIT_BACKEND !== "redis") {
    throw new Error("RATE_LIMIT_BACKEND=redis is required when NODE_ENV=production");
  }

  if (parsed.NODE_ENV === "production" && parsed.RATE_LIMIT_SKIP_ON_REDIS_ERROR) {
    throw new Error("RATE_LIMIT_SKIP_ON_REDIS_ERROR=false is required when NODE_ENV=production");
  }

  if (parsed.NODE_ENV === "production" && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when NODE_ENV=production");
  }

  if (parsed.NODE_ENV === "production" && !parsed.OPS_API_KEY) {
    throw new Error("OPS_API_KEY is required when NODE_ENV=production");
  }

  if (settlementRequiresOnchain && parsed.NODE_ENV === "production" && !parsed.POLYGON_RPC_URL) {
    throw new Error("POLYGON_RPC_URL is required for production settlement confirmation");
  }

  const polygonRpcEndpoints = buildSettlementRpcEndpoints([
    { url: parsed.POLYGON_RPC_URL, operator: parsed.POLYGON_RPC_OPERATOR },
    { url: parsed.POLYGON_SECONDARY_RPC_URL, operator: parsed.POLYGON_SECONDARY_RPC_OPERATOR },
    { url: parsed.POLYGON_TERTIARY_RPC_URL, operator: parsed.POLYGON_TERTIARY_RPC_OPERATOR }
  ]);
  if (settlementRequiresOnchain && parsed.NODE_ENV === "production" && polygonRpcEndpoints.length < parsed.SETTLEMENT_RPC_QUORUM) {
    throw new Error("Configured Polygon RPC URLs must satisfy SETTLEMENT_RPC_QUORUM in production");
  }

  if (parsed.POLYGON_SETTLEMENT_CHAIN_ID !== 137) {
    throw new Error("POLYGON_SETTLEMENT_CHAIN_ID must be 137 for Polymarket CTF settlement");
  }

  if (parsed.SETTLEMENT_OVERDUE_CRITICAL_MS <= parsed.SETTLEMENT_OVERDUE_WARNING_MS) {
    throw new Error("SETTLEMENT_OVERDUE_CRITICAL_MS must be greater than SETTLEMENT_OVERDUE_WARNING_MS");
  }

  if (parsed.NODE_ENV === "production" && accountingMode !== "house_book_usdc") {
    throw new Error("ACCOUNTING_MODE=house_book_usdc is required when NODE_ENV=production");
  }

  if (accountingMode === "house_book_usdc" && ledgerCurrency !== "USDC") {
    throw new Error("LEDGER_CURRENCY=USDC is required when ACCOUNTING_MODE=house_book_usdc");
  }

  if (accountingMode === "house_book_usdc" && parsed.NODE_ENV === "production" && !parsed.TREASURY_SAFE_ADDRESS) {
    throw new Error("TREASURY_SAFE_ADDRESS is required for production house-book mode");
  }

  if (accountingMode === "house_book_usdc" && parsed.NODE_ENV === "production" && !parsed.ETHEREUM_RPC_URL) {
    throw new Error("ETHEREUM_RPC_URL is required for production house-book mode");
  }

  if (accountingMode === "house_book_usdc" && parsed.NODE_ENV === "production" && !parsed.PRIVY_APP_ID) {
    throw new Error("PRIVY_APP_ID is required for production house-book mode");
  }

  return {
    ...parsed,
    TREASURY_SAFE_ADDRESS: treasurySafeAddress,
    PRIVY_JWKS_URL: parsed.PRIVY_JWKS_URL || (parsed.PRIVY_APP_ID ? `https://auth.privy.io/api/v1/apps/${parsed.PRIVY_APP_ID}/jwks.json` : undefined),
    ACCOUNTING_MODE: accountingMode,
    LEDGER_CURRENCY: ledgerCurrency,
    POLYGON_RPC_URLS: polygonRpcEndpoints.map((endpoint) => endpoint.url),
    POLYGON_RPC_ENDPOINTS: polygonRpcEndpoints,
    POLYMARKET_CTF_ADDRESS: parsed.POLYMARKET_CTF_ADDRESS || "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    POLYMARKET_COLLATERAL_ADDRESS: parsed.POLYMARKET_COLLATERAL_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    SETTLEMENT_REQUIRE_ONCHAIN: settlementRequiresOnchain,
    SETTLEMENT_AUTHORITY: settlementAuthority
  };
}

export const config = loadConfig();

export function normalizeSettlementRpcUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function rpcEndpointId(normalizedUrl: string) {
  return createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 16);
}

function rpcOperator(input: { url: string; operator?: string }) {
  const configured = input.operator?.trim().toLowerCase();
  if (configured) return configured;

  try {
    return new URL(input.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export function buildSettlementRpcEndpoints(
  inputs: Array<{ url?: string; operator?: string }>
): SettlementRpcEndpoint[] {
  const endpoints = inputs
    .filter((input): input is { url: string; operator?: string } => Boolean(input.url))
    .map((input) => {
      const normalizedUrl = normalizeSettlementRpcUrl(input.url);
      return {
        url: input.url,
        normalizedUrl,
        endpointId: rpcEndpointId(normalizedUrl),
        operator: rpcOperator(input)
      };
    });

  const duplicateUrl = endpoints.find((endpoint, index) =>
    endpoints.some((other, otherIndex) => otherIndex < index && other.normalizedUrl === endpoint.normalizedUrl)
  );
  if (duplicateUrl) {
    throw new Error("POLYGON_RPC_URLS must be distinct after normalization");
  }

  const duplicateOperator = endpoints.find((endpoint, index) =>
    endpoints.some((other, otherIndex) => otherIndex < index && other.operator === endpoint.operator)
  );
  if (duplicateOperator) {
    throw new Error("POLYGON_RPC operators must be distinct");
  }

  return endpoints;
}
