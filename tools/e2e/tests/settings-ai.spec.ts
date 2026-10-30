import { expect, test } from "@playwright/test";

// S3-U3: Settings > AI. The e2e server runs without AUTH_SECRET_KEY, so the
// connect button must explain why it can't store a key instead of failing
// silently, and nothing ever navigates to openrouter.ai from CI.

test("Settings > AI shows the provider, the connect button and the endpoint form", async ({ page }) => {
  await page.route("https://openrouter.ai/**", (route) => route.abort());
  await page.goto("/settings/ai");
  await expect(page.getByRole("heading", { name: "AI", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current provider" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Use another endpoint" })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: false })).toHaveAttribute("type", "password");
  const connect = page.getByRole("button", { name: /Connect OpenRouter|Reconnect OpenRouter/ });
  await connect.click();
  await expect(page.getByRole("alert").filter({ hasText: /AUTH_SECRET_KEY|secret/i })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/ai$/);
});

test("the OpenRouter callback without a code says what to do next", async ({ page }) => {
  await page.goto("/settings/ai/openrouter");
  await expect(page.getByRole("alert").filter({ hasText: "OpenRouter isn't connected" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to AI settings" })).toBeVisible();
});

test("a tampered callback state is refused and nothing is connected", async ({ page }) => {
  await page.goto("/settings/ai/openrouter?code=e2e-code&state=not-a-real-state");
  await expect(page.getByRole("alert").filter({ hasText: "OpenRouter isn't connected" })).toBeVisible();
});
