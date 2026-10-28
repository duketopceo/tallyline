// A throwaway fake Tallyline server for recording the CLI demo. Fake data only.
import { createServer } from "node:http";
const PORT = Number(process.env.PORT ?? 4010);
const now = Date.now();
const mk = (n, title, state, who, minsAgo) => ({
  id: `i${n}`, key: `ACME-${n}`, number: n, title, description: null, state,
  priority: "medium", estimate: null, dueDate: null,
  assigneeType: who ? "agent" : null, assigneeId: who, creatorType: "human",
  creatorId: "u1", teamId: null, cycleId: null, projectId: null, parentId: null,
  source: "web", createdAt: new Date(now - 864e5).toISOString(),
  updatedAt: new Date(now - minsAgo * 6e4).toISOString(),
});
const issues = [
  mk(41, "Invoice export drops the last row", "in_review", "a1", 30),
  mk(44, "Retry webhook deliveries with backoff", "in_review", "a1", 95),
  mk(47, "Customers can't reset a locked account", "triage", null, 12),
  mk(52, "Add CSV import for the billing plan", "in_progress", "a1", 18),
  mk(53, "Search ignores accents", "in_progress", "a2", 42),
];
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const authed = req.headers.authorization === "Bearer tly_pat_demo";
  if (u.pathname === "/health") return json(res, 200, { status: "ok", postgres: true, uptimeSeconds: 4242 });
  if (!authed) return json(res, 401, { error: { code: "UNAUTHENTICATED", message: "invalid token" } });
  if (u.pathname === "/v1/whoami")
    return json(res, 200, { type: "human", id: "u1", name: "Sam", scopes: ["read", "write"], workspaceSlug: "acme", role: "owner" });
  if (u.pathname.endsWith("/agents"))
    return json(res, 200, { agents: [{ id: "a1", name: "Claude", kind: "claude" }, { id: "a2", name: "Codex", kind: "codex" }] });
  if (u.pathname.endsWith("/issues")) {
    const s = u.searchParams.get("state");
    const list = issues.filter((i) => !s || i.state === s).slice(0, Number(u.searchParams.get("limit") ?? 50));
    return json(res, 200, { issues: list, nextCursor: null });
  }
  json(res, 404, { error: { code: "NOT_FOUND", message: "nope" } });
}).listen(PORT, "127.0.0.1", () => console.log(`demo server on ${PORT}`));
