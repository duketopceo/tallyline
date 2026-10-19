import { expect, type Page } from "@playwright/test";

const API = `http://localhost:${process.env.E2E_API_PORT ?? "4000"}`;

export interface AgentFixture {
  ws: string;
  agent: { id: string; name: string };
  key: string;
  issueKey: string;
  dispatchId: string;
}

// An agent identity, an issue it filed, a dispatch on it with a session log,
// and a failed report: everything the provenance UI renders.
export async function agentIssue(page: Page, tag: string): Promise<AgentFixture> {
  const me = (await (await page.request.get(`${API}/v1/auth/me`)).json()) as { workspaceSlug: string };
  const ws = `${API}/v1/workspaces/${me.workspaceSlug}`;
  const name = `e2e-${tag}-${Date.now()}`;
  const agent = (await (await page.request.post(`${ws}/agents`, { data: { name, harness: "claude-code" } })).json()) as { id: string };
  const k = (await (await page.request.post(`${ws}/agents/${agent.id}/keys`, { data: { name: "e2e", scopes: ["read", "write"] } })).json()) as { key: string };
  const bearer = { "content-type": "application/json", authorization: `Bearer ${k.key}` };
  const created = await fetch(`${ws}/issues`, { method: "POST", headers: bearer, body: JSON.stringify({ title: `agent filed ${tag} ${Date.now()}`, state: "backlog" }) });
  expect(created.ok).toBeTruthy();
  const issue = (await created.json()) as { key: string };
  // assigning to the agent opens a dispatch
  const assign = await page.request.patch(`${ws}/issues/${issue.key}`, { data: { assigneeType: "agent", assigneeId: agent.id } });
  expect(assign.ok()).toBeTruthy();
  const list = (await (await page.request.get(`${ws}/dispatches?agentId=${agent.id}`)).json()) as { dispatches: { id: string; issueKey: string }[] };
  const dispatchId = list.dispatches.find((d) => d.issueKey === issue.key)!.id;
  const evRes = await fetch(`${ws}/dispatches/${dispatchId}/events`, { method: "POST", headers: bearer, body: JSON.stringify({ events: [{ kind: "reading", message: "Read the issue" }, { kind: "implementing", message: "Patched the retry path" }] }) });
  expect(evRes.ok).toBeTruthy();
  // the web app caches workspace reference data (agent names) for 3s per session
  await new Promise((r) => setTimeout(r, 3_200));
  return { ws, agent: { id: agent.id, name }, key: k.key, issueKey: issue.key, dispatchId };
}

export async function failSession(f: AgentFixture) {
  const r = await fetch(`${f.ws}/dispatches/${f.dispatchId}/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${f.key}` },
    body: JSON.stringify({ outcome: "failed", reason: "tests failing" }),
  });
  expect(r.ok).toBeTruthy();
}

// Playwright's APIRequestContext is not a browser: it sends no Origin or
// Sec-Fetch-Site, which the web app's CSRF gate (apps/web/middleware.ts)
// refuses on every /api write. Fixture writes through the web bridge declare
// themselves same-origin, as a page's own fetch would.
export const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;
