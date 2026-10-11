// Demo seeder: realistic workspace through the public API only.
//   E2E_API_PORT=4591 node tools/e2e/scripts/seed-demo.mjs
// 3 teams, 3 humans, 3 agents, ~120 issues over every state/priority, labels,
// cycles, a project with milestones, agent sessions with logs. Used for the
// UX scorecard screenshots and the landing page product shots. Idempotent on
// a fresh database only (bootstrap is one-shot).
const API = `http://localhost:${process.env.E2E_API_PORT ?? "4000"}`;
const PASSWORD = "demo-password-4242";
const OWNER = { email: "luke@tallyline.test", name: "Luke Kimball" };

let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const weighted = (items) => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r <= 0) return v;
  }
  return items[0][0];
};

async function call(method, path, { cookie, bearer, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // non-json
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return { data, headers: res.headers };
}

function sessionCookie(headers) {
  const raw = headers.getSetCookie?.() ?? [];
  const hit = raw.find((c) => c.startsWith("dok_session="));
  return hit ? hit.split(";")[0] : null;
}

const boot = await call("POST", "/v1/auth/bootstrap", {
  body: {
    workspaceSlug: "tally",
    workspaceName: "Tally",
    teamKey: "TLY",
    email: OWNER.email,
    name: OWNER.name,
    password: PASSWORD,
  },
});
let cookie = sessionCookie(boot.headers);
if (!cookie) {
  const login = await call("POST", "/v1/auth/login", {
    body: { email: OWNER.email, password: PASSWORD },
  });
  cookie = sessionCookie(login.headers);
}
const W = "/v1/workspaces/tally";
const h = { cookie };

for (const [key, name] of [
  ["PLT", "Platform"],
  ["WEB", "Web"],
]) {
  await call("POST", `${W}/teams`, { ...h, body: { key, name } });
}

// two more humans via the real invite flow
const humans = [{ ...OWNER }];
for (const [email, name] of [
  ["maya@tallyline.test", "Maya Okafor"],
  ["devon@tallyline.test", "Devon Reyes"],
]) {
  const inv = await call("POST", `${W}/invites`, { ...h, body: { email, role: "member" } });
  const token = inv.data.joinUrl.split("/join/")[1];
  await call("POST", "/v1/auth/accept-invite", { body: { token, name, password: PASSWORD } });
  humans.push({ email, name });
}
const members = (await call("GET", `${W}/members`, h)).data.members;
const userId = (email) => members.find((m) => m.email === email).userId;

// agents + keys
const agentDefs = [
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["opencode", "opencode"],
];
const agents = [];
for (const [name, harness] of agentDefs) {
  const a = (await call("POST", `${W}/agents`, { ...h, body: { name, harness, capabilities: ["code", "review"] } })).data;
  const k = (await call("POST", `${W}/agents/${a.id}/keys`, { ...h, body: { name: "demo", scopes: ["read", "write"] } })).data;
  agents.push({ id: a.id, name, key: k.key });
}

const labelDefs = [
  ["bug", "#ef4444"],
  ["feature", "#3ea1f7"],
  ["infra", "#a78bfa"],
  ["docs", "#9ca3af"],
  ["agent-ux", "#10b981"],
  ["security", "#f59e0b"],
];
const labels = [];
for (const [name, color] of labelDefs) {
  labels.push((await call("POST", `${W}/labels`, { ...h, body: { name, color } })).data);
}

// cycles per team (active + upcoming + past)
const day = 86_400_000;
const now = Date.now();
const teams = ["TLY", "PLT", "WEB"];
const cycleIds = {};
for (const t of teams) {
  const past = (await call("POST", `${W}/cycles`, { ...h, body: { teamKey: t, name: "Foundations", startsAt: new Date(now - 28 * day).toISOString(), endsAt: new Date(now - 14 * day).toISOString() } })).data;
  const active = (await call("POST", `${W}/cycles`, { ...h, body: { teamKey: t, name: "Agent handoff", startsAt: new Date(now - 7 * day).toISOString(), endsAt: new Date(now + 7 * day).toISOString(), isActive: true } })).data;
  const next = (await call("POST", `${W}/cycles`, { ...h, body: { teamKey: t, startsAt: new Date(now + 7 * day).toISOString(), endsAt: new Date(now + 21 * day).toISOString() } })).data;
  cycleIds[t] = { past: past.id, active: active.id, next: next.id };
}

// project with milestones
const project = (await call("POST", `${W}/projects`, {
  ...h,
  body: {
    name: "Public beta",
    description: "Ship Tallyline to the first hundred teams: agents and humans on one board.",
    status: "started",
    startDate: new Date(now - 30 * day).toISOString(),
    targetDate: new Date(now + 45 * day).toISOString(),
  },
})).data;
for (const [title, offset, done] of [
  ["Agent keys and sessions", -10, true],
  ["GitHub two-way sync", 7, false],
  ["Review queue GA", 24, false],
  ["Public launch", 45, false],
]) {
  await call("POST", `${W}/projects/${project.id}/milestones`, { ...h, body: { title, targetDate: new Date(now + offset * day).toISOString(), done } });
}

const TITLES = [
  "Webhook deliveries retry with jittered backoff", "Board drops cards when two agents move one issue", "Dark mode contrast on state pills",
  "Cycle rollover leaves orphan sub-issues", "MCP server reconnects after idle timeout", "Slack intake: map emoji to team",
  "Search ignores diacritics in titles", "Keyboard palette: recent issues first", "Import from Linear CSV drops labels",
  "Agent session log truncates long tool output", "Review queue shows stale PR status", "Rate limit headers missing on 429",
  "Docs: agent key rotation walkthrough", "Insights axis shows raw floats", "Triage: bulk decline with reason",
  "Session cookie not rotated after role change", "GitHub sync: PR merged does not close issue", "Add estimate field to quick create",
  "Roadmap milestone drag reorders wrong item", "Light theme: focus ring invisible on surface-3", "Sidebar collapses at 1024px",
  "Per-agent scopes in key creation form", "Audit export as NDJSON", "Webhook signature verification docs",
  "Optimistic update flickers on slow networks", "Peek panel keyboard focus trap", "Saved view sharing with the workspace",
  "SSE stream drops events after 5 minutes", "Add due date to issue detail", "Duplicate detection suggests closed issues",
  "CLI: tally issue list --mine", "CLI auth uses PAT from keyring", "Mobile board: horizontal scroll cue",
  "Skeletons for issue detail", "Markdown description editor", "Comment composer @agent mention",
  "Provenance: show which session changed state", "Agent reports PR url on completion", "Dispatch fails when endpoint is private IP",
  "Cycle burndown off by one on DST change", "Project health from milestone slip", "Postgres connection pool exhaustion under load",
  "Redis reconnect storm on failover", "Backfill sort_order for legacy issues", "Reduce first load JS under 200 kB",
  "Preload Inter and JetBrains Mono", "Empty state copy for review queue", "Error boundary should offer retry",
];
const SUFFIX = ["", "", " (flaky)", " in staging", " on Safari", " for new workspaces", " (regression)", " after upgrade"];
const STATES = [
  ["triage", 9], ["backlog", 32], ["todo", 18], ["in_progress", 16], ["in_review", 9], ["done", 26], ["canceled", 5], ["duplicate", 3],
];
const PRIOS = [["urgent", 6], ["high", 18], ["medium", 34], ["low", 20], ["none", 22]];
const PATH = {
  triage: [], backlog: ["backlog"], todo: ["backlog", "todo"], in_progress: ["backlog", "todo", "in_progress"],
  in_review: ["backlog", "todo", "in_progress", "in_review"], done: ["backlog", "todo", "in_progress", "in_review", "done"],
  canceled: ["backlog", "canceled"], duplicate: ["backlog", "duplicate"],
};

const created = [];
for (let i = 0; i < 120; i++) {
  const team = weighted([["TLY", 5], ["PLT", 3], ["WEB", 4]]);
  const state = weighted(STATES);
  const byAgent = rnd() < 0.3;
  const agent = byAgent ? pick(agents) : null;
  const title = TITLES[i % TITLES.length] + SUFFIX[Math.floor(i / TITLES.length) % SUFFIX.length];
  const assignRoll = rnd();
  const assignee =
    state === "triage" ? null
    : assignRoll < 0.35 ? { assigneeType: "agent", assigneeId: pick(agents).id }
    : assignRoll < 0.8 ? { assigneeType: "human", assigneeId: userId(pick(humans).email) }
    : null;
  const description = rnd() < 0.7
    ? `Observed while dogfooding.\n\n- Expected: the board and the CLI agree.\n- Actual: they drift after a retry.\n\nSteps\n1. Open the issue\n2. Trigger the action\n3. Compare`
    : null;
  const body = {
    teamKey: team,
    title,
    ...(description ? { description } : {}),
    priority: weighted(PRIOS),
    state: state === "triage" ? "triage" : "backlog",
    ...(state !== "triage" && rnd() < 0.5 ? { cycleId: cycleIds[team][pick(["active", "active", "next", "past"])] } : {}),
    ...(rnd() < 0.2 ? { projectId: project.id } : {}),
    labelIds: labels.filter(() => rnd() < 0.22).map((l) => l.id).slice(0, 3),
    ...(assignee && !byAgent ? {} : {}),
  };
  // agent-filed issues use the agent key so provenance is genuine
  const issue = (await call("POST", `${W}/issues`, byAgent ? { bearer: agent.key, body } : { ...h, body })).data;
  created.push({ key: issue.key, state, assignee, agent, byAgent });
}

// walk each issue to its state, then assign (assignment to an agent dispatches)
for (const c of created) {
  for (const s of PATH[c.state].slice(1)) {
    await call("PATCH", `${W}/issues/${c.key}`, { ...h, body: { state: s } });
  }
  if (c.assignee) await call("PATCH", `${W}/issues/${c.key}`, { ...h, body: c.assignee });
}

// sessions: complete/log dispatches
const dispatches = (await call("GET", `${W}/dispatches`, h)).data.dispatches;
const LOG = [
  ["reading", "Read issue, linked PRs and CONTRIBUTING.md"],
  ["planning", "Plan: reproduce, patch retry path, add regression test"],
  ["implementing", "Edited services/outbound.ts, added jitter to backoff"],
  ["testing", "pnpm test --filter api: 214 passed"],
  ["pr", "Opened PR with the fix"],
];
let n = 0;
for (const d of dispatches) {
  const agent = agents.find((a) => a.id === d.agentId);
  const base = { bearer: agent.key };
  const depth = 1 + (n++ % 5);
  await call("POST", `${W}/dispatches/${d.id}/events`, { ...base, body: { events: LOG.slice(0, depth).map(([kind, message]) => ({ kind, message })) } });
  if (depth === 5) {
    await call("POST", `${W}/dispatches/${d.id}/report`, { ...base, body: { outcome: "completed", branch: `agent/${d.issueKey.toLowerCase()}`, prUrl: `https://github.com/tallyline/demo/pull/${100 + n}` } });
  } else if (depth === 3 && n % 3 === 0) {
    await call("POST", `${W}/dispatches/${d.id}/report`, { ...base, body: { outcome: "failed", reason: "tests failing after patch" } });
  }
}

// agents comment on a few in_progress issues
for (const c of created.filter((x) => x.agent && ["in_progress", "in_review"].includes(x.state)).slice(0, 8)) {
  await call("POST", `${W}/issues/${c.key}/comments`, { bearer: c.agent.key, body: { body: "Reproduced locally. The retry path never resets the attempt counter; patching and adding a regression test." } });
}
for (const c of created.slice(0, 6)) {
  await call("POST", `${W}/issues/${c.key}/comments`, { ...h, body: { body: "Thanks. Can you also check the CLI path?" } });
}

console.log(JSON.stringify({ issues: created.length, agents: agents.length, dispatches: dispatches.length, login: OWNER.email, password: PASSWORD }));
