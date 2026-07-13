import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  webServer: {
    command: "VITE_ENABLE_PRIVY=false VITE_PRIVY_APP_ID= VITE_WALLETCONNECT_PROJECT_ID= npm run dev -- --host 127.0.0.1 --port 5174",
    reuseExistingServer: false,
    url: "http://localhost:5174"
  },
  use: {
    baseURL: "http://localhost:5174",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
