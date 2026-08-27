import { expect, test } from "@playwright/test";

const market = {
  marketId: "wallet-runtime-market",
  conditionId: "wallet-runtime-condition",
  question: "Will the wallet runtime preserve this basket?",
  marketUrl: "https://polymarket.com/event/wallet-runtime-market",
  category: "Technology and Science",
  endDate: "2027-07-20T22:00:00Z",
  liquidity: 100_000,
  volume: 1_000_000,
  source: "polymarket",
  sourceActive: true,
  closed: false,
  archived: false,
  acceptingOrders: true,
  enableOrderBook: true
};

test("loading and connecting the deferred wallet runtime preserves the basket", async ({ page }) => {
  let walletRuntimeRequests = 0;
  await page.route("**/src/WalletRuntime.tsx*", async (route) => {
    walletRuntimeRequests += 1;
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        import React from "/@id/react";
        const { useEffect } = React;
        export default function WalletRuntime({ connectIntent, onAuthChange }) {
          useEffect(() => {
            const connected = connectIntent > 0;
            onAuthChange({
              authenticated: connected,
              ready: true,
              walletSynced: connected,
              walletSyncStatus: connected ? "synced" : "idle",
              walletSyncError: "",
              walletUsdcBalance: connected ? 33 : null,
              walletBalanceState: connected ? "ready" : "idle",
              walletBalanceError: "",
              userLabel: connected ? "0xabc...1234" : "Wallet connected",
              walletAddress: connected ? "0xabc0000000000000000000000000000000001234" : undefined,
              getAccessToken: async () => connected ? "test-access-token" : null,
              sendUsdcPayment: async () => "0xpayment",
              retryWalletSync: () => {},
              logout: () => {}
            });
          }, [connectIntent, onAuthChange]);
          return null;
        }
      `
    });
  });

  await page.route("**/api/markets**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        asOf: new Date().toISOString(),
        source: "polymarket",
        complete: true,
        outcomes: [
          { ...market, id: "wallet-runtime-yes", tokenId: "wallet-runtime-yes-token", outcome: "Yes", price: 0.4 },
          { ...market, id: "wallet-runtime-no", tokenId: "wallet-runtime-no-token", outcome: "No", price: 0.6 }
        ],
        pageInfo: { limit: 48, offset: 0, hasMore: false, total: 1 }
      })
    });
  });

  await page.goto("/");
  await page.waitForTimeout(300);
  expect(walletRuntimeRequests).toBe(0);
  const card = page.locator(".market-card").filter({ hasText: market.question });
  await card.getByRole("button", { name: /Yes/ }).click();
  await expect(page.locator(".ticket-pane .leg-row")).toHaveCount(1);

  await page.locator(".wallet-pill.connect").click();
  await expect.poll(() => walletRuntimeRequests).toBe(1);
  await expect(page.getByRole("button", { name: /Disconnect wallet/ })).toBeVisible();
  await expect(page.locator(".wallet-pill")).toContainText("Synced");
  await expect(page.locator(".ticket-pane .leg-row")).toHaveCount(1);
});

test("a failed deferred wallet runtime keeps the app and basket available", async ({ page }) => {
  let walletRuntimeRequests = 0;
  await page.route("**/src/WalletRuntime.tsx*", async (route) => {
    walletRuntimeRequests += 1;
    await route.abort("failed");
  });
  await page.route("**/api/markets**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        asOf: new Date().toISOString(),
        source: "polymarket",
        complete: true,
        outcomes: [
          { ...market, id: "wallet-runtime-failure-yes", tokenId: "wallet-runtime-failure-yes-token", outcome: "Yes", price: 0.4 },
          { ...market, id: "wallet-runtime-failure-no", tokenId: "wallet-runtime-failure-no-token", outcome: "No", price: 0.6 }
        ],
        pageInfo: { limit: 48, offset: 0, hasMore: false, total: 1 }
      })
    });
  });

  await page.goto("/");
  const card = page.locator(".market-card").filter({ hasText: market.question });
  await card.getByRole("button", { name: /Yes/ }).click();
  await expect(page.locator(".ticket-pane .leg-row")).toHaveCount(1);

  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect.poll(() => walletRuntimeRequests).toBe(1);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Wallet connection is temporarily unavailable");
  await expect(alert).toContainText("Your basket is still here");
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator(".ticket-pane .leg-row")).toHaveCount(1);
});

test("expired authentication and sync loss block USDC before the wallet transfer", async ({ page }) => {
  await page.route("**/src/WalletRuntime.tsx*", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        import React from "/@id/react";
        const { useEffect, useState } = React;
        let tokenAvailable = true;
        export default function WalletRuntime({ connectIntent, onAuthChange }) {
          const [synced, setSynced] = useState(true);
          const connected = connectIntent > 0;
          useEffect(() => {
            const expire = () => { tokenAvailable = false; };
            const loseSync = () => setSynced(false);
            window.addEventListener("test-expire-wallet-token", expire);
            window.addEventListener("test-lose-wallet-sync", loseSync);
            return () => {
              window.removeEventListener("test-expire-wallet-token", expire);
              window.removeEventListener("test-lose-wallet-sync", loseSync);
            };
          }, []);
          useEffect(() => {
            onAuthChange({
              authenticated: connected,
              ready: true,
              walletSynced: connected && synced,
              walletSyncStatus: connected && synced ? "synced" : connected ? "limited" : "idle",
              walletSyncError: synced ? "" : "Wallet sync unavailable.",
              walletUsdcBalance: connected ? 33 : null,
              walletBalanceState: connected ? "ready" : "idle",
              walletBalanceError: "",
              userLabel: connected ? "0xabc...1234" : "Wallet connected",
              walletAddress: connected ? "0xabc0000000000000000000000000000000001234" : undefined,
              getAccessToken: async () => tokenAvailable ? "test-access-token" : null,
              sendUsdcPayment: async () => {
                window.__walletTransferCalls = (window.__walletTransferCalls || 0) + 1;
                return "0xpayment";
              },
              retryWalletSync: () => {},
              logout: () => {}
            });
          }, [connected, onAuthChange, synced]);
          return null;
        }
      `
    });
  });

  const secondMarket = { ...market, marketId: "wallet-runtime-market-two", conditionId: "wallet-runtime-condition-two", question: "Will the second wallet test market resolve?", marketUrl: "https://polymarket.com/event/wallet-runtime-market-two" };
  await page.route("**/api/markets**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        asOf: new Date().toISOString(), source: "polymarket", complete: true,
        outcomes: [
          { ...market, id: "wallet-one-yes", tokenId: "wallet-one-yes-token", outcome: "Yes", price: 0.4 },
          { ...market, id: "wallet-one-no", tokenId: "wallet-one-no-token", outcome: "No", price: 0.6 },
          { ...secondMarket, id: "wallet-two-yes", tokenId: "wallet-two-yes-token", outcome: "Yes", price: 0.5 },
          { ...secondMarket, id: "wallet-two-no", tokenId: "wallet-two-no-token", outcome: "No", price: 0.5 }
        ],
        pageInfo: { limit: 48, offset: 0, hasMore: false, total: 2 }
      })
    });
  });
  await page.route("**/api/quotes", async (route) => {
    await route.fulfill({
      status: 201, contentType: "application/json",
      body: JSON.stringify({ id: "wallet-quote", status: "quoted", expiresAt: new Date(Date.now() + 60_000).toISOString(), riskDecision: "accept", potentialPayoutUsd: 40 })
    });
  });
  await page.route("**/api/quotes/wallet-quote/payment-intent", async (route) => {
    await route.fulfill({
      status: 201, contentType: "application/json",
      body: JSON.stringify({
        id: "wallet-intent", quoteId: "wallet-quote", chainId: 11155111, currency: "USDC",
        treasuryAddress: "0x1d4fd58d9fc24c9f3c8da0deb4a05e7d122ef17b",
        usdcContractAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
        amountMicroUnits: "25000000", amountUsdc: 25, requiredConfirmations: 1, status: "pending",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByLabel("Set max stake").click();
  await page.locator(".market-card").filter({ hasText: market.question }).getByRole("button", { name: /Yes/ }).click();
  await page.locator(".market-card").filter({ hasText: secondMarket.question }).getByRole("button", { name: /Yes/ }).click();
  await page.getByRole("button", { name: "Review basket" }).click();
  const send = page.getByRole("button", { name: "Send USDC" });
  await expect(send).toBeEnabled();

  await page.evaluate(() => window.dispatchEvent(new Event("test-expire-wallet-token")));
  await send.click();
  await expect(page.getByText(/session expired before payment/i)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __walletTransferCalls?: number }).__walletTransferCalls || 0)).toBe(0);

  await page.evaluate(() => window.dispatchEvent(new Event("test-lose-wallet-sync")));
  await expect(send).toBeDisabled();
});
