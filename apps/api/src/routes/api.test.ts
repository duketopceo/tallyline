import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { hashKey } from "../services/agents.js";
import { hashToken } from "../services/tokens.js";
import {
  agentKeys,
  agents,
  authIdentities,
  authProviders,
  comments,
  cycles,
  cycleVelocity,
  events,
  invites,
  issues,
  labels,
  oauthCodes,
  projectMilestones,
  projects,
  sessions,
  slackLinks,
  teamMembers,
  teams,
  userIdMap,
  users,
  userTokens,
  views,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { NOW, useFrozenClock } from "../../test/clock.js";

useFrozenClock();

const SLUG = "api-test";
const SLUGS = [SLUG, `${SLUG}-2`];

interface TestBody {
  error?: { code: string; message: string };
  issues?: {
    key: string;
    title: string;
    state: string;
    priority: string;
    labels?: { id: string; name: string; color: string }[];
  }[];
  labels?: { id: string; name: string }[];
  events?: { action: string; actorType: string; actorId?: string | null }[];
  comments?: { body: string }[];
  nextCursor?: string | null;
  key?: string;
  state?: string;
  title?: string;
  priority?: string;
  actorType?: string;
  [key: string]: unknown;
}

let sessionCookie = "";

async function req(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: TestBody }> {
  const extraHeaders = (init?.headers as Record<string, string>) ?? {};
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        // bearer-key requests intentionally bypass the cookie session
        ...(sessionCookie && !extraHeaders.authorization
          ? { cookie: sessionCookie }
          : {}),
        ...extraHeaders,
      },
    }),
  );
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("tly_session=")) {
    sessionCookie = setCookie.split(";")[0]!;
  }
  return { status: res.status, body: (await res.json()) as TestBody };
}

beforeAll(async () => {
  await runMigrations();
  // bootstrap is single-use per deployment — wipe all workspaces so the
  // suite owns the bootstrap path deterministically
  for (const t of [
    comments,
    events,
    issues,
    slackLinks,
    labels,
    agentKeys,
    agents,
    userTokens,
    views,
    cycleVelocity,
    cycles,
    projectMilestones,
    projects,
    authIdentities,
    authProviders,
    invites,
    oauthCodes,
    teamMembers,
    userIdMap,
    workspaceMembers,
    sessions,
    users,
    teams,
  ] as const) {
    await db.delete(t);
  }
  await db.delete(workspaces);
});

afterAll(async () => {
  for (const slug of SLUGS) {
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, slug));
    if (ws) {
      await db
        .delete(invites)
        .where(eq(invites.workspaceId, ws.id));
      await db
        .delete(users)
        .where(
          sql`${users.id} in (select ${workspaceMembers.userId} from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${ws.id})`,
        );
      for (const t of [
        comments,
        events,
        issues,
        slackLinks,
        labels,
        agentKeys,
        agents,
        userTokens,
        views,
        cycleVelocity,
        cycles,
        projectMilestones,
        projects,
        invites,
        oauthCodes,
        workspaceMembers,
        sessions,
        teams,
      ] as const) {
        await db.delete(t).where(eq(t.workspaceId, ws.id));
      }
      await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    }
  }
  await closeDb();
});

describe("api routes (real postgres)", () => {
  it("requires auth, bootstraps once, then rejects second bootstrap", async () => {
    const unauth = await req(`/v1/workspaces/x/teams`);
    expect(unauth.status).toBe(401);

    const boot = await req("/v1/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        workspaceSlug: SLUG,
        workspaceName: "API Test",
        teamKey: "ENG",
        email: "t@t.co",
        name: "Test",
        password: "test-password-123",
      }),
    });
    expect(boot.status).toBe(201);
    expect(sessionCookie).toContain("tly_session=");

    const bootAgain = await req("/v1/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        workspaceSlug: SLUGS[1],
        workspaceName: "Nope",
        email: "x@x.co",
        name: "X",
        password: "test-password-123",
      }),
    });
    expect(bootAgain.status).toBe(403);
    expect(bootAgain.body.error!.code).toBe("BOOTSTRAP_CLOSED");

    const team = await req(`/v1/workspaces/${SLUG}/teams`, {
      method: "POST",
      body: JSON.stringify({ key: "ENG2", name: "Engineering 2" }),
    });
    expect(team.status).toBe(201);
  });

  it("creates issues with minted keys and reads them back", async () => {
    const created = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({
        teamKey: "ENG",
        title: "Wire the API",
        priority: "high",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe("ENG-1");
    expect(created.body.state).toBe("backlog");

    const got = await req(`/v1/workspaces/${SLUG}/issues/ENG-1`);
    expect(got.status).toBe(200);
    expect(got.body.title).toBe("Wire the API");
  });

  it("lists with filters and paginates", async () => {
    for (const title of ["alpha", "beta", "gamma"]) {
      await req(`/v1/workspaces/${SLUG}/issues`, {
        method: "POST",
        body: JSON.stringify({ teamKey: "ENG", title }),
      });
    }

    const all = await req(
      `/v1/workspaces/${SLUG}/issues?limit=2`,
    );
    expect(all.body.issues).toHaveLength(2);
    expect(all.body.nextCursor).toBeTruthy();

    const page2 = await req(
      `/v1/workspaces/${SLUG}/issues?limit=2&cursor=${all.body.nextCursor}`,
    );
    expect(page2.body.issues!.length).toBeGreaterThan(0);
    const keys = new Set(
      [...all.body.issues!, ...page2.body.issues!].map(
        (i: { key: string }) => i.key,
      ),
    );
    expect(keys.size).toBe(all.body.issues!.length + page2.body.issues!.length);

    const filtered = await req(
      `/v1/workspaces/${SLUG}/issues?search=alpha`,
    );
    expect(filtered.body.issues!).toHaveLength(1);
    expect(filtered.body.issues![0]!.title).toBe("alpha");
  });

  it("search matches description, issue key and comments, and treats wildcards literally", async () => {
    const mk = async (title: string, description?: string) =>
      (
        await req(`/v1/workspaces/${SLUG}/issues`, {
          method: "POST",
          body: JSON.stringify({ teamKey: "ENG", title, description }),
        })
      ).body;
    const byDesc = await mk("search-a", "needle-in-description");
    const byComment = await mk("search-b");
    await mk("search-c", "100% done");
    await mk("search-d", "1000 done");
    const c = await req(`/v1/workspaces/${SLUG}/issues/${byComment.key}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "needle-in-comment" }),
    });
    expect(c.status).toBe(201);

    const q = async (s: string) =>
      (await req(`/v1/workspaces/${SLUG}/issues?search=${encodeURIComponent(s)}`)).body
        .issues!.map((i: { key: string }) => i.key);

    expect(await q("needle-in-description")).toEqual([byDesc.key]);
    expect(await q("needle-in-comment")).toEqual([byComment.key]);
    expect(await q(byDesc.key as string)).toContain(byDesc.key);
    expect(await q("NEEDLE-IN-DESC")).toEqual([byDesc.key]);
    // "%" is literal: "100% done" must not match "1000 done"
    const pct = await q("100% done");
    expect(pct).toHaveLength(1);
    expect(await q("no-such-term-anywhere")).toEqual([]);
  });

  it("enforces the state machine over HTTP", async () => {
    const bad = await req(`/v1/workspaces/${SLUG}/issues/ENG-1`, {
      method: "PATCH",
      body: JSON.stringify({ state: "done" }),
    });
    expect(bad.status).toBe(409);
    expect(bad.body.error!.code).toBe("INVALID_TRANSITION");

    const todo = await req(`/v1/workspaces/${SLUG}/issues/ENG-1`, {
      method: "PATCH",
      body: JSON.stringify({ state: "todo" }),
    });
    expect(todo.status).toBe(200);

    const wip = await req(`/v1/workspaces/${SLUG}/issues/ENG-1`, {
      method: "PATCH",
      body: JSON.stringify({ state: "in_progress", priority: "urgent" }),
    });
    expect(wip.status).toBe(200);
    expect(wip.body.state).toBe("in_progress");
    expect(wip.body.priority).toBe("urgent");
  });

  it("comments and exposes the event feed", async () => {
    // agent-typed comments require an agent key — a cookie session
    // asserting x-actor-type: agent is provenance forgery (U2)
    const agent = await req(`/v1/workspaces/${SLUG}/agents`, {
      method: "POST",
      body: JSON.stringify({ name: "commenter", harness: "test" }),
    });
    expect(agent.status).toBe(201);
    const minted = await req(
      `/v1/workspaces/${SLUG}/agents/${agent.body.id}/keys`,
      {
        method: "POST",
        body: JSON.stringify({ scopes: ["write"] }),
      },
    );
    expect(minted.status).toBe(201);

    const forged = await req(
      `/v1/workspaces/${SLUG}/issues/ENG-1/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "should not land" }),
        headers: { "x-actor-type": "agent" },
      },
    );
    expect(forged.status).toBe(403);

    const c1 = await req(
      `/v1/workspaces/${SLUG}/issues/ENG-1/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "picked this up" }),
        headers: {
          authorization: `Bearer ${minted.body.key}`,
          "x-actor-type": "agent",
        },
      },
    );
    expect(c1.status).toBe(201);
    expect(c1.body.actorType).toBe("agent");

    const feed = await req(
      `/v1/workspaces/${SLUG}/issues/ENG-1/events`,
    );
    expect(feed.status).toBe(200);
    const actions = feed.body.events!.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toContain("created");
    expect(actions).toContain("state_changed");
    expect(actions).toContain("commented");
  });

  it("labels CRUD + 404 handling", async () => {
    const label = await req(`/v1/workspaces/${SLUG}/labels`, {
      method: "POST",
      body: JSON.stringify({ name: "bug", color: "#ef4444" }),
    });
    expect(label.status).toBe(201);
    expect(label.body.id).toBeTruthy();

    const list = await req(`/v1/workspaces/${SLUG}/labels`);
    expect(list.body.labels).toHaveLength(1);

    const renamed = await req(`/v1/workspaces/${SLUG}/labels/${label.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "defect", color: "#22c55e" }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("defect");
    expect(renamed.body.color).toBe("#22c55e");

    const badPatch = await req(
      `/v1/workspaces/${SLUG}/labels/${label.body.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ color: "not-hex" }),
      },
    );
    expect(badPatch.status).toBe(400);

    const missingPatch = await req(
      `/v1/workspaces/${SLUG}/labels/00000000-0000-0000-0000-000000000000`,
      { method: "PATCH", body: JSON.stringify({ name: "x" }) },
    );
    expect(missingPatch.status).toBe(404);

    const del = await req(`/v1/workspaces/${SLUG}/labels/${label.body.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const gone = await req(`/v1/workspaces/${SLUG}/labels/${label.body.id}`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(404);

    const missing = await req(`/v1/workspaces/${SLUG}/issues/ENG-999`);
    expect(missing.status).toBe(404);
    expect(missing.body.error!.code).toBe("NOT_FOUND");

    const badWs = await req(`/v1/workspaces/nonexistent/issues`);
    expect(badWs.status).toBe(404);
  });

  it("PATCH labelIds replaces the set atomically and validates ids", async () => {
    const mk = async (name: string) => {
      const r = await req(`/v1/workspaces/${SLUG}/labels`, {
        method: "POST",
        body: JSON.stringify({ name, color: "#339fee" }),
      });
      return r.body.id as string;
    };
    const [a, b] = [await mk("backend"), await mk("frontend")];
    const created = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({ teamKey: "ENG", title: "label swap target" }),
    });
    const key = created.body.key as string;

    const set = await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
      method: "PATCH",
      body: JSON.stringify({ labelIds: [a, b] }),
    });
    expect(set.status).toBe(200);
    let detail = await req(`/v1/workspaces/${SLUG}/issues/${key}`);
    expect(detail.body.labels).toHaveLength(2);

    // replace semantics — removing b leaves only a
    await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
      method: "PATCH",
      body: JSON.stringify({ labelIds: [a] }),
    });
    detail = await req(`/v1/workspaces/${SLUG}/issues/${key}`);
    expect(detail.body.labels).toHaveLength(1);
    expect(detail.body.labels![0]!.name).toBe("backend");

    // unknown label id → 422, existing labels untouched
    const bad = await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
      method: "PATCH",
      body: JSON.stringify({
        labelIds: ["00000000-0000-0000-0000-000000000000"],
      }),
    });
    expect(bad.status).toBe(422);
    detail = await req(`/v1/workspaces/${SLUG}/issues/${key}`);
    expect(detail.body.labels).toHaveLength(1);

    // list rows carry labels for chip rendering
    const list = await req(`/v1/workspaces/${SLUG}/issues?search=label swap target`);
    expect(list.body.issues![0]!.labels).toHaveLength(1);
  });

  it("rejects invalid payloads at the boundary", async () => {
    const bad = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({ teamKey: "ENG", title: "" }),
    });
    expect(bad.status).toBe(400);
  });

  it("agent keys: registry, scoped auth, assignment, agent attribution", async () => {
    // human session registers an agent
    const agent = await req(`/v1/workspaces/${SLUG}/agents`, {
      method: "POST",
      body: JSON.stringify({
        name: "claude-e2e",
        harness: "claude-code",
        capabilities: ["code", "review"],
      }),
    });
    expect(agent.status).toBe(201);
    const agentId = agent.body.id as string;

    // mint a read-scoped key
    const readKey = await req(
      `/v1/workspaces/${SLUG}/agents/${agentId}/keys`,
      {
        method: "POST",
        body: JSON.stringify({ name: "ro", scopes: ["read"] }),
      },
    );
    expect(readKey.status).toBe(201);
    const roToken = readKey.body.key as string;
    expect(roToken).toMatch(/^tly_agt_/);

    // read scope passes GET, fails mutations
    const listOk = await req(`/v1/workspaces/${SLUG}/issues`, {
      headers: { authorization: `Bearer ${roToken}` },
    });
    expect(listOk.status).toBe(200);
    const denied = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${roToken}` },
      body: JSON.stringify({ title: "agent write attempt" }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error!.code).toBe("FORBIDDEN_SCOPE");

    // write key creates an issue attributed to the agent identity
    const writeKey = await req(
      `/v1/workspaces/${SLUG}/agents/${agentId}/keys`,
      {
        method: "POST",
        body: JSON.stringify({ name: "rw", scopes: ["read", "write"] }),
      },
    );
    const rwToken = writeKey.body.key as string;
    const created = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${rwToken}` },
      body: JSON.stringify({ title: "agent-authored issue" }),
    });
    expect(created.status).toBe(201);
    expect(created.body.creatorType).toBe("agent");

    // assign the issue to the agent identity
    const assigned = await req(
      `/v1/workspaces/${SLUG}/issues/${created.body.key}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          assigneeType: "agent",
          assigneeId: agentId,
        }),
      },
    );
    expect(assigned.status).toBe(200);
    expect(assigned.body.assigneeType).toBe("agent");
    expect(assigned.body.assigneeId).toBe(agentId);

    // bad assignee → 422
    const badAssignee = await req(
      `/v1/workspaces/${SLUG}/issues/${created.body.key}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          assigneeType: "agent",
          assigneeId: "00000000-0000-0000-0000-000000000000",
        }),
      },
    );
    expect(badAssignee.status).toBe(422);

    // event feed attributes the write to the agent
    const feed = await req(
      `/v1/workspaces/${SLUG}/issues/${created.body.key}/events`,
    );
    const agentEvents = feed.body.events!.filter(
      (e) => e.actorType === "agent" && e.actorId === agentId,
    );
    expect(agentEvents.length).toBeGreaterThan(0);

    // bogus key → 401
    const badKey = await req(`/v1/workspaces/${SLUG}/issues`, {
      headers: { authorization: "Bearer tly_agt_bogus" },
    });
    expect(badKey.status).toBe(401);

    // agents cannot mint agents
    const agentMint = await req(`/v1/workspaces/${SLUG}/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${rwToken}` },
      body: JSON.stringify({ name: "nested", harness: "x" }),
    });
    expect(agentMint.status).toBe(403);
  });

  it("legacy dok_agt_/dok_pat_ credentials issued before the rename are now rejected", async () => {
    // pre-rename credential: valid hash at rest, retired prefix — must 401
    const agent = await req(`/v1/workspaces/${SLUG}/agents`, {
      method: "POST",
      body: JSON.stringify({ name: "legacy-agent", harness: "x" }),
    });
    const keyRes = await req(
      `/v1/workspaces/${SLUG}/agents/${agent.body.id as string}/keys`,
      { method: "POST", body: JSON.stringify({ name: "old", scopes: ["read"] }) },
    );
    expect(keyRes.body.key as string).toMatch(/^tly_agt_/);
    const legacyKey = "dok_agt_legacy-fixture-key";
    await db
      .update(agentKeys)
      .set({ tokenHash: hashKey(legacyKey) })
      .where(eq(agentKeys.id, keyRes.body.id as string));
    const viaKey = await req(`/v1/workspaces/${SLUG}/issues`, {
      headers: { authorization: `Bearer ${legacyKey}` },
    });
    expect(viaKey.status).toBe(401);

    const mint = await req(`/v1/workspaces/${SLUG}/tokens`, {
      method: "POST",
      body: JSON.stringify({ name: "old-pat", scopes: ["read"] }),
    });
    expect(mint.body.token as string).toMatch(/^tly_pat_/);
    const legacyPat = "dok_pat_legacy-fixture-token";
    await db
      .update(userTokens)
      .set({ tokenHash: hashToken(legacyPat) })
      .where(eq(userTokens.id, mint.body.id as string));
    const viaPat = await req(`/v1/workspaces/${SLUG}/issues`, {
      headers: { authorization: `Bearer ${legacyPat}` },
    });
    expect(viaPat.status).toBe(401);

    // clean up so later token-listing assertions see only their own rows
    await req(`/v1/workspaces/${SLUG}/tokens/${mint.body.id as string}`, {
      method: "DELETE",
    });
  });

  it("personal access tokens: mint, scope enforcement, revoke", async () => {
    const mint = await req(`/v1/workspaces/${SLUG}/tokens`, {
      method: "POST",
      body: JSON.stringify({ name: "ci-reader", scopes: ["read"] }),
    });
    expect(mint.status).toBe(201);
    const pat = mint.body.token as string;
    expect(pat).toMatch(/^tly_pat_/);

    const listOk = await req(`/v1/workspaces/${SLUG}/issues`, {
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(listOk.status).toBe(200);

    const overScope = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${pat}` },
      body: JSON.stringify({ title: "pat write attempt" }),
    });
    expect(overScope.status).toBe(403);
    expect(overScope.body.error!.code).toBe("FORBIDDEN_SCOPE");

    // delegated credentials cannot mint further credentials
    const nested = await req(`/v1/workspaces/${SLUG}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${pat}` },
      body: JSON.stringify({ name: "nested", scopes: ["read"] }),
    });
    expect(nested.status).toBe(403);

    const listed = await req(`/v1/workspaces/${SLUG}/tokens`);
    expect(listed.body.tokens).toHaveLength(1);
    expect((listed.body.tokens as { id: string }[])[0]!.id).toBe(
      mint.body.id,
    );

    const revoked = await req(
      `/v1/workspaces/${SLUG}/tokens/${mint.body.id}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await req(`/v1/workspaces/${SLUG}/issues`, {
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("session exchanges for a short-lived JWT that authenticates", async () => {
    const exchanged = await req("/v1/auth/token", { method: "POST" });
    expect(exchanged.status).toBe(200);
    const jwt = exchanged.body.access_token as string;
    expect(exchanged.body.expires_in).toBe(900);

    const authed = await req(`/v1/workspaces/${SLUG}/issues`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(authed.status).toBe(200);

    // JWTs can write (full user scopes) but cannot mint credentials
    const mint = await req(`/v1/workspaces/${SLUG}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ name: "from-jwt", scopes: ["read"] }),
    });
    expect(mint.status).toBe(403);

    const garbage = await req(`/v1/workspaces/${SLUG}/issues`, {
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(garbage.status).toBe(401);
  });

  it("rate limiter returns 429 with Retry-After after the window", async () => {
    const { Hono } = await import("hono");
    const { createRateLimiter } = await import("../lib/rate-limit.js");
    const mini = new Hono()
      .use("*", createRateLimiter(2))
      .get("/x", (c) => c.json({ ok: true }));

    const r1 = await mini.fetch(new Request("http://t/x"));
    const r2 = await mini.fetch(new Request("http://t/x"));
    const r3 = await mini.fetch(new Request("http://t/x"));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBeTruthy();
    expect(r3.headers.get("x-ratelimit-limit")).toBe("2");
  });

  it("projects, cycles, and views CRUD", async () => {
    const project = await req(`/v1/workspaces/${SLUG}/projects`, {
      method: "POST",
      body: JSON.stringify({ name: "Agent surface", teamKey: "ENG" }),
    });
    expect(project.status).toBe(201);
    expect(project.body.status).toBe("planned");

    const patched = await req(
      `/v1/workspaces/${SLUG}/projects/${project.body.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "started" }) },
    );
    expect(patched.body.status).toBe("started");

    const cycle = await req(`/v1/workspaces/${SLUG}/cycles`, {
      method: "POST",
      body: JSON.stringify({
        teamKey: "ENG",
        startsAt: new Date(NOW - 86400_000).toISOString(),
        endsAt: new Date(NOW + 86400_000).toISOString(),
      }),
    });
    expect(cycle.status).toBe(201);
    expect(cycle.body.number).toBe(1);
    expect(cycle.body.isActive).toBe(false);

    const activated = await req(
      `/v1/workspaces/${SLUG}/cycles/${cycle.body.id}`,
      { method: "PATCH", body: JSON.stringify({ isActive: true }) },
    );
    expect(activated.status).toBe(200);
    expect(activated.body.isActive).toBe(true);

    const active = await req(
      `/v1/workspaces/${SLUG}/cycles?active=true`,
    );
    expect(active.body.cycles).toHaveLength(1);

    const view = await req(`/v1/workspaces/${SLUG}/views`, {
      method: "POST",
      body: JSON.stringify({
        name: "My backlog",
        filters: { state: ["backlog"], assignee: "me" },
        shared: true,
      }),
    });
    expect(view.status).toBe(201);
    const views = await req(`/v1/workspaces/${SLUG}/views`);
    expect(views.body.views).toHaveLength(1);
  });

  it("triage accept/decline transitions with audit events", async () => {
    const triaged = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "triage me", state: "triage" }),
    });
    expect(triaged.status).toBe(201);
    const key = triaged.body.key as string;

    const accepted = await req(
      `/v1/workspaces/${SLUG}/issues/${key}/triage`,
      { method: "POST", body: JSON.stringify({ action: "accept" }) },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toBe("backlog");

    const triaged2 = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "decline me", state: "triage" }),
    });
    const declined = await req(
      `/v1/workspaces/${SLUG}/issues/${triaged2.body.key}/triage`,
      { method: "POST", body: JSON.stringify({ action: "decline" }) },
    );
    expect(declined.body.state).toBe("canceled");

    // decline on a non-triage issue is an invalid transition
    const bad = await req(
      `/v1/workspaces/${SLUG}/issues/${key}/triage`,
      { method: "POST", body: JSON.stringify({ action: "decline" }) },
    );
    expect(bad.status).toBe(409);
  });
});
