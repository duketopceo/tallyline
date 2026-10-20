import { expect, test } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "e2e@tallyline.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-test-password-42";

test.describe("logged out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("landing explains humans and agents on one board with real product screenshots", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /One board for humans and agents/ })).toBeVisible();
    // hero is a DOM-rendered board loop, not a bitmap
    await expect(page.getByRole("img", { name: /Demo board/ })).toBeVisible();
    for (const alt of [/issue list with the peek panel/, /review queue/, /activity log showing who changed the state/]) {
      const img = page.getByRole("img", { name: alt });
      await expect(img).toHaveCount(1);
      expect(await img.getAttribute("width")).toBe("1280");
      expect(await img.getAttribute("height")).toBe("800");
      expect(await img.getAttribute("src")).toMatch(/^\/landing\/.*-dark\.webp$/);
    }
    // light variants are served to light-scheme browsers
    expect(await page.locator('picture source[media="(prefers-color-scheme: light)"]').count()).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", "/login");
    await expect(page.getByRole("link", { name: "AGPL-3.0 license" })).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0); // no WebGL hero
  });

  test("@hydration landing and login log no hydration warnings", async ({ page }) => {
    const bad: string[] = [];
    page.on("console", (m) => { if (/hydrat/i.test(m.text())) bad.push(m.text().slice(0, 200)); });
    for (const p of ["/", "/login"]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
    }
    expect(bad).toEqual([]);
  });

  test("login: field contract, error contract, no layout shift from providers", async ({ page }) => {
    await page.goto("/login");
    const email = page.getByLabel("Email");
    await expect(email).toHaveAttribute("autocomplete", "email");
    await expect(page.getByLabel("Password")).toHaveAttribute("autocomplete", "current-password");
    const submit = page.getByRole("button", { name: "Sign in" });
    const before = await submit.boundingBox();
    await page.waitForLoadState("networkidle"); // methods fetched; providers (if any) append below the form
    expect(await submit.boundingBox()).toEqual(before);

    await email.fill("nobody@example.test");
    await page.getByLabel("Password").fill("wrong-password-123");
    await submit.click();
    const alert = page.getByRole("alert").filter({ hasText: "Could not sign in" });
    await expect(alert).toContainText("Could not sign in");
  });

  test("login with valid credentials lands in the app", async ({ page }) => {
    await page.goto("/login");
    await page.waitForSelector("form");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/my-issues/);
  });

  test.describe("390", () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test("@a11y landing and login have no horizontal scroll on a phone", async ({ page }) => {
      for (const p of ["/", "/login"]) {
        await page.goto(p);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), p).toBe(true);
      }
    });
  });
});
