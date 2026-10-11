import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useFrozenClock, NOW } from "../../test/clock.js";
import { mkAgent, newSession, mkIssue, seedTenant, type Tenant } from "../../test/tenants.js";
import { mintInviteToken } from "../auth/invite-token.js";
import { db, pool } from "../db/client.js";
import { agents, invites, workspaces } from "../db/schema.js";
import { app } from "../index.js";
import { createDispatch } from "../services/dispatch.js";
import { setBillingForTests } from "../services/entitlements.js";
import { RESOURCE } from "../services/mcp-oauth.js";
import { pendingApiCalls, flushApiCalls } from "../services/usage.js";

// Review fixes on #108: each block fails on the pre-fix branch.

useFrozenClock();

let seq = 0;
const key = () => `R${String.fromCharCode(65 + (seq % 26))}${String.fromCharCode(65 + (Math.floor(seq++ / 26) % 26))}`;
const REDIRECT = "https://claude.example/api/mcp/auth_callback";

async function tenant(): Promise<Tenant> {
  const t = await seedTenant(`rf${seq}`, key());
  await db.update(workspaces).set({ plan: "free" }).where(eq(workspaces.id, t.ws.id));
  return t;
}

const req = (method: string, path: string, init: { cookie?: string; body?: unknown } = {}) =>
  app.fetch(
    new Request(`http://rf.test${path}`, {
      method,
      headers: {
        ...(init.cookie ? { cookie: `dok_session=${init.cookie}` } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );

beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network disabled");
  });
});
afterEach(() => setBillingForTests(null));

async function consent(cookie: string, workspaceSlug: string) {
  const reg = await app.fetch(
    new Request("http://rf.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    }),
  );
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256",
    resource: RESOURCE, scope: "read write", state: "s",
  });
  const auth = await app.fetch(new Request(`http://rf.test/oauth/authorize?${q}`));
  const requestId = new URL(auth.headers.get("location")!).searchParams.get("request")!;
  const v = (await (await req("GET", `/v1/oauth/consent/${requestId}`, { cookie })).json()) as { csrf: string };
  const res = await req("POST", `/v1/oauth/consent/${requestId}`, {
    cookie,
    body: { csrf: v.csrf, approve: true, workspace: workspaceSlug, scopes: ["read"] },
  });
  return { res, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("BLOCKER: MCP consent respects the agent cap", () => {
  it("refuses with 402 PLAN_LIMIT at the cap and creates no connector agent", async () => {
    setBillingForTests(true);
    const t = await tenant(); // 1 agent
    await mkAgent(t);
    await mkAgent(t); // 3 of 3
    const owner = await newSession(t, "owner");
    const { res, json } = await consent(owner, t.ws.slug);
    expect(res.status).toBe(402);
    expect(json.error).toMatchObject({ code: "PLAN_LIMIT", limit: "agents" });
    expect(String(json.error.message)).toContain("agents");
    const rows = await db.select().from(agents).where(eq(agents.workspaceId, t.ws.id));
    expect(rows).toHaveLength(3);
    expect(rows.some((a) => a.harness === "mcp-connector")).toBe(false);
  });

  it("still connects below the cap", async () => {
    setBillingForTests(true);
    const t = await tenant(); // 1 of 3
    const owner = await newSession(t, "owner");
    const { res } = await consent(owner, t.ws.slug);
    expect(res.status).toBe(200);
  });
});

describe("agent-run limit is atomic", () => {
  it("concurrent dispatches never overshoot the monthly cap", async () => {
    setBillingForTests(true);
    const t = await tenant();
    const issue = await mkIssue(t, { title: "race", state: "todo" });
    await pool.query(
      `insert into dispatches (workspace_id, issue_id, agent_id, trigger, status, created_at)
       select $1, $2, $3, 'assign', 'completed', $4 from generate_series(1, 997)`,
      [t.ws.id, issue.id, t.agent.id, new Date(NOW)],
    );
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        createDispatch({ workspaceId: t.ws.id, issueId: issue.id, agentId: t.agent.id, trigger: "assign" }),
      ),
    );
    const [{ n }] = (await pool.query(`select count(*)::int n from dispatches where workspace_id = $1`, [t.ws.id])).rows;
    expect(n).toBe(1000);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "PLAN_LIMIT" });
    }
  });
});

describe("invite accept", () => {
  async function openInvite(t: Tenant) {
    const { token, hash } = mintInviteToken();
    await db.insert(invites).values({
      workspaceId: t.ws.id, email: null, tokenHash: hash, role: "member",
      createdBy: t.people.owner.id, expiresAt: new Date(NOW + 86_400_000),
    });
    return token;
  }

  it("an existing member accepting into a full workspace gets the idempotent ok", async () => {
    setBillingForTests(true);
    const t = await tenant(); // 3 of 3 members
    const token = await openInvite(t);
    const member = await newSession(t, "member");
    const res = await req("POST", "/v1/auth/accept-invite", { cookie: member, body: { token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, workspaceId: t.ws.id });
  });

  it("concurrent claims never take more than the last free seat (legacy invites)", async () => {
    setBillingForTests(true);
    const t = await tenant();
    await pool.query(`delete from workspace_members where id = $1`, [t.people.member.memberRowId]); // 2 of 3
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { token, hash } = mintInviteToken();
      await db.insert(invites).values({
        workspaceId: t.ws.id, email: `race${i}@rf.test`, tokenHash: hash, role: "member",
        createdBy: t.people.owner.id, expiresAt: new Date(NOW + 86_400_000),
      });
      tokens.push(token);
    }
    const results = await Promise.all(
      tokens.map((token, i) =>
        req("POST", "/v1/auth/accept-invite", { body: { token, name: `R${i}`, password: "a-long-enough-password" } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 402)).toHaveLength(4);
    const [{ n }] = (await pool.query(`select count(*)::int n from workspace_members where workspace_id = $1`, [t.ws.id])).rows;
    expect(n).toBe(3);
  });

  it("402 on an unauthenticated claim does not disclose used/max", async () => {
    setBillingForTests(true);
    const t = await tenant();
    const { token, hash } = mintInviteToken();
    await db.insert(invites).values({
      workspaceId: t.ws.id, email: "late@rf.test", tokenHash: hash, role: "member",
      createdBy: t.people.owner.id, expiresAt: new Date(NOW + 86_400_000),
    });
    const res = await req("POST", "/v1/auth/accept-invite", {
      body: { token, name: "Late", password: "a-long-enough-password" },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("PLAN_LIMIT");
    expect(body.error.plan).toBe("free");
    expect(body.error).not.toHaveProperty("used");
    expect(body.error).not.toHaveProperty("max");
    expect(typeof body.error.message).toBe("string");
    expect(String(body.error.message)).not.toMatch(/\b3\b/);
  });
});

describe("API-call counter runs after authorization", () => {
  it("a role-denied 403 is not counted; an allowed call is", async () => {
    const t = await tenant();
    await flushApiCalls();
    const day = new Date(NOW).toISOString().slice(0, 10);
    const member = await newSession(t, "member");
    const denied = await req("GET", `/v1/workspaces/${t.ws.slug}/invites`, { cookie: member });
    expect(denied.status).toBe(403);
    expect(pendingApiCalls(t.ws.id, day)).toBe(0);
    const owner = await newSession(t, "owner");
    expect((await req("GET", `/v1/workspaces/${t.ws.slug}/invites`, { cookie: owner })).status).toBe(200);
    expect(pendingApiCalls(t.ws.id, day)).toBe(1);
  });
});
