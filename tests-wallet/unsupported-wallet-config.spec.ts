import { expect, test } from "@playwright/test";

test("an unsupported payment chain disables wallet actions without blanking market browsing", async ({ page }) => {
  await page.route("**/api/markets**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        asOf: new Date().toISOString(),
        source: "polymarket",
        complete: true,
        outcomes: [],
        pageInfo: { limit: 48, offset: 0, hasMore: false, total: 0 }
      })
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toHaveCount(0);
});
