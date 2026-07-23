import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-wallet",
  timeout: 30_000,
  webServer: [
    {
      command:
        "VITE_ENABLE_PRIVY=true VITE_PRIVY_APP_ID=wallet-runtime-test VITE_WALLETCONNECT_PROJECT_ID= npm run dev -- --host 127.0.0.1 --port 5175",
      reuseExistingServer: false,
      url: "http://localhost:5175"
    },
    {
      command:
        "VITE_ENABLE_PRIVY=true VITE_PRIVY_APP_ID=wallet-runtime-test VITE_SETTLEMENT_CHAIN_ID=1 npm run dev -- --host 127.0.0.1 --port 5176",
      reuseExistingServer: false,
      url: "http://localhost:5176"
    }
  ],
  use: {
    baseURL: "http://localhost:5175",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium-wallet-runtime",
      testMatch: "wallet-runtime.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5175" }
    },
    {
      name: "chromium-unsupported-wallet-config",
      testMatch: "unsupported-wallet-config.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5176" }
    }
  ]
});
