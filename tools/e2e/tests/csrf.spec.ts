import { expect, test } from "@playwright/test";
import { SAME_ORIGIN } from "./helpers";

const RUN = Date.now();
const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3110"}`;

// The CSRF gate must not break real same-origin browser writes: these go
// through the page's own fetch, so the browser stamps Origin/Sec-Fetch-Site.
test("same-origin browser writes (issue, comment, cycle) pass the CSRF gate", async ({ page }) => {
  await page.goto("/issues");
  const post = (path: string, body: unknown) =>
    page.evaluate(
      async ([p, b]) => {
        const r = await fetch(p as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
      },
      [path, body] as const,
    );

  const issue = await post("/api/issues", { title: `e2e csrf ${RUN}`, state: "backlog" });
  expect(issue.status).toBe(201);
  const key = issue.json!.key as string;

  const comment = await post(`/api/issues/${key}/comments`, { body: `csrf ok ${RUN}` });
  expect(comment.status).toBeLessThan(300);

  const teams = (await (await page.request.get(`/api/me`)).json()) as { teams?: { key: string }[] };
  const teamKey = teams.teams?.[0]?.key ?? "E2E";
  const day = 86_400_000;
  const cycle = await post("/api/cycles", {
    teamKey,
    name: `e2e csrf cycle ${RUN}`,
    startsAt: new Date(Date.now() + 30 * day).toISOString(),
    endsAt: new Date(Date.now() + 37 * day).toISOString(),
    isActive: false,
  });
  expect(cycle.status, JSON.stringify(cycle.json)).toBeLessThan(300);
});

test("a cross-origin write to the web bridge is refused with 403", async ({ page }) => {
  for (const path of ["/api/issues", "/api/cycles", "/api/login", "/api/logout"]) {
    const res = await page.request.post(path, {
      headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site", "content-type": "application/json" },
      data: {},
    });
    expect(res.status(), path).toBe(403);
  }
  // control: the same request declared same-origin is not refused by the gate
  const ok = await page.request.post("/api/issues", { headers: { ...SAME_ORIGIN, origin: WEB }, data: { title: `e2e csrf ctl ${RUN}`, state: "backlog" } });
  expect(ok.status()).toBe(201);
});
