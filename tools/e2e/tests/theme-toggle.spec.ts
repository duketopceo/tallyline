import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { forceTheme } from "./helpers";

// System default and the visible theme toggle in the app chrome.
const tokens = JSON.parse(
  readFileSync(new URL("../../../packages/silver-lining/tokens.json", import.meta.url), "utf8"),
) as { themes: Record<string, { tokens: Record<string, string> }> };
const CANVAS = {
  light: tokens.themes.light!.tokens.canvas!,
  dark: tokens.themes.dark!.tokens.canvas!,
};
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const scheme = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
const dataTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const cookie = async (ctx: BrowserContext) =>
  decodeURIComponent((await ctx.cookies()).find((c) => c.name === "sl-appearance")?.value ?? "");

async function ready(page: Page, path = "/my-issues") {
  await page.goto(path);
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
}
const toggle = (page: Page) => page.locator('[data-testid="theme-toggle"]:visible');
const choose = async (page: Page, name: "System" | "Light" | "Dark") => {
  await toggle(page).click();
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name, exact: true }).click();
};

test.describe("system default", () => {
  for (const osScheme of ["light", "dark"] as const) {
    test(`cookie-less first paint follows a ${osScheme} OS`, async ({ browser }) => {
      const ctx = await browser.newContext({
        storageState: "tests/.auth/session.json",
        colorScheme: osScheme,
        viewport: { width: 1440, height: 900 },
      });
      const page = await ctx.newPage();
      await ready(page);
      expect(await dataTheme(page)).toBeNull();
      expect(await scheme(page)).toBe(osScheme);
      // theme-color: a media pair of the generated canvases
      const metas = await page.evaluate(() =>
        [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => [
          m.getAttribute("media"),
          m.getAttribute("content"),
        ]),
      );
      expect(metas).toEqual(
        expect.arrayContaining([
          ["(prefers-color-scheme: light)", CANVAS.light],
          ["(prefers-color-scheme: dark)", CANVAS.dark],
        ]),
      );
      expect(await page.evaluate((s) => matchMedia(`(prefers-color-scheme: ${s})`).matches, osScheme)).toBe(true);
      await ctx.close();
    });
  }
});

test.describe("toggle", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Light persists across reload; System clears the explicit choice", async ({ browser }) => {
    const ctx = await browser.newContext({
      storageState: "tests/.auth/session.json",
      colorScheme: "dark",
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    await ready(page);
    expect(await scheme(page)).toBe("dark");
    await choose(page, "Light");
    expect(await dataTheme(page)).toBe("light");
    expect(await scheme(page)).toBe("light");
    expect(await cookie(ctx)).toBe("light");
    // browser chrome follows the choice, not the OS
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content")),
      ),
    ).toEqual([CANVAS.light]);
    await page.reload();
    await page.waitForSelector("[data-qc-ready]");
    expect(await dataTheme(page)).toBe("light");
    expect(await scheme(page)).toBe("light");
    await expect(toggle(page)).toHaveAccessibleName("Theme: Light");

    await choose(page, "System");
    expect(await dataTheme(page)).toBeNull();
    expect(await scheme(page)).toBe("dark"); // OS is dark again
    expect(await cookie(ctx)).toBe("system");
    await ctx.close();
  });

  test("keyboard reachable, named, announces state, Escape closes", async ({ page }) => {
    await ready(page);
    const t = toggle(page);
    await expect(t).toHaveAccessibleName(/^Theme: /);
    await t.focus();
    await page.keyboard.press("Enter");
    await expect(t).toHaveAttribute("aria-expanded", "true");
    const group = page.getByRole("group", { name: "Theme" });
    await expect(group.getByRole("button", { pressed: true })).toHaveCount(1);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter"); // System -> Light, first choice after trigger is System
    await expect(group).toBeHidden();
    await t.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(group).toBeHidden();
    await expect(t).toBeFocused();
  });

  test("collapsed rail: icon with an accessible name", async ({ page }) => {
    await ready(page);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    const t = toggle(page);
    await expect(t).toHaveAccessibleName(/^Theme: /);
    await expect(t).not.toContainText("System");
    await choose(page, "Dark");
    expect(await dataTheme(page)).toBe("dark");
    await page.getByRole("button", { name: "Expand sidebar" }).click();
  });

  test("palette Theme commands still apply and persist", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Control+k");
    const dlg = page.getByRole("dialog", { name: "Command palette" });
    await dlg.getByRole("option", { name: /Theme: light/ }).click();
    await expect(dlg).toBeHidden();
    await expect.poll(() => dataTheme(page)).toBe("light");
    await page.reload();
    await expect.poll(() => dataTheme(page)).toBe("light");
    await choose(page, "System");
  });

  test("Settings > Appearance and the toggle stay in sync on the same page", async ({ page }) => {
    await page.goto("/settings/appearance");
    await expect(toggle(page)).toBeVisible();
    await choose(page, "Light");
    await expect(page.getByRole("radio", { name: /^Light/ })).toBeChecked();
    await page.getByRole("radio", { name: /^Dark/ }).check();
    await expect(toggle(page)).toHaveAccessibleName("Theme: Dark");
    expect(await dataTheme(page)).toBe("dark");
    await choose(page, "System");
    await expect(page.getByRole("radio", { name: /Follow system/ })).toBeChecked();
  });

  test("high contrast and custom: toggle reflects it, choosing a mode replaces it and keeps the custom values", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: "tests/.auth/session.json",
      colorScheme: "dark",
      viewport: { width: 1440, height: 900 },
    });
    await ctx.addCookies([{ name: "sl-appearance", value: "hc-dark", url: "http://localhost:3110" }]);
    const page = await ctx.newPage();
    await ready(page);
    await expect(toggle(page)).toHaveAccessibleName("Theme: High contrast dark");
    await choose(page, "Light");
    expect(await dataTheme(page)).toBe("light");

    // custom, base lightness 0.3: toggle to Light, then reopen Settings > Appearance
    await ctx.addCookies([
      { name: "sl-appearance", value: "custom~0.3~0~0~0.68~0.15~245~30", url: "http://localhost:3110" },
    ]);
    await page.reload();
    await page.waitForSelector("[data-qc-ready]");
    await expect(toggle(page)).toHaveAccessibleName("Theme: Custom");
    await choose(page, "Light");
    // no stale inline --sl-* custom properties
    expect(
      await page.evaluate(() => [...document.documentElement.style].filter((p) => p.startsWith("--sl-"))),
    ).toEqual([]);
    await page.goto("/settings/appearance");
    await page.getByRole("radio", { name: /Custom/ }).check();
    const row = page.locator("label", { hasText: "Base lightness" });
    await expect(row.locator("output")).toHaveText("0.3");
    await choose(page, "System");
    await ctx.close();
  });
});

for (const vp of [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const) {
  test.describe(`toggle axe + drawer @${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    for (const theme of ["dark", "light"] as const) {
      test(`@a11y /my-issues with the toggle open (${theme})`, async ({ page }) => {
        await ready(page);
        await forceTheme(page, theme);
        if (vp.width < 1024) await page.getByRole("button", { name: "Open menu" }).click();
        await toggle(page).click();
        await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();
        const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      });
    }
    if (vp.width < 1024) {
      test("mobile drawer carries the toggle and closes cleanly", async ({ page }) => {
        await ready(page);
        await page.getByRole("button", { name: "Open menu" }).click();
        await choose(page, "Light");
        expect(await dataTheme(page)).toBe("light");
        await page.keyboard.press("Escape");
        await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
        await page.getByRole("button", { name: "Open menu" }).click();
        await choose(page, "System");
      });
    }
  });
}
