import { expect, test, type Page } from "@playwright/test";

const liveEvents = [
  {
    slug: "world-cup-winner",
    title: "2026 FIFA World Cup Winner",
    icon: "https://example.com/usa.png",
    category: "Sports",
    volume: 129_800_000,
    endDate: "2027-07-20T22:00:00Z",
    markets: [
      {
        id: "usa-world-cup",
        conditionId: "usa-world-cup-condition",
        question: "Will USA win the 2026 FIFA World Cup?",
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.025", "0.975"],
        clobTokenIds: ["usa-yes", "usa-no"],
        volumeNum: 129_800_000,
        endDate: "2027-07-20T22:00:00Z"
      },
      {
        id: "mexico-world-cup",
        conditionId: "mexico-world-cup-condition",
        question: "Will Mexico win the 2026 FIFA World Cup?",
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.034", "0.966"],
        clobTokenIds: ["mexico-yes", "mexico-no"],
        volumeNum: 129_100_000,
        endDate: "2027-07-20T22:00:00Z"
      },
      {
        id: "morocco-world-cup",
        conditionId: "morocco-world-cup-condition",
        question: "Will Morocco win the 2026 FIFA World Cup?",
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.028", "0.972"],
        clobTokenIds: ["morocco-yes", "morocco-no"],
        volumeNum: 125_000_000,
        endDate: "2027-07-20T22:00:00Z"
      }
    ]
  },
  {
    slug: "democratic-presidential-nominee-2028",
    icon: "https://example.com/newsom.png",
    category: "Politics",
    volume: 26_300_000,
    endDate: "2027-11-07T22:00:00Z",
    markets: [
      {
        id: "newsom-nominee",
        conditionId: "newsom-nominee-condition",
        question: "Will Gavin Newsom win the 2028 Democratic presidential nomination?",
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.21", "0.79"],
        clobTokenIds: ["newsom-yes", "newsom-no"],
        volumeNum: 26_300_000,
        endDate: "2027-11-07T22:00:00Z"
      }
    ]
  },
  {
    slug: "bitcoin-up-or-down-july-5",
    icon: "https://example.com/btc.png",
    category: "Crypto",
    volume: 4_850_000,
    endDate: "2027-07-05T10:00:00Z",
    markets: [
      {
        id: "btc-up",
        conditionId: "btc-up-condition",
        question: "Bitcoin Up or Down in the next hour?",
        outcomes: ["Up", "Down"],
        outcomePrices: ["0.53", "0.47"],
        clobTokenIds: ["btc-up", "btc-down"],
        volumeNum: 4_850_000,
        endDate: "2027-07-05T10:00:00Z"
      }
    ]
  },
  {
    slug: "ethereum-up-or-down-july-5",
    icon: "https://example.com/eth.png",
    category: "Crypto",
    volume: 2_740_000,
    endDate: "2027-07-05T10:00:00Z",
    markets: [
      {
        id: "eth-up",
        conditionId: "eth-up-condition",
        question: "Ethereum Up or Down in the next hour?",
        outcomes: ["Up", "Down"],
        outcomePrices: ["0.49", "0.51"],
        clobTokenIds: ["eth-up", "eth-down"],
        volumeNum: 2_740_000,
        endDate: "2027-07-05T10:00:00Z"
      }
    ]
  },
  {
    slug: "reversed-outcome-order",
    icon: "https://example.com/reverse.png",
    category: "Technology",
    volume: 1_900_000,
    endDate: "2027-08-01T10:00:00Z",
    markets: [
      {
        id: "reverse-order",
        conditionId: "reverse-order-condition",
        question: "Will reversed outcome order stay mapped?",
        outcomes: ["No", "Yes"],
        outcomePrices: ["0.80", "0.20"],
        clobTokenIds: ["reverse-no", "reverse-yes"],
        volumeNum: 1_900_000,
        endDate: "2027-08-01T10:00:00Z"
      }
    ]
  },
  {
    slug: "argentina-world-cup",
    icon: "https://example.com/argentina.png",
    category: "Sports",
    volume: 2_810_000,
    endDate: "2027-07-19T22:00:00Z",
    markets: [
      {
        id: "argentina",
        conditionId: "argentina-condition",
        question: "Will Argentina win the next World Cup?",
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.09", "0.91"],
        clobTokenIds: ["argentina-yes", "argentina-no"],
        volumeNum: 2_810_000,
        endDate: "2027-07-19T22:00:00Z"
      }
    ]
  },
  {
    slug: "expired-market",
    icon: "https://example.com/expired.png",
    category: "Politics",
    volume: 8_888_888,
    endDate: "2025-12-31T23:59:00Z",
    markets: [
      {
        id: "expired",
        conditionId: "expired-condition",
        question: "Will this expired market still appear?",
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.40", "0.60"],
        clobTokenIds: ["expired-yes", "expired-no"],
        volumeNum: 8_888_888,
        endDate: "2025-12-31T23:59:00Z"
      }
    ]
  },
  {
    slug: "already-decided-market",
    icon: "https://example.com/skewed.png",
    category: "Politics",
    volume: 9_999_999,
    endDate: "2027-07-05T10:00:00Z",
    markets: [
      {
        id: "skewed",
        conditionId: "skewed-condition",
        question: "Will this already-decided market resolve yes?",
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.995", "0.005"],
        clobTokenIds: ["skewed-yes", "skewed-no"],
        volumeNum: 9_999_999,
        endDate: "2027-07-05T10:00:00Z"
      }
    ]
  }
];

function mockApiOutcomes() {
  return liveEvents.flatMap((event) =>
    event.markets.flatMap((market) => {
      const prices = market.outcomePrices.map(Number);
      const hasSkewedPrice = prices.some((price) => Number.isFinite(price) && (price >= 0.99 || price <= 0.01));
      const endDate = market.endDate || event.endDate;

      if (hasSkewedPrice || new Date(endDate).getTime() < Date.now()) {
        return [];
      }

      return market.outcomes.map((outcome, index) => ({
        id: `${market.conditionId || market.id}-${outcome}`,
        marketId: market.conditionId || market.id,
        conditionId: market.conditionId,
        tokenId: market.clobTokenIds[index],
        question: market.question,
        marketUrl: `https://polymarket.com/event/${event.slug}`,
        image: event.icon,
        icon: event.icon,
        category: event.category,
        eventGroupKey: `polymarket:event:${event.slug}`,
        eventTitle: event.title || event.slug,
        eventSlug: event.slug,
        outcome,
        price: prices[index],
        endDate,
        liquidity: market.volumeNum,
        volume: market.volumeNum,
        source: "polymarket"
      }));
    })
  );
}

async function mockPolymarket(page: Page) {
  await page.route("**/api/account", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        balances: [],
        openTickets: 0,
        openStakeUsd: 0,
        openPotentialPayoutUsd: 0,
        openNetLiabilityUsd: 0
      })
    });
  });
  await page.route("**/api/tickets", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tickets: [] }) });
  });
  await page.route("**/api/tickets/claimable**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tickets: [], pageInfo: { hasMore: false } })
    });
  });
  await page.route("**/api/withdrawals", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ withdrawals: [] }) });
  });
  await page.route("**/api/payment-intents", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ paymentIntents: [] }) });
  });
  await page.route("**/api/quotes", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        id: "quote-test",
        status: "quoted",
        createdAt: "2026-07-05T15:35:28.638Z",
        expiresAt: "2026-07-05T15:35:43.638Z",
        sourceAsOf: "2026-07-05T15:35:28.638Z",
        stakeUsd: 5,
        operationFeeUsd: 1,
        totalCostUsd: 6,
        basketPrice: 0.125,
        basketProbability: 0.125,
        quoteSpread: 0.1,
        payoutMultiple: 7.2,
        potentialPayoutUsd: 36,
        riskDecision: "accept",
        riskChecks: [],
        legs: [
          {
            id: "btc-up-refreshed",
            marketId: "btc-up-condition",
            question: "Refreshed Bitcoin execution",
            outcome: "Up",
            price: 0.55,
            marketUrl: "https://polymarket.com/event/bitcoin-up-or-down-july-5",
            endDate: "2027-07-05T10:00:00Z"
          },
          {
            id: "eth-up-refreshed",
            marketId: "eth-up-condition",
            question: "Refreshed Ethereum execution",
            outcome: "Up",
            price: 0.48,
            marketUrl: "https://polymarket.com/event/ethereum-up-or-down-july-5",
            endDate: "2027-07-05T10:00:00Z"
          }
        ]
      })
    });
  });

  await page.route("**/api/quotes/*/accept", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        ticketId: "ticket-test-1234",
        quoteId: "quote-test",
        status: "accepted",
        ledgerTransactionId: "ledger-test"
      })
    });
  });

  await page.route("**/api/quotes/*/payment-intent", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        id: "payment-intent-test",
        quoteId: "quote-test",
        chainId: 11155111,
        currency: "USDC",
        treasuryAddress: "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B",
        usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        amountMicroUnits: "6000000",
        amountUsdc: 6,
        requiredConfirmations: 2,
        status: "pending",
        expiresAt: "2027-07-05T15:38:28.638Z"
      })
    });
  });

  await page.route("**/api/markets**", async (route) => {
    const url = new URL(route.request().url());
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();
    const category = url.searchParams.get("category");
    const outcomes = mockApiOutcomes().filter((outcome) => {
      if (category && outcome.category !== category) return false;
      if (!search) return true;
      return `${outcome.question} ${outcome.outcome} ${outcome.category}`.toLowerCase().includes(search);
    });
    const marketCount = new Set(outcomes.map((outcome) => outcome.marketId)).size;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        asOf: new Date().toISOString(),
        source: "polymarket",
        outcomes,
        pageInfo: {
          limit: 48,
          offset: 0,
          hasMore: false,
          total: marketCount
        }
      })
    });
  });

  await page.route("https://gamma-api.polymarket.com/**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events: liveEvents })
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockPolymarket(page);
});

test("market basket controls work", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".brand-lockup")).toContainText("LEGWORK");
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
  await expect(page.getByText("Indicative price")).toHaveCount(0);
  await expect(page.getByLabel("Quote summary")).toContainText("Basket price");
  await expect(page.getByLabel("Search markets")).toBeVisible();
  await expect(page.getByLabel("Sort markets")).toBeVisible();
  await expect(page.getByRole("group", { name: "Category filters" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
  await expect(page.getByText("already-decided")).toHaveCount(0);
  await expect(page.getByText("expired market")).toHaveCount(0);

  await page.getByLabel("Sort markets").selectOption("newest");
  await expect(page.locator(".market-card").first()).toBeVisible();
  await page.getByLabel("Sort markets").selectOption("volume");
  await page.getByLabel("Search markets").fill("Up or Down");

  const firstMarket = page.locator(".market-card").first();
  await expect(firstMarket).toBeVisible();
  await expect(firstMarket.getByRole("link", { name: "Open on Polymarket" })).toHaveAttribute(
    "href",
    /polymarket\.com\/event\//
  );
  await expect(page.getByText("Demo only")).toHaveCount(0);
  await firstMarket.getByRole("button", { name: /Up\s+53¢/ }).click();
  await expect(page.getByText("Select 2+ markets to price a basket")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
  await expect(page.getByLabel("Quote summary")).toContainText("Potential payout—");
  await expect(page.getByText("Add one more market to unlock a basket quote.")).toBeVisible();
  await expect(page.getByText("Basket availability")).toHaveCount(0);

  await page.getByLabel("Set max stake").click();
  const secondMarket = page.locator(".market-card").nth(1);
  await secondMarket.getByRole("button", { name: /Up\s+49¢/ }).click();
  await expect(page.locator(".payout-callout .firework-burst")).toBeAttached();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeEnabled();
  await page.getByRole("button", { name: "Review basket" }).click();
  const paymentDialog = page.getByRole("dialog", { name: "Buy this basket" });
  await expect(paymentDialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Send USDC" })).toBeDisabled();
  await expect(paymentDialog.locator(".payment-hero")).toContainText("$6.00");
  for (const value of ["$36", "13¢", "10.0%", "7.20x", "$1.00"]) {
    await expect(paymentDialog.locator(".payment-grid")).toContainText(value);
  }
  for (const value of ["Up · 55¢", "Refreshed Bitcoin execution", "Up · 48¢", "Refreshed Ethereum execution"]) {
    await expect(paymentDialog.locator(".payment-leg-list")).toContainText(value);
  }
  await expect(paymentDialog.getByText(/Closes .*2027/)).toHaveCount(2);
  await expect(paymentDialog.getByRole("link", { name: "View market rules" })).toHaveCount(2);
  await page.getByLabel("Close payment review").click();

  await secondMarket.getByRole("button", { name: /Down\s+51¢/ }).click();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeEnabled();

  await page.getByLabel("Buy amount").fill("0");
  await page.getByLabel("Buy amount").blur();
  await page.getByLabel("Add $2").click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("2");
  await page.getByLabel("Add $5").click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("5");
  await page.getByLabel("Add $1").click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("5");
  await page.getByLabel("Buy amount").fill("999");
  await page.getByLabel("Buy amount").blur();
  await expect(page.getByLabel("Buy amount")).toHaveValue("5");

  await page.getByLabel("Search markets").fill("Argentina");
  await expect(page.locator(".market-card").first()).toContainText(/Argentina/i);
  await page.getByLabel("Search markets").fill("");

  const sportsChip = page.getByRole("group", { name: "Category filters" }).getByRole("button", { name: "Sports", exact: true });
  if ((await sportsChip.count()) > 0) await sportsChip.click();

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Select 2+ markets to price a basket")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
});

test("incomplete basket states never imply a payout or fee before buy amount", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search markets").fill("Up or Down");
  await page.locator(".market-card").nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.locator(".market-card").nth(1).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();

  await expect(page.locator(".payout-callout")).toContainText("Enter buy amount to see payout.");
  await expect(page.locator(".payout-callout .payout-value")).toHaveText("—");
  await expect(page.getByLabel("Quote summary")).toContainText("Amount due$0.00");
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
  await expect(page.getByText("Basket unavailable")).toHaveCount(0);
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(0);
});

test("failed quote preparation hides estimates and offers a real retry", async ({ page }) => {
  await page.unroute("**/api/quotes");
  await page.route("**/api/quotes", (route) =>
    route.fulfill({ contentType: "application/json", status: 503, body: JSON.stringify({ error: "temporarily_unavailable" }) })
  );
  await page.goto("/");
  await page.getByLabel("Set max stake").click();
  await page.getByLabel("Search markets").fill("Up or Down");
  await page.locator(".market-card").nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.locator(".market-card").nth(1).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.getByRole("button", { name: "Review basket" }).click();

  const dialog = page.getByRole("dialog", { name: "Buy this basket" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".payment-hero")).toContainText("Unavailable");
  await expect(dialog.locator(".payment-grid")).toContainText("Unavailable");
  await expect(dialog.getByRole("button", { name: "Retry quote" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Send USDC" })).toHaveCount(0);
});

test("mobile guidance progresses from zero picks through a priced basket", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/");
  const basketBar = page.locator(".mobile-basket-bar");
  await expect(basketBar).toContainText("Add two markets");

  await page.getByLabel("Search markets").fill("Up or Down");
  await page.locator(".market-card").nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await expect(basketBar).toContainText("Add one more");
  await page.locator(".market-card").nth(1).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await expect(basketBar).toContainText("Enter buy amount");
  await basketBar.click();
  await page.getByLabel("Mobile buy amount").fill("5");
  await expect(page.locator(".mobile-basket-sheet .mobile-payout-value")).toContainText("potential");
});

for (const width of [320, 390]) {
  test(`mobile basket bar stays inside a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.getByLabel("Search markets").fill("Up or Down");
    await page.locator(".market-card").nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();

    const bar = page.locator(".mobile-basket-bar");
    const summary = bar.locator(":scope > div");
    const cta = bar.locator(".mobile-review");
    const [metrics, summaryBox, ctaBox] = await Promise.all([
      bar.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })),
      summary.boundingBox(),
      cta.boundingBox()
    ]);

    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(summaryBox).not.toBeNull();
    expect(ctaBox).not.toBeNull();
    expect(ctaBox!.x + ctaBox!.width).toBeLessThanOrEqual(width);
    expect(summaryBox!.x + summaryBox!.width).toBeLessThanOrEqual(ctaBox!.x - 8);
    await expect(bar).toHaveAttribute("aria-label", /Open basket: 1 selected\./);
  });
}

test("tablet and short desktop keep basket review controls in reach", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await page.goto("/");
  await expect(page.locator(".mobile-basket-bar")).toBeVisible();
  await expect(page.locator(".ticket-pane")).toBeHidden();
  await page.locator(".mobile-basket-bar").click();
  const tabletBasket = page.getByRole("dialog", { name: "Basket" });
  await expect(tabletBasket).toBeVisible();
  const tabletReviewBox = await tabletBasket.getByRole("button", { name: "Review basket" }).boundingBox();
  expect(tabletReviewBox).not.toBeNull();
  expect(tabletReviewBox!.height).toBeLessThanOrEqual(60);
  await page.getByLabel("Collapse basket").click();

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel("Search markets").fill("Up or Down");
  await page.locator(".market-card").nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.locator(".market-card").nth(1).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.getByLabel("Set max stake").click();

  const payoutBox = await page.locator(".payout-callout").boundingBox();
  const reviewBox = await page.locator(".ticket-pane").getByRole("button", { name: "Review basket" }).boundingBox();
  expect(payoutBox).not.toBeNull();
  expect(reviewBox).not.toBeNull();
  expect(payoutBox!.y + payoutBox!.height, "payout bottom").toBeLessThanOrEqual(720);
  expect(reviewBox!.y + reviewBox!.height, "review bottom").toBeLessThanOrEqual(720);
});

test("disconnected basket CTA opens wallet connection instead of becoming a dead end", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const [appModule, reactModule, reactDomClientModule] = await Promise.all([
      import("/src/App.tsx"),
      import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js")
    ]);
    const rootElement = document.getElementById("root")!;
    rootElement.replaceChildren();
    const react = reactModule.default || reactModule;
    const reactDomClient = reactDomClientModule.default || reactDomClientModule;
    (window as Window & { __loginCalls?: number }).__loginCalls = 0;
    reactDomClient.createRoot(rootElement).render(
      react.createElement(appModule.default, {
        auth: {
          enabled: true,
          authenticated: false,
          ready: true,
          walletSynced: false,
          walletSyncStatus: "idle",
          login: () => {
            const testWindow = window as Window & { __loginCalls?: number };
            testWindow.__loginCalls = (testWindow.__loginCalls || 0) + 1;
          }
        }
      })
    );
  });

  await page.getByLabel("Set max stake").click();
  await page.getByLabel("Search markets").fill("Up or Down");
  await page.locator(".market-card").nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.locator(".market-card").nth(1).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  const connect = page.locator(".ticket-pane").getByRole("button", { name: "Connect wallet" });
  await expect(connect).toBeEnabled();
  await connect.click();
  expect(await page.evaluate(() => (window as Window & { __loginCalls?: number }).__loginCalls)).toBe(1);
});

test("outcome buttons preserve Polymarket label-price-id mapping", async ({ page }) => {
  let quoteBody: unknown;
  await page.unroute("**/api/quotes");
  await page.route("**/api/quotes", async (route) => {
    quoteBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        id: "quote-test",
        status: "quoted",
        createdAt: "2026-07-05T15:35:28.638Z",
        expiresAt: "2026-07-05T15:35:43.638Z",
        sourceAsOf: "2026-07-05T15:35:28.638Z",
        stakeUsd: 5,
        operationFeeUsd: 1,
        totalCostUsd: 6,
        basketPrice: 0.125,
        basketProbability: 0.125,
        quoteSpread: 0.1,
        payoutMultiple: 7.2,
        potentialPayoutUsd: 36,
        riskDecision: "accept",
        riskChecks: [],
        legs: []
      })
    });
  });

  await page.goto("/");
  await page.getByLabel("Set max stake").click();
  await page.getByLabel("Search markets").fill("reversed outcome");

  const reversedMarket = page.locator(".market-card").filter({ hasText: "Will reversed outcome order stay mapped?" });
  await expect(reversedMarket.getByRole("button", { name: /No\s+80¢/ })).toBeVisible();
  await expect(reversedMarket.getByRole("button", { name: /Yes\s+20¢/ })).toBeVisible();
  await reversedMarket.getByRole("button", { name: /Yes\s+20¢/ }).click();
  await expect(page.getByText("Yes at 20¢")).toBeVisible();

  await page.getByLabel("Search markets").fill("Gavin Newsom");
  await page
    .locator(".market-card")
    .filter({ hasText: "Will Gavin Newsom win the 2028 Democratic presidential nomination?" })
    .getByRole("button", { name: /No\s+79¢/ })
    .click();

  await page.getByRole("button", { name: "Review basket" }).click();
  expect(quoteBody).toEqual({
    stakeUsd: 5,
    legs: [{ id: "reverse-order-condition-Yes" }, { id: "newsom-nominee-condition-No" }]
  });
});

test("mobile basket sheet shows and removes selected markets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/");
  await page.getByLabel("Search markets").fill("Up or Down");

  const firstMarket = page.locator(".market-card").first();
  const secondMarket = page.locator(".market-card").nth(1);
  await expect(firstMarket).toBeVisible();

  await firstMarket.locator(".outcome-btn").first().click();
  await secondMarket.locator(".outcome-btn").first().click();

  await page.locator(".mobile-basket-bar").click();
  await expect(page.getByRole("dialog", { name: "Basket" })).toBeVisible();
  await expect(page.locator(".mobile-leg-list .leg-row")).toHaveCount(2);

  await page.locator(".mobile-leg-list .leg-row").first().getByLabel("Remove leg").click();
  await expect(page.locator(".mobile-leg-list .leg-row")).toHaveCount(1);

  await page.getByLabel("Collapse basket").last().click();
  await expect(page.getByRole("dialog", { name: "Basket" })).toHaveCount(0);
});

test("same event winner yes collapses the group and permits replacement", async ({ page }) => {
  await page.goto("/");

  const filteredMarkets = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/markets" && url.searchParams.get("search") === "2026 FIFA World Cup";
  });
  await page.getByLabel("Search markets").fill("2026 FIFA World Cup");
  await filteredMarkets;
  await expect(page.locator(".event-card")).toHaveCount(1);
  const event = page.locator(".event-card").first();
  await event.getByRole("button", { name: /Expand/ }).click();
  await event.locator(".event-sibling-row").filter({ hasText: "Will Morocco win the 2026 FIFA World Cup?" }).getByRole("button", { name: /Yes/ }).click();

  await expect(event.locator(".event-selected-summary")).toContainText("Will Morocco win the 2026 FIFA World Cup? · Yes · 2.8¢");
  await event.getByRole("button", { name: /Expand/ }).click();
  await expect(event.locator(".event-sibling-row").filter({ hasText: "Will USA win the 2026 FIFA World Cup?" })).toBeVisible();
  await expect(event.locator(".event-sibling-row").filter({ hasText: "Will Mexico win the 2026 FIFA World Cup?" })).toBeVisible();
  await expect(page.getByText("Yes at 2.8¢")).toBeVisible();
  await expect(page.getByText("No at 98¢")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
});

test("same event winner no collapses the group and permits replacement", async ({ page }) => {
  await page.goto("/");

  const filteredMarkets = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/markets" && url.searchParams.get("search") === "2026 FIFA World Cup";
  });
  await page.getByLabel("Search markets").fill("2026 FIFA World Cup");
  await filteredMarkets;
  await expect(page.locator(".event-card")).toHaveCount(1);
  const event = page.locator(".event-card").first();
  await event.getByRole("button", { name: /Expand/ }).click();
  await event.locator(".event-sibling-row").filter({ hasText: "Will USA win the 2026 FIFA World Cup?" }).getByRole("button", { name: /No/ }).click();

  await expect(event.locator(".event-selected-summary")).toContainText("Will USA win the 2026 FIFA World Cup? · No · 98¢");
  await event.getByRole("button", { name: /Expand/ }).click();
  await expect(event.locator(".event-sibling-row").filter({ hasText: "Will Morocco win the 2026 FIFA World Cup?" })).toBeVisible();
  await expect(event.locator(".event-sibling-row").filter({ hasText: "Will Mexico win the 2026 FIFA World Cup?" })).toBeVisible();
  await expect(page.getByText("No at 98¢")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
});

test("large upside simple liquid basket is blocked by the closed beta payout cap", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Set max stake").click();

  await page.getByLabel("Search markets").fill("USA win");
  await page.locator(".market-card").filter({ hasText: "Will USA win the 2026 FIFA World Cup?" }).getByRole("button", { name: /Yes/ }).click();
  await page.getByLabel("Search markets").fill("Gavin Newsom");
  await page.locator(".market-card").filter({ hasText: "Will Gavin Newsom win the 2028 Democratic presidential nomination?" }).getByRole("button", {
    name: /Yes/
  }).click();

  await expect(page.getByRole("button", { name: "Basket unavailable" })).toBeDisabled();
  await expect(page.getByText("Basket availability")).toBeVisible();
  await expect(page.locator(".risk-panel strong", { hasText: "Unavailable" })).toBeVisible();
  await expect(page.getByText("Payout cap")).toBeVisible();
  await expect(page.getByText("Manual review")).toHaveCount(0);
  await expect(page.getByText("Price check needed")).toHaveCount(0);
});

test("positive-upside favorite basket stake controls clamp at the $5 launch cap", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Search markets").fill("Gavin Newsom");
  await page
    .locator(".market-card")
    .filter({ hasText: "Will Gavin Newsom win the 2028 Democratic presidential nomination?" })
    .getByRole("button", { name: /No/ })
    .click();
  await page.getByLabel("Search markets").fill("USA win");
  await page.locator(".market-card").filter({ hasText: "Will USA win the 2026 FIFA World Cup?" }).getByRole("button", { name: /No/ }).click();
  await page.getByLabel("Search markets").fill("Argentina");
  await page.locator(".market-card").filter({ hasText: "Will Argentina win the next World Cup?" }).getByRole("button", { name: /No/ }).click();

  await page.getByLabel("Buy amount").fill("3");
  await page.getByLabel("Buy amount").blur();
  await page.getByRole("button", { name: "Add $2", exact: true }).click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("5");

  await page.getByRole("button", { name: "Add $5", exact: true }).click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("5");
});

test("claimable tickets load every page, use claimable amounts, and keep one idempotency key per retry", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.unroute("**/api/tickets/claimable**");

  const claimableRequests: string[] = [];
  const claimKeys: string[] = [];
  let claimAttempts = 0;
  const claimableTicket = (ticketId: string, claimableAmountUsd: number, status = "claimable") => ({
    ticketId,
    quoteId: `quote-${ticketId}`,
    status,
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-02T10:00:00Z",
    amountPaidUsd: 5,
    potentialPayoutUsd: 999,
    claimableAmountUsd,
    legs: 2
  });

  await page.route("**/api/tickets/claimable**", async (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor") || "";
    claimableRequests.push(cursor);
    const body =
      cursor === "older-claims"
        ? {
            tickets: [claimableTicket("claim-old", 4.56), claimableTicket("won-but-not-claimable", 888, "won")],
            pageInfo: { hasMore: false }
          }
        : {
            tickets: [claimableTicket("claim-new", 12.34)],
            pageInfo: { hasMore: true, nextCursor: "older-claims" }
          };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/tickets/claim-new/claim", async (route) => {
    claimAttempts += 1;
    claimKeys.push(route.request().headers()["idempotency-key"] || "");
    if (claimAttempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      await route.fulfill({ contentType: "application/json", status: 409, body: JSON.stringify({ error: "not_claimable" }) });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ticketId: "claim-new",
        status: "claimed",
        ticketStatus: "paid",
        amountMicroUnits: "12340000",
        currency: "USDC"
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Portfolio" }).click();

  const claimRows = page.locator(".claim-row");
  await expect(claimRows).toHaveCount(2);
  await expect(claimRows).toContainText(["$12.34", "$4.56"]);
  await expect(page.getByText("$999.00")).toHaveCount(0);
  expect(claimableRequests).toContain("older-claims");

  const firstClaim = claimRows.filter({ hasText: "$12.34" }).getByRole("button", { name: "Claim" });
  const actionBox = await firstClaim.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(320);

  await Promise.all([firstClaim.dispatchEvent("click"), firstClaim.dispatchEvent("click")]);
  await expect(page.getByRole("alert")).toContainText("Portfolio is refreshing");
  expect(claimAttempts).toBe(1);

  await firstClaim.click();
  await expect(
    page.getByRole("status").filter({ hasText: "$12.34 moved to your available LEGWORK balance." })
  ).toBeVisible();
  expect(claimAttempts).toBe(2);
  expect(claimKeys[0]).toMatch(/^ticket-claim-/);
  expect(claimKeys[1]).toBe(claimKeys[0]);
});

test("voided claimables are presented as stake refunds instead of wins", async ({ page }) => {
  const refundTicket = {
    ticketId: "refund-ticket",
    quoteId: "quote-refund",
    status: "claimable",
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-02T10:00:00Z",
    stakeUsd: 25,
    operationFeeUsd: 1,
    amountPaidUsd: 26,
    potentialPayoutUsd: 180,
    claimableAmountUsd: 25,
    accountingMode: "house_book_usdc",
    currency: "USDC",
    legs: 2,
    legStatusCounts: { pending: 0, won: 1, lost: 0, voided: 1, disputed: 0 }
  };
  await page.unroute("**/api/tickets");
  await page.unroute("**/api/tickets/claimable**");
  await page.route("**/api/tickets", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ tickets: [refundTicket] }) })
  );
  await page.route("**/api/tickets/claimable**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ tickets: [refundTicket], pageInfo: { hasMore: false } }) })
  );
  await page.route("**/api/tickets/refund-ticket", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...refundTicket,
        purchaseTxHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
        purchaseChainId: 11155111,
        legs: [
          { ticketLegId: "leg-won", status: "won", resolutionState: "resolved_won", question: "First market", outcome: "Yes" },
          { ticketLegId: "leg-void", status: "voided", resolutionState: "resolved_void", question: "Voided market", outcome: "No" }
        ]
      })
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Portfolio" }).click();
  const claimPanel = page.locator(".claim-panel");
  await expect(claimPanel).toContainText("Refund ready · $25.00");
  await expect(claimPanel).toContainText("Stake returned; operation fee is not refunded.");
  await expect(claimPanel.getByRole("button", { name: "Claim refund" })).toBeVisible();

  const recent = page.locator(".account-panel").filter({ hasText: "Recent baskets" });
  await expect(recent).toContainText("$25.00 refund");
  await expect(recent).not.toContainText("$180 potential");
  await expect(page.locator(".ticket-detail-panel")).toContainText("Refund ready");
  await expect(page.locator(".ticket-detail-panel")).toContainText("Voided; the stake portion is refundable.");
  await expect(page.getByText("Resolution resolved void")).toBeHidden();
});

test("portfolio exposes compact explorer links and labels bounded history", async ({ page }) => {
  const confirmingHash = "0x3333333333333333333333333333333333333333333333333333333333333333";
  const releasedHash = "0x4444444444444444444444444444444444444444444444444444444444444444";
  const withdrawalHash = "0x5555555555555555555555555555555555555555555555555555555555555555";
  await page.unroute("**/api/payment-intents");
  await page.unroute("**/api/withdrawals");
  await page.route("**/api/payment-intents", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        paymentIntents: [
          { id: "confirming", quoteId: "q1", status: "submitted", txHash: confirmingHash, chainId: 11155111, amountPaidUsd: 5, potentialPayoutUsd: 12, legs: 2, createdAt: "2026-07-01T10:00:00Z", updatedAt: "2026-07-01T10:01:00Z" },
          { id: "released", quoteId: "q2", status: "recoverable", txHash: releasedHash, chainId: 11155111, amountPaidUsd: 7, potentialPayoutUsd: 20, legs: 3, createdAt: "2026-07-01T10:00:00Z", updatedAt: "2026-07-01T10:01:00Z" }
        ]
      })
    })
  );
  await page.route("**/api/withdrawals", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        withdrawals: [{ id: "withdrawal-sent", status: "sent", chainId: 11155111, destinationAddress: "0x0000000000000000000000000000000000000001", amountUsdc: 4, onchainTxHash: withdrawalHash, createdAt: "2026-07-01T10:00:00Z", updatedAt: "2026-07-01T10:01:00Z" }]
      })
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Portfolio" }).click();
  await expect(page.getByRole("heading", { name: "Recent baskets" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All baskets" })).toHaveCount(0);
  for (const hash of [confirmingHash, releasedHash, withdrawalHash]) {
    await expect(page.locator(`a[href="https://sepolia.etherscan.io/tx/${hash}"]`).first()).toBeVisible();
  }
});

test("recoverable payments are separate from confirming baskets and returned to available balance", async ({ page }) => {
  await page.unroute("**/api/payment-intents");
  await page.route("**/api/payment-intents", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        paymentIntents: [
          {
            id: "payment-intent-recoverable",
            quoteId: "quote-recoverable",
            status: "recoverable",
            txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
            chainId: 11155111,
            amountPaidUsd: 27,
            potentialPayoutUsd: 100,
            legs: 2,
            createdAt: "2026-07-08T00:00:00.000Z",
            updatedAt: "2026-07-08T00:01:00.000Z"
          }
        ]
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Portfolio" }).click();

  const activeBaskets = page.locator(".account-panel").filter({ hasText: "Still in play" });
  await expect(activeBaskets.locator(".panel-count")).toHaveText("0");
  await expect(page.getByRole("heading", { name: "Returned balance" })).toBeVisible();
  await expect(page.getByText("Received USDC was returned to your available LEGWORK balance. Review the withdrawal section for current availability.")).toBeVisible();
  await expect(page.getByText("$27.00 released")).toBeVisible();
  await expect(page.getByText("Confirming", { exact: true })).toHaveCount(0);
});

test("recoverable activation sends the payment modal to Portfolio without retry controls", async ({ page }) => {
  const txHash = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const paymentIntent = {
    id: "payment-intent-recoverable",
    quoteId: "quote-test",
    chainId: 11155111,
    currency: "USDC",
    treasuryAddress: "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B",
    usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    amountMicroUnits: "6000000",
    amountUsdc: 6,
    requiredConfirmations: 2,
    expiresAt: "2027-07-05T15:38:28.638Z"
  };

  await page.unroute("**/api/quotes/*/payment-intent");
  await page.route("**/api/quotes/*/payment-intent", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...paymentIntent, status: "pending" }) });
  });
  await page.route("**/api/quotes/*/payment-transaction", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...paymentIntent, status: "submitted", txHash }) });
  });
  await page.route("**/api/quotes/*/payment-activate", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 409,
      body: JSON.stringify({
        status: "recoverable",
        error: "payment_intent_recoverable",
        reason: "requote_adverse",
        paymentIntent: { ...paymentIntent, status: "recoverable", txHash, recoveryReason: "requote_adverse" }
      })
    });
  });

  await page.goto("/");
  await page.evaluate(async () => {
    const [appModule, reactModule, reactDomClientModule] = await Promise.all([
      import("/src/App.tsx"),
      import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js")
    ]);
    const rootElement = document.getElementById("root")!;
    rootElement.replaceChildren();
    const react = reactModule.default || reactModule;
    const reactDomClient = reactDomClientModule.default || reactDomClientModule;
    reactDomClient.createRoot(rootElement).render(
      react.createElement(appModule.default, {
        auth: {
          enabled: true,
          authenticated: true,
          ready: true,
          walletSynced: true,
          walletSyncStatus: "synced",
          getAccessToken: async () => "test-token",
          sendUsdcPayment: async () => "0x1111111111111111111111111111111111111111111111111111111111111111"
        }
      })
    );
  });

  await page.getByLabel("Set max stake").click();
  await page.getByLabel("Search markets").fill("Up or Down");
  const markets = page.locator(".market-card");
  await markets.nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await markets.nth(1).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.getByRole("button", { name: "Review basket" }).click();
  await page.getByRole("button", { name: "Send USDC" }).click();

  await expect(page.getByText("This basket could not be activated. Received USDC was returned to your available LEGWORK balance. Open Portfolio to review the balance and current withdrawal status.")).toBeVisible();
  await expect(page.getByRole("button", { name: "View Portfolio" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue activation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send USDC" })).toHaveCount(0);
});

test("successful activation ends with a clear live-basket completion state", async ({ page }) => {
  const txHash = "0x6666666666666666666666666666666666666666666666666666666666666666";
  const paymentIntent = {
    id: "payment-intent-live",
    quoteId: "quote-test",
    chainId: 11155111,
    currency: "USDC",
    treasuryAddress: "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B",
    usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    amountMicroUnits: "6000000",
    amountUsdc: 6,
    requiredConfirmations: 2,
    expiresAt: "2027-07-05T15:38:28.638Z"
  };
  await page.unroute("**/api/quotes/*/payment-intent");
  await page.route("**/api/quotes/*/payment-intent", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...paymentIntent, status: "pending" }) })
  );
  await page.route("**/api/quotes/*/payment-transaction", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...paymentIntent, status: "submitted", txHash }) })
  );
  await page.route("**/api/quotes/*/payment-activate", (route) =>
    route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({ ticketId: "ticket-live-1", quoteId: "quote-test", status: "accepted" })
    })
  );
  await page.route("**/api/tickets/ticket-live-1", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ticketId: "ticket-live-1",
        quoteId: "quote-test",
        status: "accepted",
        createdAt: "2026-07-21T10:00:00Z",
        updatedAt: "2026-07-21T10:00:00Z",
        stakeUsd: 25,
        operationFeeUsd: 1,
        amountPaidUsd: 26,
        potentialPayoutUsd: 180,
        accountingMode: "house_book_usdc",
        currency: "USDC",
        legs: []
      })
    })
  );

  await page.goto("/");
  await page.evaluate(async () => {
    const [appModule, reactModule, reactDomClientModule] = await Promise.all([
      import("/src/App.tsx"),
      import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js")
    ]);
    const rootElement = document.getElementById("root")!;
    rootElement.replaceChildren();
    const react = reactModule.default || reactModule;
    const reactDomClient = reactDomClientModule.default || reactDomClientModule;
    reactDomClient.createRoot(rootElement).render(
      react.createElement(appModule.default, {
        auth: {
          enabled: true,
          authenticated: true,
          ready: true,
          walletSynced: true,
          walletSyncStatus: "synced",
          getAccessToken: async () => "test-token",
          sendUsdcPayment: async () => "0x6666666666666666666666666666666666666666666666666666666666666666"
        }
      })
    );
  });

  await page.getByLabel("Set max stake").click();
  await page.getByLabel("Search markets").fill("Up or Down");
  await page.locator(".market-card").nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.locator(".market-card").nth(1).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.getByRole("button", { name: "Review basket" }).click();
  await page.getByRole("button", { name: "Send USDC" }).click();

  const completed = page.getByRole("dialog", { name: "Your basket is live" });
  await expect(completed).toBeVisible();
  await expect(completed).toContainText("Confirmed potential payout");
  await expect(completed.locator(".firework-burst").first()).toBeAttached();
  await completed.getByRole("button", { name: "View live basket" }).click();
  await expect(completed).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your LEGWORK account" })).toBeVisible();
});

test("expired payment intent blocks wallet transfer and offers a fresh quote", async ({ page }) => {
  await page.unroute("**/api/quotes/*/payment-intent");
  await page.route("**/api/quotes/*/payment-intent", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "payment-intent-expiring",
        quoteId: "quote-test",
        chainId: 11155111,
        currency: "USDC",
        treasuryAddress: "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B",
        usdcContractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        amountMicroUnits: "6000000",
        amountUsdc: 6,
        requiredConfirmations: 2,
        status: "pending",
        expiresAt: new Date(Date.now() + 700).toISOString()
      })
    });
  });

  await page.goto("/");
  await page.evaluate(async () => {
    const [appModule, reactModule, reactDomClientModule] = await Promise.all([
      import("/src/App.tsx"),
      import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js")
    ]);
    const rootElement = document.getElementById("root")!;
    rootElement.replaceChildren();
    const react = reactModule.default || reactModule;
    const reactDomClient = reactDomClientModule.default || reactDomClientModule;
    (window as Window & { __sendCalls?: number; __delayAuth?: boolean }).__sendCalls = 0;
    reactDomClient.createRoot(rootElement).render(
      react.createElement(appModule.default, {
        auth: {
          enabled: true,
          authenticated: true,
          ready: true,
          walletSynced: true,
          walletSyncStatus: "synced",
          getAccessToken: async () => {
            if ((window as Window & { __delayAuth?: boolean }).__delayAuth) await new Promise((resolve) => setTimeout(resolve, 900));
            return "test-token";
          },
          sendUsdcPayment: async () => {
            const testWindow = window as Window & { __sendCalls?: number };
            testWindow.__sendCalls = (testWindow.__sendCalls || 0) + 1;
            return "0x1111111111111111111111111111111111111111111111111111111111111111";
          }
        }
      })
    );
  });

  await page.getByLabel("Set max stake").click();
  await page.getByLabel("Search markets").fill("Up or Down");
  await page.locator(".market-card").nth(0).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.locator(".market-card").nth(1).getByRole("button", { name: /^Up\s+\d+¢ for / }).click();
  await page.getByRole("button", { name: "Review basket" }).click();
  const send = page.getByRole("button", { name: "Send USDC" });
  await expect(send).toBeEnabled();
  await expect(page.getByText(/Send within 0:/)).toBeVisible();

  await page.evaluate(() => ((window as Window & { __delayAuth?: boolean }).__delayAuth = true));
  await send.click();
  await expect(page.getByRole("button", { name: "Refresh quote" })).toBeVisible();
  await expect(page.getByText("Quote expired", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __sendCalls?: number }).__sendCalls)).toBe(0);
});

test("withdrawal requests validate exact USDC amounts, use the verified wallet, and report server failures", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const walletAddress = "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B";
  const withdrawalRequests: Array<{ amountUsdc: string; destinationAddress: string; idempotencyKey: string }> = [];
  let accountReads = 0;
  let withdrawalReads = 0;
  let withdrawalCanceled = false;

  await page.unroute("**/api/account");
  await page.unroute("**/api/withdrawals");
  await page.route("**/api/withdrawals/*/cancel", async (route) => {
    withdrawalCanceled = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: "withdrawal-1", status: "canceled", result: "canceled" })
    });
  });
  await page.route("**/api/account", async (route) => {
    accountReads += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        balances: [{ accountType: "user_usdc_available", currency: "USDC", balance: 12.345678 }],
        openTickets: 0,
        openStakeUsd: 0,
        openPotentialPayoutUsd: 0,
        openNetLiabilityUsd: 0
      })
    });
  });
  await page.route("**/api/withdrawals", async (route) => {
    if (route.request().method() === "POST") {
      withdrawalRequests.push({
        ...(route.request().postDataJSON() as { amountUsdc: string; destinationAddress: string }),
        idempotencyKey: route.request().headers()["idempotency-key"] || ""
      });
      if (withdrawalRequests.length === 1) {
        await route.fulfill({ contentType: "application/json", status: 201, body: JSON.stringify({ id: "withdrawal-1", status: "requested" }) });
        return;
      }
      await route.fulfill({ contentType: "application/json", status: 422, body: JSON.stringify({ error: "insufficient_user_balance" }) });
      return;
    }

    withdrawalReads += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        withdrawals:
          withdrawalRequests.length > 0
            ? [
                {
                  id: "withdrawal-1",
                  status: withdrawalCanceled ? "canceled" : "requested",
                  chainId: 11155111,
                  destinationAddress: walletAddress,
                  amountUsdc: 12.345678,
                  createdAt: "2026-07-05T15:35:28.638Z",
                  updatedAt: "2026-07-05T15:35:28.638Z"
                }
              ]
            : []
      })
    });
  });

  await page.goto("/");
  await page.evaluate(async (address) => {
    const [appModule, reactModule, reactDomClientModule] = await Promise.all([
      import("/src/App.tsx"),
      import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js")
    ]);
    const rootElement = document.getElementById("root")!;
    rootElement.replaceChildren();
    const react = reactModule.default || reactModule;
    const reactDomClient = reactDomClientModule.default || reactDomClientModule;
    reactDomClient.createRoot(rootElement).render(
      react.createElement(appModule.default, {
        auth: {
          enabled: true,
          authenticated: true,
          ready: true,
          walletSynced: true,
          walletSyncStatus: "synced",
          walletAddress: address,
          userLabel: "test-wallet",
          getAccessToken: async () => "test-token"
        }
      })
    );
  }, walletAddress);

  await page.getByRole("button", { name: "Portfolio" }).click();
  const amountInput = page.getByLabel("Amount");
  const submit = page.getByRole("button", { name: "Request withdrawal" });

  await expect(page.getByText("0x1d4Fd5...f17B")).toBeVisible();
  await amountInput.fill("12.3456789");
  await expect(page.getByText("Use up to six decimal places.")).toBeVisible();
  await expect(submit).toBeDisabled();

  await amountInput.fill("12.345679");
  await expect(page.getByText("Amount exceeds your available LEGWORK balance.")).toBeVisible();
  await expect(submit).toBeDisabled();

  await page.getByRole("button", { name: "Max" }).click();
  await expect(amountInput).toHaveValue("12.345678");
  await submit.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Treasury processing is pending; funds have not been sent yet." })
  ).toBeVisible();
  expect(withdrawalRequests[0]).toEqual({
    amountUsdc: "12.345678",
    destinationAddress: walletAddress,
    idempotencyKey: expect.stringMatching(/^withdrawal-/)
  });
  await expect.poll(() => accountReads).toBeGreaterThanOrEqual(2);
  await expect.poll(() => withdrawalReads).toBeGreaterThanOrEqual(2);
  const mobileSubmitBox = await submit.boundingBox();
  expect(mobileSubmitBox).not.toBeNull();
  expect(mobileSubmitBox!.x + mobileSubmitBox!.width).toBeLessThanOrEqual(320);

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => withdrawalCanceled).toBe(true);
  await expect(page.getByText("Canceled", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);

  await amountInput.fill("1");
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("available LEGWORK balance changed");
  expect(withdrawalRequests).toHaveLength(2);
  expect(withdrawalRequests[1]?.idempotencyKey).not.toBe(withdrawalRequests[0]?.idempotencyKey);

  await submit.click();
  await expect.poll(() => withdrawalRequests).toHaveLength(3);
  expect(withdrawalRequests[2]?.idempotencyKey).toBe(withdrawalRequests[1]?.idempotencyKey);
});
