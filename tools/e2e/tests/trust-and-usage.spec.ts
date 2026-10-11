import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// PLAN-016 (public legal/trust pages) and PLAN-059 (Settings > Usage).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const LEGAL = ["/privacy", "/terms", "/security", "/status"] as const;
const THEMES = ["dark", "light"] as const;
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((t) => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(t);
  }, theme);
  await page.waitForTimeout(400); // colour transitions settle before axe samples
}

async function violations(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}

test.describe("public trust pages (logged out)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of LEGAL) {
    test(`${path} is public, marked as a draft where it is legal text, and loads no third-party scripts`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (path !== "/status") {
        await expect(page.getByText("Draft, not legal advice.")).toBeVisible();
      }
      const foreign = await page.evaluate(() =>
        [...document.querySelectorAll("script[src]")]
          .map((s) => (s as HTMLScriptElement).src)
          .filter((src) => new URL(src).origin !== location.origin),
      );
      expect(foreign).toEqual([]);
    });
  }

  test("privacy covers collection, use, sharing, retention and contact", async ({ page }) => {
    await page.goto("/privacy");
    for (const heading of ["What we collect", "How we use it", "Who we share it with", "Where it is stored and for how long", "Contact"]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
  });

  test("security page points at security@tallyline.app", async ({ page }) => {
    await page.goto("/security");
    await expect(page.getByRole("link", { name: "security@tallyline.app" }).first()).toHaveAttribute(
      "href",
      "mailto:security@tallyline.app",
    );
  });

  test("security.txt is served", async ({ request }) => {
    const res = await request.get("/.well-known/security.txt");
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("Contact: mailto:security@tallyline.app");
  });

  test("status reads the API health check", async ({ page }) => {
    await page.goto("/status");
    await expect(page.getByRole("status").filter({ hasText: "All systems working" })).toBeVisible();
  });

  for (const from of ["/", "/login"] as const) {
    test(`${from} footer links to every trust page`, async ({ page }) => {
      await page.goto(from);
      const nav = page.getByRole("navigation", { name: "Legal and trust" });
      for (const label of ["Privacy", "Terms", "Security", "Status"]) {
        await expect(nav.getByRole("link", { name: label })).toBeVisible();
      }
    });
  }

  test("@keyboard sign-in footer: Tab reaches Privacy and Enter opens it", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    const privacy = page.getByRole("navigation", { name: "Legal and trust" }).getByRole("link", { name: "Privacy" });
    for (let i = 0; i < 25; i++) {
      if (await privacy.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(privacy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();
  });

  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const path of LEGAL) {
        test(`@a11y ${path} ${theme} @${vp.name}`, async ({ page }) => {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.goto(path);
          await page.waitForLoadState("networkidle");
          await setTheme(page, theme);
          const v = await violations(page);
          expect(v, v.join("\n")).toHaveLength(0);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(overflow, "horizontal scroll").toBeLessThanOrEqual(0);
        });
      }
    }
  }
});

test.describe("Settings > Usage", () => {
  test("shows the plan, live counters and charts", async ({ page }) => {
    await page.goto("/settings/usage");
    await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
    // BILLING is off in e2e: self-hosted, nothing limited
    await expect(page.getByRole("heading", { name: "Self-hosted plan" })).toBeVisible();
    await expect(page.getByText("Billing is off on this instance")).toBeVisible();
    for (const label of ["Members", "Agents", "Agent runs this month", "API calls today", "Storage"]) {
      await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Agent runs", exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test("@keyboard the Usage tab is reachable and marked current", async ({ page }) => {
    await page.goto("/settings/members");
    const tab = page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Usage" });
    await tab.focus();
    await expect(tab).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/usage$/);
    await expect(
      page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Usage" }),
    ).toHaveAttribute("aria-current", "page");
  });

  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`@a11y /settings/usage ${theme} @${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto("/settings/usage");
        await page.waitForLoadState("networkidle");
        await expect(page.getByRole("heading", { name: "Agent runs", exact: true })).toBeVisible({ timeout: 15_000 });
        await setTheme(page, theme);
        const v = await violations(page);
        expect(v, v.join("\n")).toHaveLength(0);
      });
    }
  }
});
