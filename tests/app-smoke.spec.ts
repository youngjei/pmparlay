import { expect, test, type Page } from "@playwright/test";

const liveEvents = [
  {
    slug: "world-cup-winner",
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
        stakeUsd: 25,
        operationFeeUsd: 2,
        totalCostUsd: 27,
        basketPrice: 0.125,
        basketProbability: 0.125,
        quoteSpread: 0.1,
        payoutMultiple: 7.2,
        potentialPayoutUsd: 180,
        riskDecision: "accept",
        riskChecks: [],
        legs: []
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

  await page.route("**/api/markets", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        asOf: "2026-07-05T15:35:28.638Z",
        source: "polymarket",
        outcomes: mockApiOutcomes()
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

  await page.getByLabel("Sort markets").selectOption("balanced");
  await expect(page.locator(".market-card").first()).toContainText("Ethereum");
  await page.getByLabel("Sort markets").selectOption("popular");
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
  await expect(page.getByText("Risk engine")).toHaveCount(0);

  const secondMarket = page.locator(".market-card").nth(1);
  await secondMarket.getByRole("button", { name: /Up\s+49¢/ }).click();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeEnabled();
  await page.getByRole("button", { name: "Review basket" }).click();
  await expect(page.getByRole("button", { name: "Accept play quote" })).toBeEnabled();
  await expect(page.getByText(/Server quote quoted/)).toBeVisible();
  await page.getByRole("button", { name: "Accept play quote" }).click();
  await expect(page.getByRole("button", { name: "Ticket saved" })).toBeDisabled();
  await expect(page.getByText(/Play ticket saved/)).toBeVisible();

  await secondMarket.getByRole("button", { name: /Down\s+51¢/ }).click();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeEnabled();

  await page.getByLabel("Add $5").click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("25");
  await page.getByLabel("Set max stake").click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("25");
  await page.getByLabel("Buy amount").fill("999");
  await page.getByLabel("Buy amount").blur();
  await expect(page.getByLabel("Buy amount")).toHaveValue("25");

  await page.getByLabel("Search markets").fill("Argentina");
  await expect(page.locator(".market-card").first()).toContainText(/Argentina/i);
  await page.getByLabel("Search markets").fill("");

  const sportsChip = page.getByRole("group", { name: "Category filters" }).getByRole("button", { name: "Sports", exact: true });
  if ((await sportsChip.count()) > 0) await sportsChip.click();

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Select 2+ markets to price a basket")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
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
        stakeUsd: 25,
        operationFeeUsd: 2,
        totalCostUsd: 27,
        basketPrice: 0.125,
        basketProbability: 0.125,
        quoteSpread: 0.1,
        payoutMultiple: 7.2,
        potentialPayoutUsd: 180,
        riskDecision: "accept",
        riskChecks: [],
        legs: []
      })
    });
  });

  await page.goto("/");
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
    stakeUsd: 25,
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

test("same event winner yes hides other event markets", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Search markets").fill("2026 FIFA World Cup");
  await page.locator(".market-card").filter({ hasText: "Will Morocco win the 2026 FIFA World Cup?" }).getByRole("button", { name: /Yes/ }).click();

  await expect(page.locator(".market-card").filter({ hasText: "Will USA win the 2026 FIFA World Cup?" })).toHaveCount(0);
  await expect(page.locator(".market-card").filter({ hasText: "Will Mexico win the 2026 FIFA World Cup?" })).toHaveCount(0);
  await expect(page.getByText("Yes at 2.8¢")).toBeVisible();
  await expect(page.getByText("No at 98¢")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
});

test("same event winner no hides other event markets", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Search markets").fill("2026 FIFA World Cup");
  await page.locator(".market-card").filter({ hasText: "Will USA win the 2026 FIFA World Cup?" }).getByRole("button", { name: /No/ }).click();

  await expect(page.locator(".market-card").filter({ hasText: "Will Morocco win the 2026 FIFA World Cup?" })).toHaveCount(0);
  await expect(page.locator(".market-card").filter({ hasText: "Will Mexico win the 2026 FIFA World Cup?" })).toHaveCount(0);
  await expect(page.getByText("No at 98¢")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review basket" })).toBeDisabled();
});

test("large upside simple liquid basket is blocked by the closed beta payout cap", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Search markets").fill("USA win");
  await page.locator(".market-card").filter({ hasText: "Will USA win the 2026 FIFA World Cup?" }).getByRole("button", { name: /Yes/ }).click();
  await page.getByLabel("Search markets").fill("Gavin Newsom");
  await page.locator(".market-card").filter({ hasText: "Will Gavin Newsom win the 2028 Democratic presidential nomination?" }).getByRole("button", {
    name: /Yes/
  }).click();

  await expect(page.getByRole("button", { name: "Basket blocked" })).toBeDisabled();
  await expect(page.getByText("Risk engine")).toBeVisible();
  await expect(page.locator(".risk-panel strong", { hasText: "Blocked" })).toBeVisible();
  await expect(page.getByText("Payout cap")).toBeVisible();
  await expect(page.getByText("Manual review")).toHaveCount(0);
  await expect(page.getByText("Review quote")).toHaveCount(0);
});

test("positive-upside favorite basket stays available across buy amounts", async ({ page }) => {
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

  await page.getByLabel("Buy amount").fill("5");
  await page.getByLabel("Buy amount").blur();
  await page.getByRole("button", { name: "Add $10", exact: true }).click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("15");
  await expect(page.getByRole("button", { name: "Review basket" })).toBeEnabled();
  await expect(page.getByText("Unavailable")).toHaveCount(0);

  await page.getByRole("button", { name: "Add $10", exact: true }).click();
  await expect(page.getByLabel("Buy amount")).toHaveValue("25");
  await expect(page.getByRole("button", { name: "Review basket" })).toBeEnabled();
  await expect(page.getByText("Unavailable")).toHaveCount(0);
});
