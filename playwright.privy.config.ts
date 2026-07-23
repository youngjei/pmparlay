import { defineConfig, devices } from "@playwright/test";

if (process.env.PRIVY_E2E !== "1") {
  throw new Error("PRIVY_E2E=1 is required for the real Privy boundary test.");
}

export default defineConfig({
  testDir: "./tests-privy",
  globalTeardown: "./tests-privy/globalTeardown.ts",
  timeout: 60_000,
  workers: 1,
  webServer: {
    command: "bash scripts/privy-e2e-server.sh",
    reuseExistingServer: false,
    timeout: 60_000,
    url: "http://localhost:5175"
  },
  use: {
    baseURL: "http://localhost:5175",
    trace: "off",
    screenshot: "off",
    video: "off"
  },
  projects: [{ name: "chromium-real-privy", use: { ...devices["Desktop Chrome"] } }]
});
