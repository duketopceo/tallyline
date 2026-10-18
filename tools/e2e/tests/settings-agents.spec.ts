import { expect, request as pwRequest, test } from "@playwright/test";

// U5: create an agent, issue / rotate / revoke keys, create / revoke a PAT,
// entirely through the UI. Plaintext is shown once and never retrievable.

test.use({ permissions: ["clipboard-read", "clipboard-write"] });
test.describe.configure({ mode: "serial" });

const API = `http://localhost:${process.env.E2E_API_PORT ?? "4100"}`;
const AGENT = `e2e-agent-${Date.now().toString(36)}`;

async function whoami(token: string): Promise<number> {
  // bearer alone: the runner's default storageState is the e2e session
  const ctx = await pwRequest.newContext({
    baseURL: API,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  const status = (await ctx.get("/v1/whoami")).status();
  await ctx.dispose();
  return status;
}

test("agents: issue key, rotate (old dies at once), rotate with grace, revoke", async ({
  page,
}) => {
  await page.goto("/settings/agents");
  await expect(page.getByRole("heading", { name: "Agents and keys" })).toBeVisible();

  await page.getByLabel("Name (lowercase, digits, dashes)").fill(AGENT);
  await page.getByLabel("Harness").fill("claude-code");
  await page.getByRole("button", { name: "Create agent" }).click();
  const card = page.getByRole("region", { name: AGENT });
  await expect(card).toBeVisible();

  await card.getByLabel("Key name").fill("laptop");
  await card.getByRole("button", { name: "Issue key" }).click();
  const reveal = card.getByRole("status", { name: "API key created" });
  const key = (await reveal.getByTestId("secret-value").innerText()).trim();
  expect(key).toMatch(/^tly_agt_[\w-]{20,}$/);
  expect(await whoami(key)).toBe(200);
  // expiry is shown: omitting it applies the workspace default
  const row = card.getByRole("row", { name: /laptop/ });
  await expect(row.locator("time").first()).toBeVisible();
  await reveal.getByRole("button", { name: "I have saved it" }).click();

  // rotate, default grace: the old key is dead at once, the new one works
  await card.getByRole("button", { name: "Rotate key laptop" }).click();
  await page.getByRole("dialog", { name: "Rotate key" }).getByRole("button", { name: "Rotate key" }).click();
  const rotated = (await card.getByTestId("secret-value").innerText()).trim();
  expect(rotated).toMatch(/^tly_agt_/);
  expect(rotated).not.toBe(key);
  expect(await whoami(key)).toBe(401);
  expect(await whoami(rotated)).toBe(200);
  await card.getByRole("button", { name: "I have saved it" }).click();
  await page.reload();
  await expect(page.locator("body")).not.toContainText(rotated);

  // rotate with a 1 hour overlap: both work inside the window
  const c2 = page.getByRole("region", { name: AGENT });
  // the rotated-out key stays listed, marked expired; act on a live row
  const live = c2
    .getByRole("row", { name: /laptop/ })
    .filter({ hasNotText: "expired" });
  await expect(live).toHaveCount(1);
  await live.getByRole("button", { name: "Rotate key laptop" }).click();
  const dlg = page.getByRole("dialog", { name: "Rotate key" });
  await dlg.getByLabel("Old key stops working").selectOption("3600");
  await dlg.getByRole("button", { name: "Rotate key" }).click();
  const next = (await c2.getByTestId("secret-value").innerText()).trim();
  expect(await whoami(rotated)).toBe(200);
  expect(await whoami(next)).toBe(200);

  // revoke: cancel keeps it, confirm kills it immediately
  await c2.getByRole("button", { name: "I have saved it" }).click();
  await live.first().getByRole("button", { name: "Revoke key laptop" }).click();
  await page.getByRole("dialog", { name: "Revoke key" }).getByRole("button", { name: "cancel" }).click();
  expect(await whoami(next)).toBe(200);
  const rows = c2.getByRole("row", { name: /laptop/ });
  const before = await rows.count();
  const del = page.waitForResponse(
    (r) => r.request().method() === "DELETE" && r.url().includes("/keys/") && r.ok(),
  );
  await live.first().getByRole("button", { name: "Revoke key laptop" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke key" }).click();
  await del;
  await expect(rows).toHaveCount(before - 1);
});

test("tokens: shown once, revoke", async ({ page }) => {
  await page.goto("/settings/tokens");
  await expect(page.getByRole("heading", { name: "Personal access tokens" })).toBeVisible();
  const name = `e2e-pat-${Date.now().toString(36)}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  const reveal = page.getByRole("status", { name: "token created" });
  const token = (await reveal.getByTestId("secret-value").innerText()).trim();
  expect(token).toMatch(/^tly_/);
  expect(await whoami(token)).toBe(200);
  await reveal.getByRole("button", { name: "I have saved it" }).click();
  await page.reload();
  await expect(page.locator("body")).not.toContainText(token);

  await page.getByRole("button", { name: `Revoke token ${name}` }).click();
  const revoked = page.waitForResponse(
    (r) => r.request().method() === "DELETE" && r.url().includes("/api/settings/tokens/") && r.ok(),
  );
  await page.getByRole("dialog").getByRole("button", { name: "Revoke token" }).click();
  await revoked;
  expect(await whoami(token)).toBe(401);
});

test("settings tabs reach Agents and Tokens", async ({ page }) => {
  await page.goto("/settings/members");
  const nav = page.getByRole("navigation", { name: "Settings" });
  for (const [label, url] of [
    ["Agents", /\/settings\/agents$/],
    ["Tokens", /\/settings\/tokens$/],
  ] as const) {
    await nav.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(url);
    await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  }
});
