import { expect, test, type Page } from "@playwright/test";
import { SAME_ORIGIN } from "./helpers";

// The grouped sidebar and its project switcher (face-lift plan U2). The nav
// model itself is unit-tested in apps/web/lib/sidebar-nav.test.ts.
const NAME = `e2e switcher ${Date.now()}`;

async function ready(page: Page, path = "/my-issues") {
  await page.goto(path);
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: "tests/.auth/session.json" });
  const page = await ctx.newPage();
  const made = await page.request.post("/api/projects", { headers: SAME_ORIGIN, data: { name: NAME } });
  expect(made.ok(), "switcher project fixture").toBeTruthy();
  await ctx.close();
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("groups: Workspace, Work, Projects, Planning", async ({ page }) => {
    await ready(page);
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const g of ["Workspace", "Work", "Projects", "Planning", "Settings"]) {
      await expect(nav.getByRole("group", { name: g, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("group", { name: "Workspace" }).getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(nav.getByRole("group", { name: "Planning" }).getByRole("link", { name: "Cycles" })).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  });

  test("switcher: keyboard filter, Enter opens the project, Escape returns focus", async ({ page }) => {
    await ready(page);
    const btn = page.getByRole("button", { name: /^Switch project, current:/ }).first();
    await btn.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Switch project" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(btn).toBeFocused();

    await btn.click();
    await page.getByRole("combobox", { name: "Filter projects" }).fill(NAME);
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
    // the project row is the single current item, and the switcher names it
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    // the sidebar lists only the first 8 projects: the row is current when listed, else Overview is
    const row = nav.getByRole("link", { name: NAME });
    if (await row.count()) await expect(row).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: /^Switch project, current:/ })).toHaveAccessibleName(new RegExp(NAME));
  });

  test("[ toggles the rail, remembers it, and the rail keeps every link and the switcher", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("[");
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.reload();
    await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Roadmap" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Switch project, current:/ })).toBeVisible();
    await page.keyboard.press("[");
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  test("g-sequences and Cmd+K still work", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("g");
    await page.keyboard.press("o");
    await expect(page).toHaveURL(/\/overview$/);
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await expect(page).toHaveURL(/\/cycle$/);
    await page.getByRole("button", { name: /^Search/ }).click();
    await expect(page.getByRole("dialog", { name: /command|search/i }).first()).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("mobile 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("drawer: hidden, opens from the top bar, Escape closes, navigating closes", async ({ page }) => {
    await ready(page);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("group", { name: "Projects" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(nav).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    await nav.getByRole("link", { name: "Overview" }).click();
    await expect(page).toHaveURL(/\/overview$/);
    await expect(nav).toBeHidden();
  });

  test("@a11y no horizontal scroll on overview and board", async ({ page }) => {
    for (const p of ["/overview", "/board"]) {
      await ready(page, p);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), p).toBe(true);
    }
  });
});
