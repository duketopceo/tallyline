import { expect, test, type Page } from "@playwright/test";

const API = `http://localhost:${process.env.E2E_API_PORT ?? "4000"}`;
const RUN = Date.now();

async function ws(page: Page) {
  const me = (await (await page.request.get(`${API}/v1/auth/me`)).json()) as { workspaceSlug: string };
  return `${API}/v1/workspaces/${me.workspaceSlug}`;
}

test("cycle: summary, progress bar, switcher, no native date-time inputs; completing is held with Undo", async ({ page }) => {
  const w = await ws(page);
  const teams = ((await (await page.request.get(`${w}/teams`)).json()) as { teams: { id: string; key: string }[] }).teams;
  // issues land in the workspace's first team; the cycle must belong to the same team
  const probe = (await (await page.request.post("/api/issues", { data: { title: `e2e probe ${RUN}`, state: "backlog" } })).json()) as { teamId: string };
  const teamKey = teams.find((t) => t.id === probe.teamId)!.key;
  const day = 86_400_000;
  const cyc = (await (await page.request.post(`${w}/cycles`, { data: { teamKey, name: `e2e cycle ${RUN}`, startsAt: new Date(Date.now() - day).toISOString(), endsAt: new Date(Date.now() + 6 * day).toISOString(), isActive: true } })).json()) as { id: string; number: number };
  const a = await page.request.post("/api/issues", { data: { title: `e2e in cycle A ${RUN}`, state: "backlog", cycleId: cyc.id } });
  expect(a.ok()).toBeTruthy();
  await page.goto(`/cycle?cycle=${cyc.id}`);
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
  await expect(page.getByRole("progressbar", { name: "Cycle progress" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cycle summary" })).toContainText("Rolls over on completion");
  await expect(page.locator('input[type="datetime-local"], select')).toHaveCount(0);
  await expect(page.getByRole("main").getByText("Active ·")).toBeVisible();

  await page.getByRole("button", { name: /Switch cycle/ }).click();
  await expect(page.getByRole("dialog", { name: "Switch cycle" }).getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Complete cycle" }).click();
  const toast = page.getByRole("status").filter({ hasText: "will complete" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: /Undo/ }).click();
  await page.waitForTimeout(500);
  const still = (await (await page.request.get(`${w}/cycles/${cyc.id}`)).json()) as { id: string };
  expect(still.id).toBe(cyc.id);
});

test("insights: stat tiles, readable durations, table fallback", async ({ page }) => {
  const w = await ws(page);
  const r = await page.request.post("/api/issues", { data: { title: `e2e insight ${RUN}`, state: "backlog" } });
  const key = ((await r.json()) as { key: string }).key;
  for (const s of ["todo", "in_progress", "in_review", "done"]) await page.request.patch(`${w}/issues/${key}`, { data: { state: s } });
  await page.goto("/insights");
  await expect(page.getByText("Median cycle time")).toBeVisible();
  await expect(page.getByText("Finished by agents")).toBeVisible();
  expect(await page.locator("main").innerText()).not.toMatch(/\de-\d/);
  const panel = page.getByRole("region", { name: "Cycle time" });
  await panel.getByRole("button", { name: "Show table" }).click();
  await expect(panel.getByRole("table", { name: "Cycle time" })).toBeVisible();
  await panel.getByRole("button", { name: "Show chart" }).click();
  await expect(panel.getByRole("img")).toBeVisible();
});

test("roadmap: project health text and links to the board", async ({ page }) => {
  const w = await ws(page);
  const day = 86_400_000;
  const p = (await (await page.request.post(`${w}/projects`, { data: { name: `e2e health ${RUN}`, status: "started", startDate: new Date(Date.now() - 10 * day).toISOString(), targetDate: new Date(Date.now() + 10 * day).toISOString() } })).json()) as { id: string };
  await page.goto("/roadmap");
  const row = page.getByRole("button", { name: new RegExp(`e2e health ${RUN}`) });
  await expect(row).toBeVisible();
  await expect(row.getByText(/On track|At risk|Late|No target date/)).toBeVisible();
  await row.click();
  await expect(page.getByRole("link", { name: "Open on board" })).toHaveAttribute("href", `/board?project=${p.id}`);
});
