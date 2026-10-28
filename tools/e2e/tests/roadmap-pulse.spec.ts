import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const API = `http://localhost:${process.env.E2E_API_PORT ?? "4000"}`;
const DAY = 86_400_000;
const NAME = `pulse ${Date.now()}`;

interface Fixture {
  ws: string;
  projectId: string;
  keys: string[];
  milestone: string;
}

// A dated project with a milestone two days out and three open issues, made
// with the signed-in human's session straight against the API.
async function fixture(page: Page): Promise<Fixture> {
  const me = (await (await page.request.get(`${API}/v1/auth/me`)).json()) as { workspaceSlug: string };
  const ws = `${API}/v1/workspaces/${me.workspaceSlug}`;
  const now = Date.now();
  const project = (await (
    await page.request.post(`${ws}/projects`, {
      data: {
        name: NAME,
        status: "started",
        startDate: new Date(now - 5 * DAY).toISOString(),
        targetDate: new Date(now + 20 * DAY).toISOString(),
      },
    })
  ).json()) as { id: string };
  const milestone = `${NAME} beta`;
  const ms = await page.request.post(`${ws}/projects/${project.id}/milestones`, {
    data: { title: milestone, targetDate: new Date(now + 2 * DAY).toISOString() },
  });
  expect(ms.ok()).toBeTruthy();
  const keys: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const r = await page.request.post(`${ws}/issues`, {
      data: { teamKey: "E2E", title: `${NAME} issue ${i}`, state: "backlog", projectId: project.id },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    const key = ((await r.json()) as { key: string }).key;
    const up = await page.request.patch(`${ws}/issues/${key}`, { data: { state: "todo" } });
    expect(up.ok(), await up.text()).toBeTruthy();
    keys.push(key);
  }
  return { ws, projectId: project.id, keys, milestone };
}

const ring = (page: Page) => page.locator(`[data-testid="pulse-band"] [data-testid="ring"][data-project="${NAME}"]`);

test.describe.configure({ mode: "serial" });

let fx: Fixture;

test("pulse band: rings count every issue and the milestone strip shows the countdown", async ({ page }) => {
  fx = await fixture(page);
  await page.goto("/roadmap");
  const band = page.getByTestId("pulse-band");
  await expect(band).toBeVisible();
  await expect(ring(page).getByRole("img")).toHaveAttribute("aria-label", new RegExp(`${NAME}: 0 of 3 closed`));
  await expect(ring(page)).toContainText("0/3");

  const strip = page.getByTestId("milestone-strip");
  const marker = strip.getByTestId("milestone").filter({ hasText: fx.milestone });
  await expect(marker).toBeVisible();
  await expect(marker).toContainText(/2d|3d|1d/); // two days out, give or take the day boundary
  await expect(strip.getByTestId("today-mark")).toBeVisible();
});

test("a done move reaches the ticker and the ring live, without a reload", async ({ page }) => {
  await page.goto("/roadmap");
  await expect(page.getByTestId("live-badge")).toHaveAttribute("data-live", "live", { timeout: 15_000 });
  await expect(ring(page)).toBeVisible();

  const key = fx.keys[0]!;
  for (const state of ["in_progress", "in_review", "done"]) {
    const r = await page.request.patch(`${fx.ws}/issues/${key}`, { data: { state } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }

  await expect(page.locator(`[data-testid="ship-item"][data-issue="${key}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(ring(page).getByRole("img")).toHaveAttribute("aria-label", new RegExp(`${NAME}: 1 of 3 closed`), { timeout: 15_000 });
  await expect(ring(page).getByTestId("done-chip")).toContainText("+1");
});

test("push view: full screen, window keys, Esc returns to the roadmap", async ({ page }) => {
  await page.goto("/roadmap?push=1");
  const push = page.getByTestId("push-view");
  await expect(push).toBeVisible();
  await expect(push.getByTestId("push-rings").getByTestId("ring").filter({ hasText: NAME })).toBeVisible();
  await expect(push.getByTestId("push-clock")).toBeVisible();
  // the app chrome is gone: nothing but the push view covers the viewport
  const box = await push.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(vp.width - 1);

  const group = push.getByRole("group", { name: "Time window" });
  await page.keyboard.press("2");
  await expect(group.getByRole("button", { pressed: true })).toHaveCount(1);
  const second = await group.getByRole("button", { pressed: true }).innerText();
  await page.keyboard.press("3");
  await expect(group.getByRole("button", { pressed: true })).not.toHaveText(second);

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/roadmap$/);
  await expect(page.getByTestId("pulse-band")).toBeVisible();
});

test("Shift+P opens the push view from the roadmap", async ({ page }) => {
  await page.goto("/roadmap");
  await expect(page.getByTestId("pulse-band")).toBeVisible();
  await page.keyboard.press("Shift+P");
  await expect(page).toHaveURL(/\/roadmap\?push=1$/);
  await expect(page.getByTestId("push-view")).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`@a11y pulse band and push view have no axe violations (${theme})`, async ({ page }) => {
    for (const path of ["/roadmap", "/roadmap?push=1"]) {
      await page.goto(path);
      await expect(page.getByTestId(path.includes("push") ? "push-view" : "pulse-band")).toBeVisible();
      await page.evaluate((t) => {
        document.documentElement.classList.remove("light", "dark");
        document.documentElement.classList.add(t);
      }, theme);
      await page.waitForTimeout(400);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.help}`), path).toEqual([]);
    }
  });
}
