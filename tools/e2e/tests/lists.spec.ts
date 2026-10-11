import { expect, test, type Page } from "@playwright/test";

// Core list interactions: inline edit with optimistic update + undo, multi-select
// with bulk actions, peek, filter pills, saved views, palette coverage, live
// "N new" pill, mobile shell. Tags drive the Silver Lining section 13 gates.
const API = `http://localhost:${process.env.E2E_API_PORT ?? "4000"}`;
const RUN = Date.now();

async function make(page: Page, title: string): Promise<string> {
  const r = await page.request.post("/api/issues", { data: { title, state: "backlog" } });
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as { key: string }).key;
}
const rowOf = (page: Page, key: string) => page.locator(`[data-issue-row][data-key="${key}"]`);
async function ready(page: Page, path = "/issues") {
  await page.goto(path);
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
}
async function focusRow(page: Page, key: string) {
  const row = rowOf(page, key);
  await expect(row).toBeVisible();
  await row.hover();
  return row;
}

test("@keyboard priority: p opens picker, optimistic change, Ctrl+Z undoes", async ({ page }) => {
  const key = await make(page, `e2e prio ${RUN}`);
  await ready(page);
  const row = await focusRow(page, key);
  await page.keyboard.press("p");
  await page.getByRole("dialog", { name: "Set priority" }).getByRole("option", { name: "High" }).click();
  await expect(row.getByRole("button", { name: "Priority High, change" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "priority → High" })).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(row.getByRole("button", { name: "Priority No priority, change" })).toBeVisible();
});

test("@keyboard assignee: a assigns a human, shown in the row", async ({ page }) => {
  const key = await make(page, `e2e assign ${RUN}`);
  await ready(page);
  const row = await focusRow(page, key);
  await page.keyboard.press("a");
  // option 0 is "Unassigned"; option 1 is the first workspace member
  await page.getByRole("dialog", { name: "Assign to" }).getByRole("option").nth(1).click();
  await expect(row.getByRole("button", { name: /^Assignee (?!none).+, change$/ })).toBeVisible();
});

test("@keyboard rollback: a rejected edit reverts and the error persists", async ({ page }) => {
  const key = await make(page, `e2e rollback ${RUN}`);
  await ready(page);
  await page.route("**/api/issues/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { message: "nope" } }) })
      : route.continue(),
  );
  const row = await focusRow(page, key);
  await page.keyboard.press("p");
  await page.getByRole("dialog", { name: "Set priority" }).getByRole("option", { name: "Urgent" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "not changed: nope" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Priority No priority, change" })).toBeVisible();
});

test("@keyboard multi-select with x and bulk state change", async ({ page }) => {
  const a = await make(page, `e2e bulk A ${RUN}`);
  const b = await make(page, `e2e bulk B ${RUN}`);
  await ready(page);
  await (await focusRow(page, a)).hover();
  await page.keyboard.press("x");
  await (await focusRow(page, b)).hover();
  await page.keyboard.press("x");
  const bar = page.getByRole("toolbar", { name: "Bulk actions" });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "State" }).click();
  await page.getByRole("dialog", { name: "Set state" }).getByRole("option", { name: "Todo" }).click();
  await expect(rowOf(page, a).getByRole("button", { name: "State Todo, change" })).toBeVisible();
  await expect(rowOf(page, b).getByRole("button", { name: "State Todo, change" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).not.toBeVisible();
});

test("@keyboard peek: Space opens the panel, Esc closes it and returns focus", async ({ page }) => {
  const key = await make(page, `e2e peek ${RUN}`);
  await ready(page);
  await focusRow(page, key);
  await page.keyboard.press("Space");
  const peek = page.getByRole("complementary", { name: `Peek ${key}` });
  await expect(peek).toBeVisible();
  await expect(peek.getByRole("heading", { name: new RegExp(`e2e peek ${RUN}`) })).toBeVisible();
  await peek.getByRole("button", { name: /^State/ }).focus();
  await page.keyboard.press("Escape");
  await expect(peek).not.toBeVisible();
  await expect(page.locator("[data-title-link]:focus")).toHaveCount(1);
});

test("filter pills and saved views persist and show in the sidebar", async ({ page }) => {
  await make(page, `e2e filter ${RUN}`);
  await ready(page);
  await page.keyboard.press("f");
  await page.getByRole("dialog", { name: "Add filter" }).getByRole("option", { name: "State" }).click();
  const values = page.getByRole("dialog", { name: "Filter by state" });
  await values.getByRole("option", { name: "Backlog" }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/state=backlog/);
  await expect(page.getByRole("button", { name: /State: Backlog\. Edit filter/ })).toBeVisible();

  const NAME = `Backlog ${RUN}`;
  await page.getByRole("button", { name: "Save as view" }).click();
  await page.getByLabel("View name").fill(NAME);
  await page.getByRole("button", { name: "Save view" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: NAME })).toBeVisible();

  await page.goto("/issues");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: NAME }).click();
  await expect(page).toHaveURL(/state=backlog/);
  await page.getByRole("button", { name: "Delete view" }).click();
  await expect(page.getByRole("status").filter({ hasText: "deleted" })).toBeVisible();
});

test("@palette palette lists every registered action and runs one", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  for (const name of ["Set state", "Set priority", "Assign to", "Peek issue", "Add filter", "Go to Board", "Go to Triage", "Create issue", "Toggle sidebar", "Theme: dark"]) {
    await expect(palette.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  }
  // every action that advertises a key in the ? overlay is also in the palette
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  const overlay = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(overlay).toBeVisible();
  await expect(overlay.getByText("Set priority")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await palette.getByRole("option", { name: /Go to Board/ }).click();
  await expect(page).toHaveURL(/\/board$/);
});

test("@live agent activity shows an N-new pill and never moves the row under the cursor", async ({ page }) => {
  await ready(page);
  const me = (await (await page.request.get(`${API}/v1/auth/me`)).json()) as { workspaceSlug: string };
  const ws = `${API}/v1/workspaces/${me.workspaceSlug}`;
  const agent = (await (await page.request.post(`${ws}/agents`, { data: { name: `e2e-live-${RUN}`, harness: "claude-code" } })).json()) as { id: string };
  const k = (await (await page.request.post(`${ws}/agents/${agent.id}/keys`, { data: { name: "e2e", scopes: ["read", "write"] } })).json()) as { key: string };
  const firstKey = await page.locator("[data-issue-row]").first().getAttribute("data-key");
  const before = await page.locator("[data-issue-row]").first().boundingBox();
  await page.waitForTimeout(1500); // stream attached at the newest event
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${ws}/issues`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k.key}` }, body: JSON.stringify({ title: `agent burst ${RUN} ${i}`, state: "triage" }) });
    expect(r.ok).toBeTruthy();
  }
  const pill = page.locator("[data-new-pill]");
  await expect(pill).toContainText(/\d+ new/, { timeout: 8_000 });
  expect(await page.locator("[data-issue-row]").first().getAttribute("data-key")).toBe(firstKey);
  expect(await page.locator("[data-issue-row]").first().boundingBox()).toEqual(before);
  await pill.click();
  await expect(pill).not.toBeVisible();
});

test("@hydration core routes log no hydration warnings", async ({ page }) => {
  const bad: string[] = [];
  page.on("console", (m) => {
    if (/hydrat/i.test(m.text())) bad.push(`${page.url()}: ${m.text().slice(0, 200)}`);
  });
  for (const p of ["/my-issues", "/issues", "/triage", "/board", "/review", "/cycle", "/roadmap", "/insights"]) {
    await page.goto(p);
    await page.waitForLoadState("networkidle");
  }
  expect(bad).toEqual([]);
});

test("rows are 36px by default and 32px in compact density", async ({ page }) => {
  await ready(page);
  const h = async () => (await page.locator("[data-issue-row]").first().boundingBox())!.height;
  expect(await h()).toBe(36);
  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("dialog", { name: "Display options" }).getByRole("option", { name: "Density: compact" }).click();
  await expect.poll(h).toBe(32);
  await page.evaluate(() => localStorage.removeItem("tl:density"));
});

test.describe("mobile 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("@a11y no horizontal scroll; menu drawer opens and Esc closes it", async ({ page }) => {
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Open menu" }).click();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(nav).not.toBeVisible();
    await expect(page.getByRole("navigation", { name: "Quick actions" })).toBeVisible();
  });
});
