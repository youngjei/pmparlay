import { expect, test, type Page } from "@playwright/test";

type TestMarket = {
  id: string;
  question: string;
  category?: string;
  eventGroupKey?: string;
  eventTitle?: string;
  eventSlug?: string;
  marketUrl?: string;
  image?: string;
  volume?: number;
  endDate?: string;
  yesPrice?: number;
};

type MarketRouteResult = {
  payload: unknown;
  status?: number;
  delayMs?: number;
};

function marketRouteResult(payload: unknown, options: Omit<MarketRouteResult, "payload"> = {}): MarketRouteResult {
  return { payload, ...options };
}

function isMarketRouteResult(value: unknown): value is MarketRouteResult {
  return Boolean(value && typeof value === "object" && "payload" in value);
}

function marketOutcomes(input: TestMarket) {
  const yesPrice = input.yesPrice ?? 0.42;
  const noPrice = Math.round((1 - yesPrice) * 100) / 100;
  const category = input.category || "Sports";
  const endDate = input.endDate || "2027-07-20T22:00:00Z";
  const volume = input.volume ?? 1_000_000;
  const marketUrl = input.marketUrl || `https://polymarket.com/event/${input.eventSlug || input.id}`;
  const base = {
    marketId: input.id,
    conditionId: `${input.id}-condition`,
    question: input.question,
    marketUrl,
    image: input.image || `https://example.com/${input.id}.png`,
    icon: input.image || `https://example.com/${input.id}.png`,
    category,
    endDate,
    liquidity: volume,
    volume,
    source: "polymarket",
    eventGroupKey: input.eventGroupKey,
    eventTitle: input.eventTitle,
    eventSlug: input.eventSlug
  };

  return [
    {
      ...base,
      id: `${input.id}-yes`,
      tokenId: `${input.id}-yes-token`,
      outcome: "Yes",
      price: yesPrice
    },
    {
      ...base,
      id: `${input.id}-no`,
      tokenId: `${input.id}-no-token`,
      outcome: "No",
      price: noPrice
    }
  ];
}

function catalog(markets: TestMarket[], total = markets.length, hasMore = false, nextCursor?: string) {
  return {
    asOf: new Date().toISOString(),
    source: "polymarket",
    complete: true,
    totalFeeds: 1,
    successfulFeeds: 1,
    outcomes: markets.flatMap((market) => marketOutcomes(market)),
    pageInfo: {
      limit: 48,
      offset: 0,
      hasMore,
      nextCursor,
      total
    }
  };
}

function generatedMarkets(count: number, prefix: string, category = "Sports", start = 1): TestMarket[] {
  return Array.from({ length: count }, (_, index) => {
    const number = start + index;
    return {
      id: `${prefix}-${number}`,
      question: `Will ${prefix} market ${number} resolve yes?`,
      category,
      volume: 1_000_000 - index * 1000,
      yesPrice: 0.35 + (index % 10) / 100
    };
  });
}

async function routeMarkets(
  page: Page,
  resolver: (url: URL, requestNumber: number) => unknown | Promise<unknown>
) {
  let requestNumber = 0;
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
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tickets: [], pageInfo: { hasMore: false } }) });
  });
  await page.route("**/api/withdrawals", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ withdrawals: [] }) });
  });
  await page.route("**/api/payment-intents", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ paymentIntents: [] }) });
  });
  await page.route("**/api/markets**", async (route) => {
    requestNumber += 1;
    const url = new URL(route.request().url());
    const resolved = await resolver(url, requestNumber);
    const result = isMarketRouteResult(resolved) ? resolved : marketRouteResult(resolved);
    if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    await route
      .fulfill({
        ...(result.status ? { status: result.status } : {}),
        contentType: "application/json",
        body: JSON.stringify(result.payload)
      })
      .catch(() => undefined);
  });
}

function groupedWorldCupMarkets(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const team = `Team ${index + 1}`;
    return {
      id: `world-cup-${index + 1}`,
      question: `Will ${team} win the 2026 FIFA World Cup?`,
      category: "Sports",
      eventGroupKey: "polymarket:event:world-cup-winner",
      eventTitle: "2026 FIFA World Cup Winner",
      eventSlug: "world-cup-winner",
      marketUrl: "https://polymarket.com/event/world-cup-winner",
      volume: 10_000_000 - index * 100_000,
      yesPrice: 0.2 + index / 100
    };
  });
}

test("market catalog loads 48 per page and resets on search, category, and sort", async ({ page }) => {
  const firstPage = generatedMarkets(48, "page-one", "Sports");
  const secondPage = generatedMarkets(7, "page-two", "Sports", 49);
  const searchPage = generatedMarkets(3, "special", "Politics");
  const sportsPage = generatedMarkets(2, "sports-reset", "Sports");
  const sortedPage = generatedMarkets(1, "sorted-reset", "Sports");

  await routeMarkets(page, (url) => {
    if (url.searchParams.get("cursor") === "page-2") return catalog(secondPage, 55, false);
    if (url.searchParams.get("search")) return catalog(searchPage, 3, false);
    if (url.searchParams.get("sort") === "ending_soon") return catalog(sortedPage, 1, false);
    if (url.searchParams.get("category")) return catalog(sportsPage, 2, false);
    return catalog(firstPage, 55, true, "page-2");
  });

  await page.goto("/");

  await expect(page.locator(".market-count")).toContainText("48/55 loaded");
  await expect(page.locator(".market-card")).toHaveCount(48);

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".market-count")).toContainText("55/55 loaded");
  await expect(page.locator(".market-card")).toHaveCount(55);

  await page.getByLabel("Search markets").fill("special");
  await expect(page.locator(".market-count")).toContainText("3/3 loaded");
  await expect(page.locator(".market-card")).toHaveCount(3);
  await expect(page.getByText("page-one market")).toHaveCount(0);

  await page.getByLabel("Search markets").fill("");
  await expect(page.locator(".market-count")).toContainText("48/55 loaded");

  await page.getByRole("group", { name: "Category filters" }).getByRole("button", { name: "Sports", exact: true }).click();
  await expect(page.locator(".market-count")).toContainText("2/2 loaded");

  await page.getByLabel("Sort markets").selectOption("ending_soon");
  await expect(page.locator(".market-count")).toContainText("1/1 loaded");
  await expect(page.locator(".market-card")).toContainText("sorted-reset market");
});

test("revisiting a category restores cached markets while revalidating", async ({ page }) => {
  const allMarkets = generatedMarkets(1, "all", "Politics");
  const firstSports = generatedMarkets(1, "sports-cached", "Sports");
  const refreshedSports = generatedMarkets(1, "sports-refreshed", "Sports");
  const cryptoMarkets = generatedMarkets(1, "crypto", "Crypto");
  let sportsRequests = 0;

  await routeMarkets(page, (url) => {
    const category = url.searchParams.get("category");
    if (category === "Sports") {
      sportsRequests += 1;
      return sportsRequests === 1
        ? catalog(firstSports)
        : marketRouteResult(catalog(refreshedSports), { delayMs: 800 });
    }
    if (category === "Crypto") return catalog(cryptoMarkets);
    return catalog(allMarkets);
  });

  await page.goto("/");
  const filters = page.getByRole("group", { name: "Category filters" });
  await filters.getByRole("button", { name: "Sports", exact: true }).click();
  await expect(page.getByText("sports-cached market 1")).toBeVisible();

  await filters.getByRole("button", { name: "Crypto", exact: true }).click();
  await expect(page.getByText("crypto market 1")).toBeVisible();

  await filters.getByRole("button", { name: "Sports", exact: true }).click();
  await expect(page.getByText("sports-cached market 1")).toBeVisible({ timeout: 250 });
  await expect(page.getByText("sports-refreshed market 1")).toBeVisible({ timeout: 1_500 });
  await expect(page.getByText("sports-cached market 1")).toHaveCount(0);
});

test("cached markets remain usable when background revalidation fails", async ({ page }) => {
  const allMarkets = generatedMarkets(1, "all", "Politics");
  const sportsMarkets = generatedMarkets(1, "sports-saved", "Sports");
  const cryptoMarkets = generatedMarkets(1, "crypto", "Crypto");
  let sportsRequests = 0;

  await routeMarkets(page, (url) => {
    const category = url.searchParams.get("category");
    if (category === "Sports") {
      sportsRequests += 1;
      return sportsRequests === 1
        ? catalog(sportsMarkets)
        : marketRouteResult({ error: "market_catalog_unavailable" }, { status: 503, delayMs: 300 });
    }
    if (category === "Crypto") return catalog(cryptoMarkets);
    return catalog(allMarkets);
  });

  await page.goto("/");
  const filters = page.getByRole("group", { name: "Category filters" });
  await filters.getByRole("button", { name: "Sports", exact: true }).click();
  await expect(page.getByText("sports-saved market 1")).toBeVisible();
  await filters.getByRole("button", { name: "Crypto", exact: true }).click();
  await expect(page.getByText("crypto market 1")).toBeVisible();
  await filters.getByRole("button", { name: "Sports", exact: true }).click();

  await expect(page.getByText("sports-saved market 1")).toBeVisible({ timeout: 250 });
  await expect(page.getByText("Market catalog notice")).toBeVisible({ timeout: 1_000 });
  await expect(page.getByText("sports-saved market 1")).toBeVisible();
});

test("a selected cached leg adopts the revalidated market price", async ({ page }) => {
  const allMarkets = generatedMarkets(1, "all", "Politics");
  const sportsMarket = [{ ...generatedMarkets(1, "sports-reprice", "Sports")[0], yesPrice: 0.4 }];
  const repricedSportsMarket = [{ ...sportsMarket[0], yesPrice: 0.6 }];
  const cryptoMarkets = generatedMarkets(1, "crypto", "Crypto");
  let sportsRequests = 0;

  await routeMarkets(page, (url) => {
    const category = url.searchParams.get("category");
    if (category === "Sports") {
      sportsRequests += 1;
      return sportsRequests === 1
        ? catalog(sportsMarket)
        : marketRouteResult(catalog(repricedSportsMarket), { delayMs: 500 });
    }
    if (category === "Crypto") return catalog(cryptoMarkets);
    return catalog(allMarkets);
  });

  await page.goto("/");
  const filters = page.getByRole("group", { name: "Category filters" });
  await filters.getByRole("button", { name: "Sports", exact: true }).click();
  await page.getByRole("button", { name: /^Yes\s+40¢ for / }).click();
  await expect(page.locator(".ticket-pane .leg-row")).toContainText("Yes at 40¢");
  await filters.getByRole("button", { name: "Crypto", exact: true }).click();
  await expect(page.getByText("crypto market 1")).toBeVisible();
  await filters.getByRole("button", { name: "Sports", exact: true }).click();

  await expect(page.locator(".ticket-pane .leg-row")).toContainText("Yes at 40¢", { timeout: 250 });
  await expect(page.locator(".ticket-pane .leg-row")).toContainText("Yes at 60¢", { timeout: 1_000 });
});

test("No prices remain red before and after selection", async ({ page }) => {
  await routeMarkets(page, () => catalog(generatedMarkets(1, "no-color", "Sports")));
  await page.goto("/");

  const noButton = page.getByRole("button", { name: /^No\s+\d+¢ for / });
  const noPrice = noButton.locator("strong");
  await expect(noPrice).toHaveCSS("color", "rgb(184, 57, 57)");
  await noButton.click();
  await expect(noButton).toHaveAttribute("aria-pressed", "true");
  await expect(noPrice).toHaveCSS("color", "rgb(255, 119, 112)");
});

test("a delayed append cannot overwrite a newer search generation", async ({ page }) => {
  const firstPage = generatedMarkets(48, "initial", "Sports");
  const delayedPage = generatedMarkets(1, "stale-append", "Sports", 49);
  const searchPage = generatedMarkets(1, "fresh-search", "Politics");

  await routeMarkets(page, (url) => {
    if (url.searchParams.get("cursor") === "old-page-2") {
      return marketRouteResult(catalog(delayedPage, 49, false), { delayMs: 850 });
    }
    if (url.searchParams.get("search") === "fresh") return catalog(searchPage, 1, false);
    return catalog(firstPage, 49, true, "old-page-2");
  });

  await page.goto("/");
  await expect(page.locator(".market-count")).toContainText("48/49 loaded");
  await page.getByRole("button", { name: "Load more" }).click();
  await page.getByLabel("Search markets").fill("fresh");

  await expect(page.locator(".market-count")).toContainText("1/1 loaded");
  await expect(page.getByText("fresh-search market 1")).toBeVisible();
  await page.waitForTimeout(950);
  await expect(page.getByText("stale-append market 49")).toHaveCount(0);
  await expect(page.locator(".market-count")).toContainText("1/1 loaded");
});

test("duplicate pagination cursors stop loading and expose a catalog retry", async ({ page }) => {
  const firstPage = generatedMarkets(1, "duplicate-first", "Sports");
  const repeatedPage = generatedMarkets(1, "duplicate-second", "Sports", 2);

  await routeMarkets(page, (url) => {
    if (url.searchParams.get("cursor") === "repeat-cursor") {
      return catalog(repeatedPage, 3, true, "repeat-cursor");
    }
    return catalog(firstPage, 3, true, "repeat-cursor");
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Load more" }).click();

  const issue = page.locator(".pagination-error");
  await expect(issue).toContainText("cursor that was already used");
  await expect(issue.getByRole("button", { name: "Retry catalog" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(page.locator(".market-count")).toContainText("2/3 loaded");

  await issue.getByRole("button", { name: "Retry catalog" }).click();
  await expect(page.locator(".market-count")).toContainText("1/3 loaded");
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});

test("malformed pagination without a next cursor stops loading and retries the catalog", async ({ page }) => {
  const firstPage = generatedMarkets(1, "malformed-cursor", "Sports");
  let recovered = false;

  await routeMarkets(page, () => (recovered ? catalog(firstPage, 1, false) : catalog(firstPage, 2, true)));

  await page.goto("/");

  const issue = page.locator(".pagination-error");
  await expect(issue).toContainText("missing its next cursor");
  await expect(issue.getByRole("button", { name: "Retry catalog" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  recovered = true;
  await issue.getByRole("button", { name: "Retry catalog" }).click();
  await expect(issue).toHaveCount(0);
  await expect(page.locator(".market-count")).toContainText("1/1 loaded");
});

test("an empty completed catalog is a clean no-results state", async ({ page }) => {
  await routeMarkets(page, () => catalog([], 0, false));
  await page.goto("/");

  const emptyState = page.locator(".empty-market-state");
  await expect(emptyState).toContainText("No live markets");
  await expect(emptyState).toContainText("No markets are available right now.");
  await expect(emptyState.getByRole("button", { name: "Retry markets" })).toHaveCount(0);
});

test("an append error keeps loaded markets and retries the failed cursor", async ({ page }) => {
  const firstPage = generatedMarkets(1, "retry-first", "Sports");
  const secondPage = generatedMarkets(1, "retry-second", "Sports", 2);
  let appendAttempts = 0;
  await page.route("https://gamma-api.polymarket.com/**", (route) => route.abort());

  await routeMarkets(page, (url) => {
    if (url.searchParams.get("cursor") === "retry-page-2") {
      appendAttempts += 1;
      if (appendAttempts === 1) return marketRouteResult({ error: "temporarily_unavailable" }, { status: 503 });
      return catalog(secondPage, 2, false);
    }
    return catalog(firstPage, 2, true, "retry-page-2");
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Load more" }).click();

  const issue = page.locator(".pagination-error");
  await expect(issue).toContainText("markets already loaded are still available");
  await expect(page.getByText("retry-first market 1")).toBeVisible();
  await issue.getByRole("button", { name: "Retry load more" }).click();

  await expect(page.locator(".market-count")).toContainText("2/2 loaded");
  await expect(page.getByText("retry-second market 2")).toBeVisible();
  await expect(issue).toHaveCount(0);
});

test("catalog resets preserve the current basket selection", async ({ page }) => {
  const sportsMarket = generatedMarkets(1, "selected-sports", "Sports")[0];
  const cryptoMarket = generatedMarkets(1, "filtered-crypto", "Crypto")[0];

  await routeMarkets(page, (url) => {
    if (url.searchParams.get("category") === "Crypto" || url.searchParams.get("search")) {
      return catalog([cryptoMarket], 1, false);
    }
    return catalog([sportsMarket, cryptoMarket], 2, false);
  });

  await page.goto("/");
  await page.locator(".market-card").filter({ hasText: "selected-sports market 1" }).getByRole("button", { name: /Yes/ }).click();
  await expect(page.locator(".leg-list .leg-row")).toHaveCount(1);

  await page.getByRole("group", { name: "Category filters" }).getByRole("button", { name: "Crypto", exact: true }).click();
  await expect(page.locator(".market-count")).toContainText("1/1 loaded");
  await expect(page.locator(".leg-list .leg-row")).toContainText("selected-sports market 1");

  await page.getByLabel("Search markets").fill("filtered");
  await expect(page.locator(".market-count")).toContainText("1/1 loaded");
  await expect(page.locator(".leg-list .leg-row")).toHaveCount(1);
});

test("market and sibling source links preserve their exact Polymarket hrefs", async ({ page }) => {
  const singleHref = "https://polymarket.com/event/solo-source?tid=solo-token";
  const siblingHref = "https://polymarket.com/event/group-source?market=second";
  const grouped = [
    {
      ...groupedWorldCupMarkets(1)[0],
      marketUrl: "https://polymarket.com/event/group-source?market=first"
    },
    {
      ...groupedWorldCupMarkets(2)[1],
      marketUrl: siblingHref
    }
  ];

  await routeMarkets(page, () =>
    catalog([
      { id: "solo-source", question: "Will the source link stay exact?", category: "Crypto", marketUrl: singleHref },
      ...grouped
    ])
  );
  await page.goto("/");

  const single = page.locator(".market-card").filter({ hasText: "Will the source link stay exact?" });
  await expect(single.getByRole("link", { name: "Open on Polymarket" })).toHaveAttribute("href", singleHref);

  const event = page.locator(".event-card").filter({ hasText: "2026 FIFA World Cup Winner" });
  const toggle = event.getByRole("button", { name: /Expand 2026 FIFA World Cup Winner/ });
  const controlledId = await toggle.getAttribute("aria-controls");
  expect(controlledId).toBeTruthy();
  await toggle.click();
  await expect(event.locator(`#${controlledId}`)).toBeVisible();
  const second = event.locator(".event-sibling-row").filter({ hasText: "Will Team 2 win" });
  await expect(second.getByRole("link", { name: "Open on Polymarket" })).toHaveAttribute("href", siblingHref);
});

test("multi-market events collapse after a pick and permit replacement after reopening", async ({ page }) => {
  await routeMarkets(page, () => catalog([...groupedWorldCupMarkets(10), ...generatedMarkets(1, "solo", "Crypto")], 11, false));
  await page.goto("/");

  const event = page.locator(".event-card").filter({ hasText: "2026 FIFA World Cup Winner" });
  await expect(event).toContainText("10 markets");
  await expect(page.getByText("Will Team 1 win the 2026 FIFA World Cup?")).toHaveCount(0);

  await event.getByRole("button", { name: /Expand 2026 FIFA World Cup Winner/ }).click();
  await expect(event.locator(".event-sibling-row")).toHaveCount(8);
  await expect(event.getByRole("button", { name: "Show more" })).toBeVisible();

  await event.getByRole("button", { name: "Show more" }).click();
  await expect(event.locator(".event-sibling-row")).toHaveCount(10);

  const teamOne = event.locator(".event-sibling-row").filter({ hasText: "Will Team 1 win the 2026 FIFA World Cup?" });
  const teamTwo = event.locator(".event-sibling-row").filter({ hasText: "Will Team 2 win the 2026 FIFA World Cup?" });
  await teamOne.getByRole("button", { name: /Yes\s+20¢/ }).click();
  await expect(page.locator(".leg-list .leg-row")).toHaveCount(1);
  await expect(page.locator(".leg-list")).toContainText("Yes at 20¢");
  await expect(event.locator(".event-selected-summary")).toContainText("Will Team 1 win the 2026 FIFA World Cup? · Yes · 20¢");

  await event.getByRole("button", { name: /Expand 2026 FIFA World Cup Winner/ }).click();
  await expect(teamTwo).toBeVisible();
  await teamTwo.getByRole("button", { name: /No\s+79¢/ }).click();
  await expect(page.locator(".leg-list .leg-row")).toHaveCount(1);
  await expect(page.locator(".leg-list")).toContainText("No at 79¢");
  await expect(page.locator(".leg-list")).not.toContainText("Yes at 20¢");
  await expect(page.locator(".selection-toast")).toContainText("Replaced");
  await expect(event.locator(".event-sibling-row")).toHaveCount(0);
});

test("canonical market categories are always available", async ({ page }) => {
  await routeMarkets(page, () =>
    catalog([
      { id: "economics", question: "Will rates fall?", category: "Economics" },
      { id: "weather", question: "Will the storm make landfall?", category: "Weather" }
    ])
  );
  await page.goto("/");

  const filters = page.getByRole("group", { name: "Category filters" });
  for (const category of [
    "All",
    "Politics",
    "Sports",
    "Crypto",
    "Finance and Economy",
    "Technology and Science",
    "Culture and Entertainment",
    "World and Weather",
    "Other"
  ]) {
    await expect(filters.getByRole("button", { name: category, exact: true })).toBeVisible();
  }
  await expect(filters.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await filters.getByRole("button", { name: "Sports", exact: true }).click();
  await expect(filters.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(filters.getByRole("button", { name: "Sports", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("payment review is a modal dialog that traps focus and restores checkout focus", async ({ page }) => {
  await routeMarkets(page, () => catalog(generatedMarkets(2, "payment-review", "Sports"), 2, false));
  await page.route("**/api/quotes**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/quotes") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "quote-payment-review",
          status: "quoted",
          expiresAt: "2027-07-20T22:00:00Z",
          riskDecision: "accept",
          potentialPayoutUsd: 10
        })
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "payment-review-intent",
        quoteId: "quote-payment-review",
        chainId: 137,
        currency: "USDC",
        treasuryAddress: "0x0000000000000000000000000000000000000001",
        usdcContractAddress: "0x0000000000000000000000000000000000000002",
        amountMicroUnits: "5500000",
        amountUsdc: 5.5,
        requiredConfirmations: 1,
        status: "pending",
        expiresAt: "2027-07-20T22:00:00Z"
      })
    });
  });

  await page.goto("/");
  await page.getByLabel("Buy amount").fill("5");
  await page.locator(".market-card").filter({ hasText: "payment-review market 1" }).getByRole("button", { name: /Yes/ }).click();
  await page.locator(".market-card").filter({ hasText: "payment-review market 2" }).getByRole("button", { name: /Yes/ }).click();

  const checkout = page.locator(".ticket-pane").getByRole("button", { name: "Review basket" });
  await checkout.focus();
  await checkout.click();

  const dialog = page.getByRole("dialog", { name: "Buy this basket" });
  const close = dialog.getByRole("button", { name: "Close payment review" });
  const send = dialog.getByRole("button", { name: "Send USDC" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(close).toBeFocused();
  await expect(page.locator(".app-background")).toHaveAttribute("inert", "");
  await expect(page.locator(".app-background")).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => page.locator("body").evaluate((body) => body.style.overflow)).toBe("hidden");
  await expect(send).toBeDisabled();

  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(checkout).toBeFocused();
  await expect(page.locator(".app-background")).not.toHaveAttribute("inert", "");
  await expect.poll(() => page.locator("body").evaluate((body) => body.style.overflow)).toBe("");
});

test("LEGWORK API failure does not call direct Polymarket endpoints without explicit development opt-in", async ({ page }) => {
  let gammaCalls = 0;
  let clobCalls = 0;
  await page.route("https://gamma-api.polymarket.com/**", async (route) => {
    gammaCalls += 1;
    await route.abort();
  });
  await page.route("https://clob.polymarket.com/**", async (route) => {
    clobCalls += 1;
    await route.abort();
  });
  await routeMarkets(page, () => marketRouteResult({ error: "temporarily_unavailable" }, { status: 503 }));

  await page.goto("/");

  await expect(page.locator(".empty-market-state")).toContainText("LEGWORK API unavailable");
  expect(gammaCalls).toBe(0);
  expect(clobCalls).toBe(0);
});

test("mobile event expansion shows five siblings and basket sheet remains sticky", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await routeMarkets(page, () => catalog([...groupedWorldCupMarkets(7), ...generatedMarkets(1, "bitcoin", "Crypto")], 8, false));
  await page.goto("/");

  const event = page.locator(".event-card").filter({ hasText: "2026 FIFA World Cup Winner" });
  await event.getByRole("button", { name: /Expand 2026 FIFA World Cup Winner/ }).click();
  await expect(event.locator(".event-sibling-row")).toHaveCount(5);
  await expect(event.getByRole("button", { name: "Show more" })).toBeVisible();

  await event.locator(".event-sibling-row").filter({ hasText: "Will Team 1 win" }).getByRole("button", { name: /Yes/ }).click();
  await page.locator(".market-card").filter({ hasText: "bitcoin market 1" }).getByRole("button", { name: /Yes/ }).click();
  await expect(page.locator(".mobile-basket-bar")).toBeVisible();

  await page.locator(".mobile-basket-bar").click();
  await expect(page.getByRole("dialog", { name: "Basket" })).toBeVisible();
  await expect(page.locator(".mobile-leg-list .leg-row")).toHaveCount(2);
});

test("mobile basket traps focus, closes on Escape, and restores its trigger", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await routeMarkets(page, () => catalog(generatedMarkets(1, "focus", "Sports"), 1, false));
  await page.goto("/");

  const trigger = page.locator(".mobile-basket-bar");
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Basket" });
  const close = dialog.getByRole("button", { name: "Collapse basket" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(close).toBeFocused();
  await expect(page.locator(".app-background")).toHaveAttribute("inert", "");
  await expect(page.locator(".app-background")).toHaveAttribute("aria-hidden", "true");

  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator(".app-background")).not.toHaveAttribute("inert", "");
});
