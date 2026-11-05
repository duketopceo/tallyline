import { expect, test } from "@playwright/test";

const API = `http://localhost:${process.env.E2E_API_PORT ?? "4100"}`;
const TITLE = `e2e helpdesk report ${Date.now()}`;

// U6 — helpdesk (plan 2026-11-03). A report filed by an outside app with its
// intake key shows up as a report, a staff reply marked public is what the
// reporter's follow-up handle returns, and it never needed a session.
test("support: file through the public endpoint, reply, read it back through the reporter handle", async ({
  page,
}) => {
  const me = (await (await page.request.get(`${API}/v1/auth/me`)).json()) as {
    workspaceSlug: string;
  };
  const ws = `${API}/v1/workspaces/${me.workspaceSlug}`;

  const project = (await (
    await page.request.post(`${ws}/projects`, { data: { name: `${TITLE} project` } })
  ).json()) as { id: string };
  const minted = await page.request.post(`${ws}/intake-credentials`, {
    data: { projectId: project.id, label: `${TITLE} app` },
  });
  expect(minted.ok(), await minted.text()).toBeTruthy();
  const { key } = (await minted.json()) as { key: string };

  const reporterEmail = `reporter-${Date.now()}@example.test`;
  const filed = await page.request.post(`${API}/v1/intake/${encodeURIComponent(key)}`, {
    data: {
      kind: "error",
      title: TITLE,
      body: "TypeError: cart is undefined (checkout.ts:88)",
      reporter: { email: reporterEmail },
    },
  });
  expect(filed.status()).toBe(201);
  const { issueKey, reporterToken } = (await filed.json()) as {
    issueKey: string;
    reporterToken: string;
  };
  expect(reporterToken).toBeTruthy();

  await page.goto("/support");
  await page.waitForLoadState("networkidle");

  // the report is listed with its kind, source app and reporter
  const row = page.getByRole("button", { name: new RegExp(TITLE) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Error");
  await expect(row).toContainText(reporterEmail);

  // kind filter: a bug filter hides an error report
  await page.getByRole("button", { name: "Bug", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(TITLE) })).toHaveCount(0);
  await page.getByRole("button", { name: "All kinds" }).click();
  await expect(page.getByRole("button", { name: new RegExp(TITLE) })).toBeVisible();

  // detail thread: the reply box marks the reply public by default and names
  // who receives it
  await page.getByRole("button", { name: new RegExp(TITLE) }).click();
  const reply = `Fixed in 2.1.0 — thanks for the report (${Date.now()})`;
  await expect(page.getByLabel(/Reply to/)).toBeVisible();
  await expect(page.getByLabel(/Public reply/)).toBeChecked();
  await expect(page.locator("label", { hasText: "Public reply" })).toContainText(reporterEmail);

  await page.getByLabel(/Reply to/).fill(reply);
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes(`/api/issues/${issueKey}/comments`),
  );
  await page.getByRole("button", { name: "Send public reply" }).click();
  expect((await posted).status()).toBe(201);
  await expect(page.getByText(reply)).toBeVisible();
  await expect(page.locator("li", { hasText: reply })).toContainText("Public");

  // the reporter's own handle carries the same reply, with no session and no
  // workspace identity
  const read = await page.request.get(`${API}/v1/report/${encodeURIComponent(reporterToken)}`);
  expect(read.status()).toBe(200);
  const view = (await read.json()) as { title: string; comments: { body: string }[] };
  expect(view.title).toBe(TITLE);
  expect(view.comments.map((c) => c.body)).toContain(reply);
});
