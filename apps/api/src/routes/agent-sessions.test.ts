import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  agentActivities,
  agentKeys,
  agentSessions,
  agents,
  comments,
  dispatches,
  events,
  invites,
  issues,
  oauthCodes,
  sessions,
  teams,
  userTokens,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { sweepStaleSessions } from "../services/agent-sessions.js";
import { NOW, useFrozenClock } from "../../test/clock.js";

useFrozenClock();

const SLUG = "asess-test";
let cookie = "";
let agentId = "";
let agentToken = "";
let otherToken = "";

async function req(path: string, init?: RequestInit & { token?: string }) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  else headers.cookie = cookie;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, { ...init, headers }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function newDispatchSession(title: string) {
  const issue = await req(`/v1/workspaces/${SLUG}/issues`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  const key = (issue.body as { key: string }).key;
  const patched = await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
    method: "PATCH",
    body: JSON.stringify({ assigneeType: "agent", assigneeId: agentId }),
  });
  expect(patched.status).toBe(200);
  const list = await req(`/v1/workspaces/${SLUG}/issues/${key}/agent-sessions`);
  expect(list.status).toBe(200);
  const sessionsOut = (list.body as { sessions: { id: string; status: string }[] }).sessions;
  expect(sessionsOut).toHaveLength(1);
  return { key, session: sessionsOut[0]! };
}

beforeAll(async () => {
  await runMigrations();
  const boot = await app.fetch(
    new Request("http://api.test/v1/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceSlug: SLUG,
        workspaceName: "Agent Sessions",
        teamKey: "AS",
        email: "as@test.dev",
        name: "AS User",
        password: "pw-long-enough",
      }),
    }),
  );
  expect(boot.status).toBe(201);
  cookie = boot.headers.get("set-cookie")!.split(";")[0]!;

  const mk = async (name: string) => {
    const a = await req(`/v1/workspaces/${SLUG}/agents`, {
      method: "POST",
      body: JSON.stringify({ name, harness: "local" }),
    });
    const k = await req(`/v1/workspaces/${SLUG}/agents/${a.body.id}/keys`, {
      method: "POST",
      body: JSON.stringify({ name: "rw", scopes: ["read", "write"] }),
    });
    return { id: a.body.id as string, token: k.body.key as string };
  };
  ({ id: agentId, token: agentToken } = await mk("sess-bot"));
  ({ token: otherToken } = await mk("other-bot"));
});

afterAll(async () => {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, SLUG));
  if (ws) {
    await db.delete(invites).where(eq(invites.workspaceId, ws.id));
    await db
      .delete(users)
      .where(
        sql`${users.id} in (select ${workspaceMembers.userId} from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${ws.id})`,
      );
    for (const t of [
      agentActivities,
      agentSessions,
      comments,
      events,
      webhookDeliveries,
      webhookEndpoints,
      dispatches,
      issues,
      agentKeys,
      agents,
      userTokens,
      oauthCodes,
      workspaceMembers,
      sessions,
      teams,
    ] as const) {
      await db.delete(t).where(eq(t.workspaceId, ws.id));
    }
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  }
  await closeDb();
});

describe("agent sessions (plan L1)", () => {
  it("dispatch creates a pending session; first thought acknowledges it", async () => {
    const { session } = await newDispatchSession("ack me");
    expect(session.status).toBe("pending");

    const res = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "thought", body: "reading the issue" } }),
    });
    expect(res.status).toBe(201);
    const out = res.body as { session: { status: string; lastActivityAt: string } };
    expect(out.session.status).toBe("active");
    expect(out.session.lastActivityAt).toBe(new Date(NOW).toISOString());

    const feed = await db.select().from(events).where(eq(events.action, "session_status"));
    expect(feed.some((e) => (e.after as { sessionId: string }).sessionId === session.id)).toBe(true);
  });

  it("elicitation parks the session and lands on the thread; prompt resumes it", async () => {
    const { session } = await newDispatchSession("ask me");
    const ask = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "elicitation", body: "which branch?" } }),
    });
    expect(ask.status).toBe(201);
    expect((ask.body as { session: { status: string } }).session.status).toBe("awaitingInput");

    const thread = await db.select().from(comments);
    expect(thread.some((c) => c.body.includes("agent needs input: which branch?"))).toBe(true);

    // an agent may not act while waiting
    const act = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "action", action: "git push" } }),
    });
    expect(act.status).toBe(409);

    // the human answers with a prompt through the cookie session
    const reply = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      body: JSON.stringify({ content: { type: "prompt", body: "main" } }),
    });
    expect(reply.status).toBe(201);
    expect((reply.body as { session: { status: string } }).session.status).toBe("active");
    const acts = (reply.body as { activity: { actorType: string } }).activity;
    expect(acts.actorType).toBe("human");
  });

  it("humans cannot speak in the agent's voice", async () => {
    const { session } = await newDispatchSession("voice");
    const res = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      body: JSON.stringify({ content: { type: "thought", body: "i am the bot" } }),
    });
    expect(res.status).toBe(403);
  });

  it("ephemeral activities replace each other; non-ephemeral accumulate", async () => {
    const { session } = await newDispatchSession("progress");
    const post = (body: string, ephemeral: boolean) =>
      req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
        method: "POST",
        token: agentToken,
        body: JSON.stringify({ content: { type: "thought", body }, ephemeral }),
      });
    await post("step 1", false);
    await post("10%", true);
    await post("50%", true);
    await post("90%", true);
    const got = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}`, {
      token: agentToken,
    });
    const acts = (got.body as { activities: { content: { body: string }; ephemeral: boolean }[] })
      .activities;
    expect(acts.map((a) => a.content.body)).toEqual(["step 1", "90%"]);
  });

  it("final response completes; nothing is accepted afterwards", async () => {
    const { session } = await newDispatchSession("finish");
    const done = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "response", body: "PR open", final: true } }),
    });
    expect(done.status).toBe(201);
    const out = done.body as { session: { status: string; endedAt: string | null } };
    expect(out.session.status).toBe("complete");
    expect(out.session.endedAt).not.toBeNull();

    const late = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "thought", body: "one more" } }),
    });
    expect(late.status).toBe(409);
  });

  it("stop signal moves to stopping; a final thought closes it", async () => {
    const { session } = await newDispatchSession("stop");
    const stop = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      body: JSON.stringify({ content: { type: "prompt", body: "stop please" }, signal: "stop" }),
    });
    expect(stop.status).toBe(201);
    expect((stop.body as { session: { status: string } }).session.status).toBe("stopping");
    const bye = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "thought", body: "stopped" } }),
    });
    expect((bye.body as { session: { status: string } }).session.status).toBe("complete");
  });

  it("agent keys see only their own sessions", async () => {
    const { session, key } = await newDispatchSession("isolation");
    const other = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}`, {
      token: otherToken,
    });
    expect(other.status).toBe(403);
    const otherPost = await req(
      `/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`,
      {
        method: "POST",
        token: otherToken,
        body: JSON.stringify({ content: { type: "thought", body: "mine now" } }),
      },
    );
    expect(otherPost.status).toBe(403);
    const list = await req(`/v1/workspaces/${SLUG}/issues/${key}/agent-sessions`, {
      token: otherToken,
    });
    expect((list.body as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it("plan and pull requests patch in and dedupe", async () => {
    const { session } = await newDispatchSession("plan");
    const res = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}`, {
      method: "PATCH",
      token: agentToken,
      body: JSON.stringify({
        plan: { steps: ["read", "fix"] },
        pullRequests: ["https://github.com/x/y/pull/1", "https://github.com/x/y/pull/1"],
      }),
    });
    expect(res.status).toBe(200);
    const out = res.body as { session: { plan: unknown; pullRequests: string[] } };
    expect(out.session.plan).toEqual({ steps: ["read", "fix"] });
    expect(out.session.pullRequests).toEqual(["https://github.com/x/y/pull/1"]);
  });

  it("sweeper marks pending past the ack window and quiet active sessions stale", async () => {
    const { session: silent } = await newDispatchSession("silent");
    const { session: quiet } = await newDispatchSession("quiet");
    await req(`/v1/workspaces/${SLUG}/agent-sessions/${quiet.id}/activities`, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "thought", body: "hello" } }),
    });

    // inside both windows: nothing happens
    expect(await sweepStaleSessions(10_000, 60_000, new Date(NOW + 5_000))).toBe(0);
    // past the ack window: pending sessions flip (earlier tests left some)
    expect(await sweepStaleSessions(10_000, 60_000, new Date(NOW + 11_000))).toBeGreaterThanOrEqual(1);
    const [s1] = await db.select().from(agentSessions).where(eq(agentSessions.id, silent.id));
    expect(s1!.status).toBe("stale");
    const [q1] = await db.select().from(agentSessions).where(eq(agentSessions.id, quiet.id));
    expect(q1!.status).toBe("active");
    // past the idle window: quiet active sessions flip too
    expect(await sweepStaleSessions(10_000, 60_000, new Date(NOW + 61_000))).toBeGreaterThanOrEqual(1);
    const [s2] = await db.select().from(agentSessions).where(eq(agentSessions.id, quiet.id));
    expect(s2!.status).toBe("stale");
    // a stale session refuses activity
    const late = await req(`/v1/workspaces/${SLUG}/agent-sessions/${silent.id}/activities`, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "thought", body: "late" } }),
    });
    expect(late.status).toBe(409);
    // disabled windows sweep nothing
    expect(await sweepStaleSessions(0, 0, new Date(NOW + 999_999))).toBe(0);
  });
});
