import { describe, expect, it } from "vitest";
import {
  CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS,
  loadConfig,
  SEPOLIA_PAYMENT_CHAIN_ID,
  SEPOLIA_REQUIRED_CONFIRMATIONS
} from "../config";

function productionEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    ACCOUNTING_MODE: "house_book_usdc",
    LEDGER_CURRENCY: "USDC",
    DATABASE_URL: "postgres://legwork:test-password@localhost:5432/legwork",
    RATE_LIMIT_BACKEND: "redis",
    SETTLEMENT_CHAIN_ID: String(SEPOLIA_PAYMENT_CHAIN_ID),
    USDC_CONTRACT_ADDRESS: CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS,
    TREASURY_SAFE_ADDRESS: "0x1111111111111111111111111111111111111111",
    ETHEREUM_RPC_URL: "https://ethereum-rpc.example.test",
    PRIVY_APP_ID: "test-privy-app-id",
    POLYGON_RPC_URL: "https://polygon-primary.example.test",
    POLYGON_RPC_OPERATOR: "primary",
    POLYGON_SECONDARY_RPC_URL: "https://polygon-secondary.example.test",
    POLYGON_SECONDARY_RPC_OPERATOR: "secondary",
    OPS_API_KEY: "test-ops-api-key-at-least-20-characters",
    ...overrides
  };
}

describe("production staging configuration", () => {
  it("accepts the fixed Sepolia payment network with Redis rate limiting", () => {
    expect(loadConfig(productionEnvironment())).toMatchObject({
      SETTLEMENT_CHAIN_ID: SEPOLIA_PAYMENT_CHAIN_ID,
      USDC_CONTRACT_ADDRESS: CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS,
      RATE_LIMIT_BACKEND: "redis",
      DATABASE_POOL_MAX: 5,
      DATABASE_CONNECTION_TIMEOUT_MS: 5_000,
      DATABASE_STATEMENT_TIMEOUT_MS: 15_000,
      SETTLEMENT_OVERDUE_WARNING_MS: 86_400_000,
      SETTLEMENT_OVERDUE_CRITICAL_MS: 259_200_000
    });
  });

  it("allows supervised Sepolia API settlement without Polygon RPC credentials", () => {
    const environment = productionEnvironment({
      SETTLEMENT_AUTHORITY: "polymarket_api",
      POLYGON_RPC_URL: "",
      POLYGON_RPC_OPERATOR: "",
      POLYGON_SECONDARY_RPC_URL: "",
      POLYGON_SECONDARY_RPC_OPERATOR: ""
    });
    expect(loadConfig(environment)).toMatchObject({
      SETTLEMENT_AUTHORITY: "polymarket_api",
      SETTLEMENT_REQUIRE_ONCHAIN: false,
      POLYGON_RPC_ENDPOINTS: [],
      SETTLEMENT_API_STABILITY_MS: 120_000
    });
  });

  it("still requires Polygon quorum when CTF is the configured authority", () => {
    expect(() =>
      loadConfig(
        productionEnvironment({
          SETTLEMENT_AUTHORITY: "polygon_ctf",
          POLYGON_RPC_URL: "",
          POLYGON_RPC_OPERATOR: "",
          POLYGON_SECONDARY_RPC_URL: "",
          POLYGON_SECONDARY_RPC_OPERATOR: ""
        })
      )
    ).toThrow("POLYGON_RPC_URL is required");
  });

  it("rejects settlement alert thresholds whose critical age is not greater than the warning age", () => {
    expect(() =>
      loadConfig(
        productionEnvironment({
          SETTLEMENT_OVERDUE_WARNING_MS: "7200000",
          SETTLEMENT_OVERDUE_CRITICAL_MS: "7200000"
        })
      )
    ).toThrow("SETTLEMENT_OVERDUE_CRITICAL_MS must be greater than SETTLEMENT_OVERDUE_WARNING_MS");
  });

  it("accepts the same Sepolia USDC address in lowercase", () => {
    expect(
      loadConfig(
        productionEnvironment({
          USDC_CONTRACT_ADDRESS: CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS.toLowerCase()
        })
      ).USDC_CONTRACT_ADDRESS
    ).toBe(CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS.toLowerCase());
  });

  it("rejects a non-Sepolia payment chain before startup", () => {
    expect(() => loadConfig(productionEnvironment({ SETTLEMENT_CHAIN_ID: "1" }))).toThrow(
      `SETTLEMENT_CHAIN_ID must be ${SEPOLIA_PAYMENT_CHAIN_ID}`
    );
  });

  it("rejects a USDC address other than Circle Sepolia before startup", () => {
    expect(() => loadConfig(productionEnvironment({ USDC_CONTRACT_ADDRESS: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }))).toThrow(
      `USDC_CONTRACT_ADDRESS must be ${CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS}`
    );
  });

  it("requires the approved Sepolia confirmation depth in production", () => {
    expect(() => loadConfig(productionEnvironment({ USDC_REQUIRED_CONFIRMATIONS: "2" }))).toThrow(
      `USDC_REQUIRED_CONFIRMATIONS must be ${SEPOLIA_REQUIRED_CONFIRMATIONS}`
    );
  });

  it("requires Redis rather than the in-memory production rate limiter", () => {
    expect(() => loadConfig(productionEnvironment({ RATE_LIMIT_BACKEND: "memory" }))).toThrow(
      "RATE_LIMIT_BACKEND=redis is required"
    );
  });

  it("fails closed when production Redis rate limiting is unavailable", () => {
    expect(() => loadConfig(productionEnvironment({ RATE_LIMIT_SKIP_ON_REDIS_ERROR: "true" }))).toThrow(
      "RATE_LIMIT_SKIP_ON_REDIS_ERROR=false is required"
    );
  });

  it("rejects short operator credentials", () => {
    expect(() => loadConfig(productionEnvironment({ OPS_API_KEY: "too-short" }))).toThrow("OPS_API_KEY");
  });

  it("requires operator credentials in production", () => {
    expect(() => loadConfig(productionEnvironment({ OPS_API_KEY: "" }))).toThrow(
      "OPS_API_KEY is required when NODE_ENV=production"
    );
  });

  it("rejects an invalid or zero treasury Safe before startup", () => {
    expect(() => loadConfig(productionEnvironment({ TREASURY_SAFE_ADDRESS: "not-an-address" }))).toThrow(
      "TREASURY_SAFE_ADDRESS must be a valid EVM address"
    );
    expect(() => loadConfig(productionEnvironment({ TREASURY_SAFE_ADDRESS: "0x0000000000000000000000000000000000000000" }))).toThrow(
      "TREASURY_SAFE_ADDRESS must not be the zero address"
    );
  });

  it("bounds database pool tuning values", () => {
    expect(() => loadConfig(productionEnvironment({ DATABASE_POOL_MAX: "11" }))).toThrow("DATABASE_POOL_MAX");
    expect(() => loadConfig(productionEnvironment({ DATABASE_CONNECTION_TIMEOUT_MS: "999" }))).toThrow(
      "DATABASE_CONNECTION_TIMEOUT_MS"
    );
    expect(() => loadConfig(productionEnvironment({ DATABASE_STATEMENT_TIMEOUT_MS: "60001" }))).toThrow(
      "DATABASE_STATEMENT_TIMEOUT_MS"
    );
  });
});
