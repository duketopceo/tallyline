import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Grouped Settings: the /settings overview (profile first, grouped rows,
// danger zone last, like the iOS sheet), the sidebar beside every page at
// desktop width and the back link at phone width.

const GROUPS = ["Account", "Workspace", "Planning", "Agents and AI", "Integrations and access", "Danger zone"];

test("overview: profile card first, groups in order, danger zone last", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings).toEqual(GROUPS);
  // the overview is the navigation, so the sidebar steps aside here
  await expect(page.getByRole("navigation", { name: "Settings" })).toHaveCount(0);

  const danger = page.getByRole("region", { name: "Danger zone" });
  await expect(danger.getByRole("link", { name: "Delete account" })).toBeVisible();
  await expect(danger.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.locator("main a").first().click();
  await expect(page).toHaveURL(/\/settings\/account$/);
});

test("sidebar: grouped, marks the current page, reaches every group", async ({ page }) => {
  await page.goto("/settings/members");
  const nav = page.getByRole("navigation", { name: "Settings" });
  for (const g of GROUPS.slice(0, 5)) {
    await expect(nav.getByRole("group", { name: g })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "Labels" }).click();
  await expect(page).toHaveURL(/\/settings\/labels$/);
  await expect(nav.getByRole("link", { name: "Labels" })).toHaveAttribute("aria-current", "page");

  // a nested page keeps its parent marked
  await page.goto("/settings/agents/connect");
  await expect(nav.getByRole("link", { name: "Agents", exact: true })).toHaveAttribute("aria-current", "page");
});

test("@keyboard sidebar links are reachable in order and open with Enter", async ({ page }) => {
  await page.goto("/settings/members");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await nav.getByRole("link", { name: "Members" }).focus();
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "Invites" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/invites$/);
});

test("g , opens the Settings overview", async ({ page }) => {
  await page.goto("/issues");
  await page.waitForSelector("[data-qc-ready]", { timeout: 15_000 });
  await page.keyboard.press("g");
  await page.keyboard.press(",");
  await expect(page).toHaveURL(/\/settings$/);
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("sub-pages hide the sidebar and link back", async ({ page }) => {
    await page.goto("/settings/members");
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeHidden();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.goto("/settings/agents/connect");
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/agents$/);
  });

  test("@a11y nested page with the back link passes axe", async ({ page }) => {
    await page.goto("/settings/agents/connect");
    await page.waitForLoadState("networkidle");
    const r = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
