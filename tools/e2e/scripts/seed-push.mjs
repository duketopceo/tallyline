// Push-night seeder: three projects and three bot agents, with issues spread
// over every state and a burst of "done" moves, so /roadmap and
// /roadmap?push=1 have something real to draw.
//   E2E_API_PORT=4591 node tools/e2e/scripts/seed-push.mjs
// Fresh database only (bootstrap is one-shot). Public API only.
const API = `http://localhost:${process.env.E2E_API_PORT ?? "4000"}`;
const PASSWORD = "demo-password-4242";
const OWNER = { email: "luke@tallyline.test", name: "Luke Kimball" };
const DAY = 86_400_000;
const now = Date.now();

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
const sessionOf = (headers) =>
  (headers.getSetCookie?.() ?? []).find((c) => c.startsWith("tly_session="))?.split(";")[0] ?? null;

const boot = await call("POST", "/v1/auth/bootstrap", {
  body: { workspaceSlug: "tally", workspaceName: "Tally", teamKey: "TLY", email: OWNER.email, name: OWNER.name, password: PASSWORD },
}).catch(() => ({ headers: new Headers() }));
const cookie = sessionOf(boot.headers) ?? sessionOf((await call("POST", "/v1/auth/login", { body: { email: OWNER.email, password: PASSWORD } })).headers);
const W = "/v1/workspaces/tally";
const h = { cookie };

// one human per project closes the work (agents cannot approve review), the
// matching agent files and moves it up to review
const humans = { one: { h }, two: null, three: null };
for (const [slot, email, name] of [["two", "bot2@tallyline.test", "Two"], ["three", "bot3@tallyline.test", "Three"]]) {
  const inv = await call("POST", `${W}/invites`, { ...h, body: { email, role: "member" } });
  const token = inv.data.joinUrl.split("/join/")[1];
  const acc = await call("POST", "/v1/auth/accept-invite", { body: { token, name, password: PASSWORD } });
  humans[slot] = { h: { cookie: sessionOf(acc.headers) } };
}
const bots = {};
for (const [slot, name] of [["one", "bot-1"], ["two", "bot-2"], ["three", "bot-3"]]) {
  const a = (await call("POST", `${W}/agents`, { ...h, body: { name, harness: "claude-code", capabilities: ["code"] } })).data;
  const k = (await call("POST", `${W}/agents/${a.id}/keys`, { ...h, body: { name: "seed", scopes: ["read", "write"] } })).data;
  bots[slot] = { id: a.id, key: k.key };
}

const PROJECTS = [
  { name: "tallyline", bot: "one", span: [-20, 14], total: 18, done: 11 },
  { name: "wisp", bot: "two", span: [-35, 21], total: 24, done: 9 },
  { name: "WordInk", bot: "three", span: [-12, 6], total: 12, done: 8 },
];
const TOPICS = ["speed budget", "streaming STT", "walkthroughs", "barge-in", "per-app history", "encrypted backups", "PWA manifest", "issue search", "status updates", "inbox", "roadmap rings", "hotkey daemon", "Groq client", "paste target", "demo mode", "eval harness", "key scoping", "sensitive windows"];
const PATH = {
  backlog: ["backlog"], todo: ["backlog", "todo"], in_progress: ["backlog", "todo", "in_progress"],
  in_review: ["backlog", "todo", "in_progress", "in_review"], done: ["backlog", "todo", "in_progress", "in_review", "done"],
};
let n = 0;
for (const p of PROJECTS) {
  const project = (await call("POST", `${W}/projects`, {
    ...h,
    body: { name: p.name, status: "started", startDate: new Date(now + p.span[0] * DAY).toISOString(), targetDate: new Date(now + p.span[1] * DAY).toISOString() },
  })).data;
  for (const [title, off, done] of [["Alpha cut", -4, true], ["Beta", 5, false], ["Launch", p.span[1], false]]) {
    await call("POST", `${W}/projects/${project.id}/milestones`, { ...h, body: { title: `${p.name} ${title}`, targetDate: new Date(now + off * DAY).toISOString(), done } });
  }
  const open = ["in_progress", "in_review", "todo", "backlog"];
  for (let i = 0; i < p.total; i++) {
    const target = i < p.done ? "done" : open[i % open.length];
    const issue = (await call("POST", `${W}/issues`, {
      bearer: bots[p.bot].key,
      body: { teamKey: "TLY", title: `${p.name}: ${TOPICS[n++ % TOPICS.length]} ${i + 1}`, state: "backlog", projectId: project.id },
    })).data;
    for (const s of PATH[target].slice(1)) {
      const by = s === "done" ? humans[p.bot].h : { bearer: bots[p.bot].key };
      await call("PATCH", `${W}/issues/${issue.key}`, { ...by, body: { state: s } });
    }
  }
}
console.log("seeded");
