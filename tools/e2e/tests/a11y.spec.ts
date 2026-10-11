import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// PLAN-044: every app screen, WCAG 2.0/2.1/2.2 A + AA tags, both themes,
// desktop and phone widths. Zero violations gates the run.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const APP_PAGES = [
  "/my-issues",
  "/board",
  "/triage",
  "/review",
  "/cycle",
  "/issues",
  "/issues/:key",
  "/insights",
  "/roadmap",
  "/activity",
  "/settings",
  "/settings/members",
  "/settings/invites",
  "/settings/providers",
];

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;
const THEMES = ["dark", "light"] as const;

// No \b anchors: the page header, list rows and key/title are adjacent flex
// items, so text can read "cycleE2E-1a11y fixture issue" with no separators.
const KEY = /[A-Z][A-Z0-9]*-\d+/;

async function issueKey(page: Page): Promise<string> {
  await page.goto("/issues");
  await page.waitForSelector("[data-qc-ready]", { timeout: 15_000 });
  // the layout hydrates before the streamed page swaps in: wait for visible content
  await page.locator("main:visible").first().waitFor({ timeout: 40_000 });
  await page.locator("[data-issue-row]:visible, :text('No issues')").first().waitFor({ timeout: 40_000 }).catch(() => undefined);
  let match = (await page.locator("main:visible").first().innerText()).match(KEY);
  if (!match) {
    await page.keyboard.press("c");
    const dialog = page.getByRole("dialog", { name: "Quick create issue" });
    await dialog.getByPlaceholder("Issue title").fill("a11y fixture issue");
    await dialog.getByRole("button", { name: "Create issue" }).click();
    await expect(dialog).not.toBeVisible();
    await page.goto("/issues");
    await expect(page.locator("main:visible").first()).toContainText(KEY);
    match = (await page.locator("main:visible").first().innerText()).match(KEY);
  }
  return match![0];
}

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((t) => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(t);
  }, theme);
  // colour transitions (<=150ms) must finish before axe samples contrast
  await page.waitForTimeout(400);
}

async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}\n    ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join("\n    ")}`,
  );
}

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`axe ${theme} @${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });
      let key = "";
      test.beforeAll(async ({ browser }) => {
        test.setTimeout(90_000);
        const ctx = await browser.newContext({ storageState: "tests/.auth/session.json" });
        const page = await ctx.newPage();
        key = await issueKey(page);
        await ctx.close();
      });

      for (const path of APP_PAGES) {
        test(`@a11y ${path}`, async ({ page }) => {
          await page.goto(path.replace(":key", key));
          await page.waitForLoadState("networkidle");
          await setTheme(page, theme);
          const violations = await scan(page);
          expect(violations, violations.join("\n")).toHaveLength(0);
        });
      }
    });
  }
}

test.describe("axe logged-out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  for (const [theme, path] of THEMES.flatMap((t) => ["/", "/login"].map((p) => [t, p] as const))) {
    test(`@a11y ${path} ${theme}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await setTheme(page, theme);
      const violations = await scan(page);
      expect(violations, violations.join("\n")).toHaveLength(0);
    });
  }
});

// overlays: peek panel, picker popover, palette, bulk bar (both themes, both widths)
for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`axe overlays ${theme} @${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });
      test(`@a11y peek + picker + palette`, async ({ page }) => {
        await page.goto("/issues");
        await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
        await setTheme(page, theme);
        const row = page.locator("[data-issue-row]").first();
        await row.hover();
        await page.keyboard.press("Space");
        await expect(page.getByRole("complementary", { name: /^Peek / })).toBeVisible();
        await page.getByRole("heading").filter({ hasText: /./ }).first().waitFor();
        await page.waitForTimeout(400);
        let v = await scan(page);
        expect(v, `peek: ${v.join("\n")}`).toHaveLength(0);
        await page.keyboard.press("Escape");
        await row.hover();
        await page.keyboard.press("s");
        await expect(page.getByRole("dialog", { name: "Set state" })).toBeVisible();
        v = await scan(page);
        expect(v, `picker: ${v.join("\n")}`).toHaveLength(0);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
        v = await scan(page);
        expect(v, `palette: ${v.join("\n")}`).toHaveLength(0);
      });
    });
  }
}
