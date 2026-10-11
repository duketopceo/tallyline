import { expect, test } from "@playwright/test";
import { agentIssue, failSession } from "./helpers";

const RUN = Date.now();

async function make(page: import("@playwright/test").Page, title: string, extra: Record<string, unknown> = {}) {
  const r = await page.request.post("/api/issues", { data: { title, state: "backlog", ...extra } });
  return ((await r.json()) as { key: string }).key;
}

test("@keyboard detail: s changes state optimistically, Ctrl+Z undoes; e edits the title", async ({ page }) => {
  const key = await make(page, `e2e detail ${RUN}`);
  await page.goto(`/issues/${key}`);
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
  await page.keyboard.press("s");
  await page.getByRole("dialog", { name: "Set state" }).getByRole("option", { name: "Todo" }).click();
  await expect(page.getByRole("button", { name: "State: Todo. Change" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "→ Todo" })).toBeVisible(); // success toast carries Undo
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: "State: Backlog. Change" })).toBeVisible();

  await page.keyboard.press("e");
  const title = page.getByRole("textbox", { name: "Issue title" });
  await title.fill(`e2e detail renamed ${RUN}`);
  await title.press("Enter");
  await expect(page.getByRole("heading", { name: `e2e detail renamed ${RUN}` })).toBeVisible();
});

test("description editor renders markdown and keeps a draft", async ({ page }) => {
  const key = await make(page, `e2e md ${RUN}`);
  await page.goto(`/issues/${key}`);
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
  await page.getByRole("button", { name: /Add a description/ }).click();
  const box = page.getByRole("textbox", { name: "Description (markdown)" });
  await box.fill("## Plan\n- first step\n- second `code`");
  await box.press("Control+Enter");
  await expect(page.getByRole("listitem").filter({ hasText: "first step" })).toBeVisible();
  await expect(page.locator("code", { hasText: "code" })).toBeVisible();
});

test("comment composer: @ opens agent autocomplete and the comment posts", async ({ page }) => {
  const f = await agentIssue(page, "mention");
  const key = await make(page, `e2e comment ${RUN}`);
  await page.goto(`/issues/${key}`);
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
  const box = page.getByRole("textbox", { name: "Comment" });
  await box.click();
  await box.pressSequentially(`@${f.agent.name}`);
  const list = page.getByRole("listbox", { name: "Mention" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: new RegExp(f.agent.name) })).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue(new RegExp(`@${f.agent.name} `));
  await box.pressSequentially("please take this");
  await box.press("Control+Enter");
  await expect(page.getByText("please take this")).toBeVisible();
});

test("@keyboard provenance: filed-by, session card, failed variant with actions, agent state change with Revert", async ({ page }) => {
  const f = await agentIssue(page, "prov");
  // the agent moves the issue itself, so the timeline holds an agent state change
  const mv = await fetch(`${f.ws}/issues/${f.issueKey}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${f.key}` }, body: JSON.stringify({ state: "todo" }) });
  expect(mv.ok).toBeTruthy();
  await failSession(f);
  await page.goto(`/issues/${f.issueKey}`);
  await expect(page.getByText(new RegExp(`Filed by ${f.agent.name}`))).toBeVisible();
  const sessions = page.getByRole("region", { name: "Agent sessions" });
  await expect(sessions.getByText(f.agent.name).first()).toBeVisible();
  await expect(sessions.getByText("Failed")).toBeVisible();
  await expect(sessions.getByRole("alert")).toContainText("did not finish: tests failing");
  await expect(sessions.getByRole("button", { name: `Re-run ${f.agent.name}` })).toBeVisible();
  await expect(sessions.getByRole("button", { name: "Reassign" })).toBeVisible();
  await sessions.getByRole("button", { name: /Show log/ }).click();
  await expect(sessions.getByText("Patched the retry path")).toBeVisible();

  await expect(page.getByRole("button", { name: "State: Todo. Change" })).toBeVisible();
  // 3+ agent entries in a burst collapse into one summary; expand to reach Revert
  await page.getByRole("button", { name: /made \d+ changes/ }).click();
  await page.getByRole("button", { name: "Revert" }).click();
  await expect(page.getByRole("button", { name: "State: Backlog. Change" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Reverted" })).toBeVisible();
});

test("detail: no native selects; every control has a name", async ({ page }) => {
  const key = await make(page, `e2e names ${RUN}`);
  await page.goto(`/issues/${key}`);
  await expect(page.locator("select")).toHaveCount(0);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll("button, input, textarea")].filter((el) => !(el.getAttribute("aria-label") || (el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).placeholder || (el.id && document.querySelector(`label[for="${el.id}"]`)))).length,
  );
  expect(unnamed).toBe(0);
});
