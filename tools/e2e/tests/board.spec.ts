import { expect, test } from "@playwright/test";

const TITLE = `e2e board ${Date.now()}`;
const patchFor = (page: import("@playwright/test").Page) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().includes("/api/issues/") &&
      r.ok(),
    { timeout: 10_000 },
  );

// tests run serially (workers: 1) and share the TITLE issue created in test 1:
// triage → backlog → todo across the three tests.
test("board: shift+arrow moves a card to the next column and it persists", async ({
  page,
}) => {
  await page.goto("/issues");
  await page.waitForSelector("[data-qc-ready]", { timeout: 15_000 });
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "Quick create issue" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Issue title").fill(TITLE);
  await dialog.getByRole("button", { name: "Create issue" }).click();
  await expect(dialog).not.toBeVisible();

  await page.goto("/board");
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();

  // quick-create lands in triage; focus the card so it becomes the cursor
  const triage = page.getByRole("region", { name: /triage column/i });
  const card = triage.getByRole("button", { name: new RegExp(TITLE) });
  await expect(card).toBeVisible();
  await card.focus();

  const moved = patchFor(page);
  await page.keyboard.press("Shift+ArrowRight"); // triage → backlog
  await moved;

  const backlog = page.getByRole("region", { name: /backlog column/i });
  const backlogCard = backlog.getByRole("button", { name: new RegExp(TITLE) });
  await expect(backlogCard).toBeVisible();
  await expect(
    triage.getByRole("button", { name: new RegExp(TITLE) }),
  ).not.toBeVisible();

  // server-side state agrees (no reload drift)
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: /backlog column/i })
      .getByRole("button", { name: new RegExp(TITLE) }),
  ).toBeVisible();
});

test("board: illegal column move is rejected", async ({ page }) => {
  // TITLE issue is in backlog after test 1; triage is unreachable backwards.
  await page.goto("/board");
  const backlog = page.getByRole("region", { name: /backlog column/i });
  const card = backlog.getByRole("button", { name: new RegExp(TITLE) });
  await expect(card).toBeVisible();
  await card.focus();
  await page.keyboard.press("Shift+ArrowLeft"); // backlog ↛ triage
  await expect(card).toBeVisible();
  await expect(
    page.getByRole("region", { name: /triage column/i }).getByRole("button", {
      name: new RegExp(TITLE),
    }),
  ).not.toBeVisible();
});

test("@keyboard board: m grab + arrows + space drop moves a card (dnd keyboard path)", async ({
  page,
}) => {
  // TITLE issue is in backlog; grab → arrow → drop into todo.
  await page.goto("/board");
  const backlog = page.getByRole("region", { name: /backlog column/i });
  const card = backlog.getByRole("button", { name: new RegExp(TITLE) });
  await expect(card).toBeVisible();
  await card.focus();

  await page.keyboard.press("m"); // grab (Space is peek, Silver Lining section 7)
  await page.waitForTimeout(200);
  const moved = patchFor(page);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  await page.keyboard.press("Space"); // drop
  await moved;

  const todo = page.getByRole("region", { name: /todo column/i });
  await expect(
    todo.getByRole("button", { name: new RegExp(TITLE) }),
  ).toBeVisible();
});

test("@keyboard board: s opens the state picker and moves the card; Space peeks; undo moves it back", async ({ page }) => {
  const T = `e2e board s ${Date.now()}`;
  const r = await page.request.post("/api/issues", { data: { title: T, state: "backlog" } });
  const key = ((await r.json()) as { key: string }).key;
  await page.goto("/board");
  const backlog = page.getByRole("region", { name: /backlog column/i });
  const card = backlog.locator(`[data-board-card="${key}"]`);
  await expect(card).toBeVisible();
  await card.hover();
  await page.keyboard.press("Space");
  await expect(page.getByRole("complementary", { name: `Peek ${key}` })).toBeVisible();
  await page.keyboard.press("Escape");
  await card.hover();
  await page.keyboard.press("s");
  await page.getByRole("dialog", { name: "Set state" }).getByRole("option", { name: "Todo" }).click();
  const todo = page.getByRole("region", { name: /todo column/i });
  await expect(todo.locator(`[data-board-card="${key}"]`)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "→ Todo" })).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(backlog.locator(`[data-board-card="${key}"]`)).toBeVisible();
});

test("board: empty columns collapse to a rail and the column summary scrolls to a column", async ({ page }) => {
  await page.goto("/board");
  await expect(page.getByRole("navigation", { name: "Columns" })).toBeVisible();
  await page.getByRole("navigation", { name: "Columns" }).getByRole("button", { name: /In review/ }).click();
  await expect(page.getByRole("region", { name: /in review column/i })).toBeInViewport();
});
