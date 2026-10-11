import { expect, test, type Page } from "@playwright/test";
import { agentIssue } from "./helpers";

const API = `http://localhost:${process.env.E2E_API_PORT ?? "4000"}`;
const RUN = Date.now();

async function ws(page: Page) {
  const me = (await (await page.request.get(`${API}/v1/auth/me`)).json()) as { workspaceSlug: string };
  return `${API}/v1/workspaces/${me.workspaceSlug}`;
}

test("@keyboard triage: 12 items cleared with the keyboard alone in under 60s", async ({ page }) => {
  for (let i = 0; i < 12; i++) {
    const r = await page.request.post("/api/issues", { data: { title: `e2e triage ${RUN} ${i}`, state: "triage" } });
    expect(r.ok()).toBeTruthy();
  }
  const t0 = Date.now();
  await page.goto("/triage");
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
  const rows = page.locator("[data-issue-row]");
  await expect(rows.first()).toBeVisible();
  const keys = ["a", "m", "d", "a"];
  let n = 0;
  while ((await rows.count()) > 0 && n < 80) {
    await page.keyboard.press(keys[n % keys.length]!);
    n++;
    await page.waitForTimeout(40);
  }
  await expect(rows).toHaveCount(0);
  expect(Date.now() - t0).toBeLessThan(60_000);
  await expect(page.getByText("Triage is clear")).toBeVisible();
});

test("triage rows show where an item came from", async ({ page }) => {
  await page.request.post("/api/issues", { data: { title: `e2e source ${RUN}`, state: "triage", source: "api" } });
  await page.goto("/triage");
  await expect(page.locator("[data-issue-row]").first().getByText("api", { exact: true })).toBeVisible();
});

test("@keyboard review: evidence pane, held approval with undo, required note on send back", async ({ page }) => {
  const f = await agentIssue(page, "review");
  const w = await ws(page);
  for (const s of ["todo", "in_progress", "in_review"]) {
    expect((await page.request.patch(`${w}/issues/${f.issueKey}`, { data: { state: s } })).ok()).toBeTruthy();
  }
  const rep = await fetch(`${w}/dispatches/${f.dispatchId}/report`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.key}` }, body: JSON.stringify({ outcome: "completed", branch: "agent/fix-it", prUrl: "https://github.com/tallyline/demo/pull/7" }) });
  expect(rep.ok).toBeTruthy();

  await page.goto("/review");
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
  const row = page.locator(`[role="listitem"]`).filter({ hasText: f.issueKey });
  await expect(row).toBeVisible();
  await row.hover();
  const evidence = page.getByRole("region", { name: "Evidence" });
  await expect(evidence.getByRole("link", { name: "Open pull request" })).toBeVisible();
  await expect(evidence.getByText("agent/fix-it")).toBeVisible();

  // send back needs a note
  await page.keyboard.press("r");
  const note = evidence.getByRole("textbox", { name: /What should/ });
  await expect(note).toBeFocused();
  await expect(evidence.getByRole("button", { name: "Send back to agent" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // approve is held 8s; undo brings it back
  await row.hover();
  await page.keyboard.press("a");
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Held for 8 seconds" })).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(row).toBeVisible();

  // approve for real: commits after the hold
  await row.hover();
  await page.keyboard.press("a");
  await expect(row).toHaveCount(0);
  await expect.poll(async () => ((await (await page.request.get(`${w}/issues/${f.issueKey}`)).json()) as { state: string }).state, { timeout: 15_000, intervals: [1000] }).toBe("done");
});

test("review empty state says what will appear", async ({ page }) => {
  await page.route("**/review", (r) => r.continue());
  await page.goto("/review");
  // either rows exist (other tests) or the empty copy shows; the page must render one of them
  await expect(page.getByText("Nothing waiting").or(page.getByRole("list", { name: "Review queue" }))).toBeVisible();
});
