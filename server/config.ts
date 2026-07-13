import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());
const optionalSecret = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(20).optional());
const optionalNumber = z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().nonnegative().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(8787),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  MARKET_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  MARKET_CATALOG_MAX_AGE_MS: z.coerce.number().int().positive().default(30_000),
  MARKET_CATALOG_HARD_MAX_AGE_MS: z.coerce.number().int().positive().default(5 * 60_000),
  MARKET_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MARKET_INDEX_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  RATE_LIMIT_BACKEND: z.enum(["memory", "redis"]).default("memory"),
  RATE_LIMIT_SKIP_ON_REDIS_ERROR: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ACCOUNTING_MODE: z.enum(["play_money", "house_book_usdc"]).default("play_money"),
  LEDGER_CURRENCY: z.enum(["USD", "USDC"]).default("USD"),
  SETTLEMENT_CHAIN_ID: z.coerce.number().int().positive().default(1),
  MAX_USER_LIABILITY_USD: z.coerce.number().positive().default(500),
  MAX_MARKET_LIABILITY_USD: z.coerce.number().positive().default(1_000),
  MAX_EVENT_LIABILITY_USD: z.coerce.number().positive().default(1_000),
  SETTLEMENT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  SETTLEMENT_BATCH_SIZE: z.coerce.number().int().positive().max(250).default(25),
  SETTLEMENT_REQUIRE_ONCHAIN: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : undefined)),
  POLYMARKET_CTF_ADDRESS: optionalString,
  POLYGON_RPC_URL: optionalUrl,
  PRIVY_APP_ID: optionalString,
  PRIVY_JWKS_URL: optionalUrl,
  TREASURY_SAFE_ADDRESS: optionalString,
  SAFE_API_BASE_URL: z.string().url().default("https://api.safe.global"),
  SAFE_API_KEY: optionalSecret,
  ETHEREUM_RPC_URL: optionalUrl,
  USDC_CONTRACT_ADDRESS: z.string().default("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  USDC_REQUIRED_CONFIRMATIONS: z.coerce.number().int().positive().default(12),
  USDC_DEPOSIT_START_BLOCK: optionalNumber,
  USDC_DEPOSIT_SCAN_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(5_000),
  USDC_DEPOSIT_SCAN_BATCH_BLOCKS: z.coerce.number().int().positive().max(10_000).default(2_000),
  USDC_DEPOSIT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  BETA_USER_API_KEY: optionalString,
  BETA_USER_EMAIL: z.string().email().default("dev@legwork.local"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  OPS_API_KEY: optionalString,
  DATABASE_URL: optionalString
});

function loadConfig() {
  const parsed = envSchema.parse(process.env);
  const settlementRequiresOnchain = parsed.SETTLEMENT_REQUIRE_ONCHAIN ?? (parsed.NODE_ENV === "production");
  const accountingMode = parsed.ACCOUNTING_MODE;
  const ledgerCurrency = accountingMode === "house_book_usdc" ? "USDC" : parsed.LEDGER_CURRENCY;

  if (parsed.NODE_ENV === "production" && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when NODE_ENV=production");
  }

  if (settlementRequiresOnchain && parsed.NODE_ENV === "production" && !parsed.POLYGON_RPC_URL) {
    throw new Error("POLYGON_RPC_URL is required for production settlement confirmation");
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
    PRIVY_JWKS_URL: parsed.PRIVY_JWKS_URL || (parsed.PRIVY_APP_ID ? `https://auth.privy.io/api/v1/apps/${parsed.PRIVY_APP_ID}/jwks.json` : undefined),
    ACCOUNTING_MODE: accountingMode,
    LEDGER_CURRENCY: ledgerCurrency,
    SETTLEMENT_REQUIRE_ONCHAIN: settlementRequiresOnchain
  };
}

export const config = loadConfig();
