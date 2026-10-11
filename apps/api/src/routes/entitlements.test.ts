import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useFrozenClock, NOW } from "../../test/clock.js";
import { mkAgent, mkInvite, mkIssue, newSession, seedTenant, type Tenant } from "../../test/tenants.js";
import { mintInviteToken } from "../auth/invite-token.js";
import { db, pool } from "../db/client.js";
import { agents, comments, dispatches, invites, issues, workspaces } from "../db/schema.js";
import { app } from "../index.js";
import { PLANS } from "../plans.js";
import {
  billingEnabled,
  entitlements,
  monthWindow,
  setBillingForTests,
} from "../services/entitlements.js";

// PLAN-059: one entitlements() function, 402 PLAN_LIMIT at the choke points,
// BILLING=off (the default) never enforces anything.

useFrozenClock();

let seq = 0;
const TEAM_KEYS = () => `E${String.fromCharCode(65 + (seq % 26))}${String.fromCharCode(65 + (Math.floor(seq++ / 26) % 26))}`;

async function tenant(plan: "free" | "team" | "self_host_unlimited" = "free"): Promise<Tenant> {
  const t = await seedTenant(`ent${seq}`, TEAM_KEYS());
  await db.update(workspaces).set({ plan }).where(eq(workspaces.id, t.ws.id));
  return t;
}

async function call(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> & { error?: Record<string, unknown> } }> {
  const res = await app.fetch(
    new Request(`http://ent.test${path}`, {
      method,
      headers: {
        cookie: `dok_session=${cookie}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as never };
}

const mkIssueRow = (t: Tenant, title = "limit probe") => mkIssue(t, { title, state: "todo" });

/** n dispatches created at `at` (bulk, one statement) */
async function burnRuns(t: Tenant, n: number, at: Date) {
  const issue = await mkIssueRow(t, "run sink");
  await pool.query(
    `insert into dispatches (workspace_id, issue_id, agent_id, trigger, status, created_at)
     select $1, $2, $3, 'assign', 'completed', $4 from generate_series(1, $5)`,
    [t.ws.id, issue.id, t.agent.id, at, n],
  );
}

beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network disabled in entitlements test");
  });
});

afterEach(() => setBillingForTests(null));

describe("entitlements(): plan config", () => {
  it("BILLING defaults to off and every workspace is self_host_unlimited", async () => {
    expect(billingEnabled()).toBe(false);
    const t = await tenant("free");
    const e = await entitlements(t.ws.id);
    expect(e).toEqual({
      plan: "self_host_unlimited",
      planLabel: "Self-hosted",
      enforced: false,
      limits: { maxWorkspaces: null, maxSeats: null, maxAgents: null, agentRunsPerMonth: null },
    });
  });

  it("BILLING=on reads the workspace plan; numbers come from plans.ts", async () => {
    setBillingForTests(true);
    const free = await tenant("free");
    const team = await tenant("team");
    expect((await entitlements(free.ws.id)).limits).toEqual(PLANS.free.limits);
    expect(PLANS.free.limits).toEqual({ maxWorkspaces: 1, maxSeats: 3, maxAgents: 3, agentRunsPerMonth: 1000 });
    expect((await entitlements(team.ws.id)).plan).toBe("team");
    expect((await entitlements(team.ws.id)).enforced).toBe(true);
  });

  it("a new workspace defaults to the free plan", async () => {
    const t = await seedTenant(`def${seq++}`, TEAM_KEYS());
    const [ws] = await db.select({ plan: workspaces.plan }).from(workspaces).where(eq(workspaces.id, t.ws.id));
    expect(ws!.plan).toBe("free");
  });

  it("monthWindow is the UTC calendar month around the frozen clock", () => {
    expect(new Date(NOW).toISOString()).toBe("2026-10-11T12:00:00.000Z");
    const w = monthWindow();
    expect(w.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    const dec = monthWindow(new Date("2026-12-31T23:59:59.999Z"));
    expect(dec.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("BILLING=off: nothing is enforced", () => {
  it("free-plan workspace can exceed every free limit", async () => {
    const t = await tenant("free");
    const owner = await newSession(t, "owner");
    for (let i = 0; i < 4; i++) {
      expect((await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" })).status).toBe(201);
      expect(
        (await call("POST", `/v1/workspaces/${t.ws.slug}/agents`, owner, { name: `over-${i}`, harness: "test" })).status,
      ).toBe(201);
    }
    await burnRuns(t, 1000, new Date(NOW - 3_600_000));
    const issue = await mkIssueRow(t);
    const r = await call("PATCH", `/v1/workspaces/${t.ws.slug}/issues/${issue.key}`, owner, {
      assigneeType: "agent",
      assigneeId: t.agent.id,
    });
    expect(r.status).toBe(200);
  });
});

describe("BILLING=on: 402 PLAN_LIMIT at the choke points", () => {
  it("seats: invite create refused once members + pending invites reach the cap", async () => {
    setBillingForTests(true);
    const t = await tenant("free"); // owner + admin + member = 3 seats
    const owner = await newSession(t, "owner");
    const r = await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" });
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ code: "PLAN_LIMIT", limit: "seats", plan: "free", max: 3, used: 3 });
    expect(String(r.json.error!.message)).toContain("all 3 member seats included in the Free plan");
    expect(String(r.json.error!.message)).toContain("revoke an invite");
    const [{ n }] = (await pool.query(`select count(*)::int n from invites where workspace_id = $1`, [t.ws.id])).rows;
    expect(n).toBe(0);
  });

  it("seats: pending invites reserve seats; revoking one frees it", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    await pool.query(`delete from workspace_members where id = $1`, [t.people.member.memberRowId]);
    const owner = await newSession(t, "owner");
    const ok = await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" });
    expect(ok.status).toBe(201);
    const full = await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" });
    expect(full.status).toBe(402);
    expect((await call("DELETE", `/v1/workspaces/${t.ws.slug}/invites/${ok.json.id}`, owner)).status).toBe(200);
    expect((await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" })).status).toBe(201);
  });

  it("seats: expired invites do not reserve a seat", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    await pool.query(`delete from workspace_members where id = $1`, [t.people.member.memberRowId]);
    const inv = await mkInvite(t, t.people.owner.id);
    await db.update(invites).set({ expiresAt: new Date(NOW - 1000) }).where(eq(invites.id, inv.id));
    const owner = await newSession(t, "owner");
    expect((await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" })).status).toBe(201);
  });

  it("seats: accepting an invite into a full workspace is refused and the invite stays live", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    const { token, hash } = mintInviteToken();
    const [inv] = await db
      .insert(invites)
      .values({
        workspaceId: t.ws.id,
        email: null,
        tokenHash: hash,
        role: "member",
        createdBy: t.people.owner.id,
        expiresAt: new Date(NOW + 86_400_000),
      })
      .returning();
    const res = await app.fetch(
      new Request("http://ent.test/v1/auth/accept-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name: "Late Joiner", password: "a-long-enough-password" }),
      }),
    );
    // an open-link claim without an email is refused before the seat check
    expect(res.status).toBe(422);
    await db.update(invites).set({ email: "late@ent.test" }).where(eq(invites.id, inv!.id));
    const res2 = await app.fetch(
      new Request("http://ent.test/v1/auth/accept-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name: "Late Joiner", password: "a-long-enough-password" }),
      }),
    );
    expect(res2.status).toBe(402);
    expect(((await res2.json()) as { error: { limit: string } }).error.limit).toBe("seats");
    const [row] = await db.select().from(invites).where(eq(invites.id, inv!.id));
    expect(row!.acceptedAt).toBeNull();
    const [{ n }] = (await pool.query(`select count(*)::int n from users where email = 'late@ent.test'`)).rows;
    expect(n).toBe(0);
  });

  it("agents: the 4th agent on Free is refused with a clear message", async () => {
    setBillingForTests(true);
    const t = await tenant("free"); // 1 agent seeded
    const owner = await newSession(t, "owner");
    for (const name of ["second", "third"]) {
      expect((await call("POST", `/v1/workspaces/${t.ws.slug}/agents`, owner, { name, harness: "test" })).status).toBe(201);
    }
    const r = await call("POST", `/v1/workspaces/${t.ws.slug}/agents`, owner, { name: "fourth", harness: "test" });
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ code: "PLAN_LIMIT", limit: "agents", max: 3, used: 3 });
    expect(String(r.json.error!.message)).toContain("all 3 agents included in the Free plan");
    const rows = await db.select().from(agents).where(and(eq(agents.workspaceId, t.ws.id), eq(agents.name, "fourth")));
    expect(rows).toHaveLength(0);
  });

  it("agent keys: minting pauses only while the workspace is over its agent cap", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    const owner = await newSession(t, "owner");
    await mkAgent(t);
    await mkAgent(t); // 3 agents: at the cap, still fine
    const path = `/v1/workspaces/${t.ws.slug}/agents/${t.agent.id}/keys`;
    expect((await call("POST", path, owner, { name: "k1", scopes: ["read"] })).status).toBe(201);
    await mkAgent(t); // 4 agents: e.g. after a downgrade
    const r = await call("POST", path, owner, { name: "k2", scopes: ["read"] });
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ code: "PLAN_LIMIT", limit: "agent_keys", max: 3, used: 4 });
  });

  it("agent runs: assigning to an agent at the monthly cap is refused before anything is written", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    const owner = await newSession(t, "owner");
    await burnRuns(t, 1000, new Date(NOW - 86_400_000));
    const issue = await mkIssueRow(t);
    const r = await call("PATCH", `/v1/workspaces/${t.ws.slug}/issues/${issue.key}`, owner, {
      assigneeType: "agent",
      assigneeId: t.agent.id,
      title: "should not land",
    });
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ code: "PLAN_LIMIT", limit: "agent_runs", plan: "free", max: 1000, used: 1000 });
    expect(String(r.json.error!.message)).toContain("used all 1,000 agent runs");
    expect(String(r.json.error!.message)).toContain("Runs reset on November 1");
    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after!.assigneeId).toBeNull();
    expect(after!.title).toBe("limit probe");
  });

  it("agent runs: last month's runs do not count; this month's do", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    const owner = await newSession(t, "owner");
    // 1000 runs on Sep 30 23:59:59Z, 999 in October: one run left
    await burnRuns(t, 1000, new Date("2026-09-30T23:59:59.000Z"));
    await burnRuns(t, 999, new Date("2026-10-01T00:00:00.000Z"));
    const issue = await mkIssueRow(t);
    const ok = await call("PATCH", `/v1/workspaces/${t.ws.slug}/issues/${issue.key}`, owner, {
      assigneeType: "agent",
      assigneeId: t.agent.id,
    });
    expect(ok.status).toBe(200);
    const issue2 = await mkIssueRow(t);
    const r = await call("PATCH", `/v1/workspaces/${t.ws.slug}/issues/${issue2.key}`, owner, {
      assigneeType: "agent",
      assigneeId: t.agent.id,
    });
    expect(r.status).toBe(402);
  });

  it("agent runs: an @mention at the cap is refused and the comment is not posted; plain comments still work", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    const owner = await newSession(t, "owner");
    await burnRuns(t, 1000, new Date(NOW - 60_000));
    const issue = await mkIssueRow(t);
    const r = await call("POST", `/v1/workspaces/${t.ws.slug}/issues/${issue.key}/comments`, owner, {
      body: `@${t.agent.name} please take this`,
    });
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ limit: "agent_runs" });
    const rows = await db.select().from(comments).where(eq(comments.issueId, issue.id));
    expect(rows).toHaveLength(0);
    const plain = await call("POST", `/v1/workspaces/${t.ws.slug}/issues/${issue.key}/comments`, owner, {
      body: "no agent here",
    });
    expect(plain.status).toBe(201);
  });

  it("agent runs: send-back at the cap is refused and the issue stays in review", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    const owner = await newSession(t, "owner");
    const issue = await mkIssueRow(t);
    await db.update(issues).set({ state: "in_review" }).where(eq(issues.id, issue.id));
    await db.insert(dispatches).values({
      workspaceId: t.ws.id,
      issueId: issue.id,
      agentId: t.agent.id,
      trigger: "assign",
      status: "completed",
      createdAt: new Date(NOW - 60_000),
    });
    await burnRuns(t, 999, new Date(NOW - 60_000));
    const r = await call("POST", `/v1/workspaces/${t.ws.slug}/issues/${issue.key}/review`, owner, {
      action: "send_back",
      feedback: "tests are red",
    });
    expect(r.status).toBe(402);
    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after!.state).toBe("in_review");
  });

  it("team plan: the free caps do not apply", async () => {
    setBillingForTests(true);
    const t = await tenant("team");
    const owner = await newSession(t, "owner");
    expect((await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" })).status).toBe(201);
    for (const name of ["a2", "a3", "a4"]) {
      expect((await call("POST", `/v1/workspaces/${t.ws.slug}/agents`, owner, { name, harness: "test" })).status).toBe(201);
    }
    await burnRuns(t, 1000, new Date(NOW - 60_000));
    const issue = await mkIssueRow(t);
    expect(
      (await call("PATCH", `/v1/workspaces/${t.ws.slug}/issues/${issue.key}`, owner, {
        assigneeType: "agent",
        assigneeId: t.agent.id,
      })).status,
    ).toBe(200);
  });

  it("self_host_unlimited plan (comp/override) is unlimited even with BILLING=on", async () => {
    setBillingForTests(true);
    const t = await tenant("self_host_unlimited");
    const owner = await newSession(t, "owner");
    expect((await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" })).status).toBe(201);
  });

  it("workspaces: an owner of a Free workspace cannot create a second one", async () => {
    // the first-created workspace's owner is the instance admin (may create)
    const [first] = await db.select().from(workspaces).orderBy(workspaces.createdAt).limit(1);
    const [owner] = (
      await pool.query(`select user_id from workspace_members where workspace_id = $1 and role = 'owner'`, [first!.id])
    ).rows as { user_id: string }[];
    const { createSession } = await import("../services/auth.js");
    const cookie = await createSession(owner!.user_id, first!.id);
    await db.update(workspaces).set({ plan: "free" }).where(eq(workspaces.id, first!.id));
    // billing off: allowed
    const off = await call("POST", "/v1/workspaces", cookie, { slug: `second-${seq++}`, name: "Second" });
    expect(off.status).toBe(201);
    setBillingForTests(true);
    const on = await call("POST", "/v1/workspaces", cookie, { slug: `third-${seq++}`, name: "Third" });
    expect(on.status).toBe(402);
    expect(on.json.error).toMatchObject({ code: "PLAN_LIMIT", limit: "workspaces", max: 1 });
    expect(String(on.json.error!.message)).toContain("You already own 2 workspaces on the Free plan, which includes 1");
    const [{ n }] = (await pool.query(`select count(*)::int n from workspaces where slug like 'third-%'`)).rows;
    expect(n).toBe(0);
    await db.update(workspaces).set({ plan: first!.plan }).where(eq(workspaces.id, first!.id));
  });

  it("concurrent agent creates never both win the last slot", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    const owner = await newSession(t, "owner");
    await mkAgent(t); // 2 of 3
    const results = await Promise.all(
      ["race-a", "race-b", "race-c"].map((name) =>
        call("POST", `/v1/workspaces/${t.ws.slug}/agents`, owner, { name, harness: "test" }),
      ),
    );
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBeLessThanOrEqual(1);
    for (const r of results) expect([201, 402]).toContain(r.status);
    const [{ n }] = (await pool.query(`select count(*)::int n from agents where workspace_id = $1`, [t.ws.id])).rows;
    expect(n).toBeLessThanOrEqual(3);
  });

  it("concurrent invites never push members + pending past the cap", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    await pool.query(`delete from workspace_members where id = $1`, [t.people.member.memberRowId]); // 2 of 3
    const owner = await newSession(t, "owner");
    const results = await Promise.all(
      [1, 2, 3].map(() => call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" })),
    );
    expect(results.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
    const [{ n }] = (await pool.query(`select count(*)::int n from invites where workspace_id = $1`, [t.ws.id])).rows;
    expect(n).toBeLessThanOrEqual(1);
  });

  it("402 bodies are machine-readable for agents and the CLI", async () => {
    setBillingForTests(true);
    const t = await tenant("free");
    const owner = await newSession(t, "owner");
    const r = await call("POST", `/v1/workspaces/${t.ws.slug}/invites`, owner, { role: "member" });
    expect(Object.keys(r.json.error!).sort()).toEqual(["code", "limit", "max", "message", "plan", "used"]);
  });
});

describe("402 is documented in the OpenAPI spec", () => {
  it("every choke-point operation lists a 402 response", async () => {
    const { openApiDoc } = await import("../openapi.js");
    const paths = openApiDoc.paths as Record<string, Record<string, { responses: Record<string, unknown> }>>;
    for (const [p, m] of [
      ["/v1/workspaces/{ws}/invites", "post"],
      ["/v1/workspaces/{ws}/agents", "post"],
      ["/v1/workspaces/{ws}/agents/{id}/keys", "post"],
      ["/v1/workspaces/{ws}/issues/{key}", "patch"],
    ] as const) {
      expect(paths[p]![m]!.responses["402"], `${m} ${p}`).toBeDefined();
    }
  });
});
