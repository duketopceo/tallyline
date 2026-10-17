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
  issueLabels,
  issueRelations,
  issueSuggestions,
  issues,
  labels,
  oauthCodes,
  sessions,
  teams,
  userTokens,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workflowDefinitions,
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
    await db
      .delete(issueLabels)
      .where(
        sql`${issueLabels.issueId} in (select ${issues.id} from ${issues} where ${issues.workspaceId} = ${ws.id})`,
      );
    for (const t of [
      agentActivities,
      agentSessions,
      comments,
      events,
      issueRelations,
      issueSuggestions,
      workflowDefinitions,
      webhookDeliveries,
      webhookEndpoints,
      dispatches,
      issues,
      labels,
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

  it("a stop signal does not let a human post non-prompt content", async () => {
    const { session } = await newDispatchSession("voice stop");
    const res = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`, {
      method: "POST",
      body: JSON.stringify({
        content: { type: "response", body: "x", final: true },
        signal: "stop",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("concurrent activities cannot resurrect a stopped session", async () => {
    const { session } = await newDispatchSession("race");
    const url = `/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`;
    await req(url, {
      method: "POST",
      token: agentToken,
      body: JSON.stringify({ content: { type: "thought", body: "go" } }),
    });
    const [stop, thought] = await Promise.all([
      req(url, {
        method: "POST",
        body: JSON.stringify({ content: { type: "prompt", body: "stop" }, signal: "stop" }),
      }),
      req(url, {
        method: "POST",
        token: agentToken,
        body: JSON.stringify({ content: { type: "thought", body: "still going" } }),
      }),
    ]);
    expect(stop.status).toBe(201);
    // whichever order won, the session must never end up active again
    expect([201, 409]).toContain(thought.status);
    const got = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}`, {
      token: agentToken,
    });
    expect(["stopping", "complete"]).toContain(
      (got.body as { session: { status: string } }).session.status,
    );
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

describe("delegate separate from assignee (plan L2)", () => {
  it("creating and patching an issue with human assignee and agent delegate preserves human owner and dispatches to delegate", async () => {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "as@test.dev"));
    expect(owner).toBeDefined();

    // 1. Create issue with human assignee AND agent delegate
    const created = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "human owned, agent delegated on create",
        assigneeType: "human",
        assigneeId: owner!.id,
        delegateType: "agent",
        delegateId: agentId,
      }),
    });
    expect(created.status).toBe(201);
    const createdIssue = created.body as {
      id: string;
      key: string;
      assigneeType: string;
      assigneeId: string;
      delegateType: string;
      delegateId: string;
    };
    expect(createdIssue.assigneeType).toBe("human");
    expect(createdIssue.assigneeId).toBe(owner!.id);
    expect(createdIssue.delegateType).toBe("agent");
    expect(createdIssue.delegateId).toBe(agentId);

    const createSessions = await req(
      `/v1/workspaces/${SLUG}/issues/${createdIssue.key}/agent-sessions`,
    );
    expect(createSessions.status).toBe(200);
    const sList1 = (
      createSessions.body as { sessions: { id: string; status: string; agentId: string }[] }
    ).sessions;
    expect(sList1).toHaveLength(1);
    expect(sList1[0]!.status).toBe("pending");
    expect(sList1[0]!.agentId).toBe(agentId);

    // 2. Create issue with human assignee only, then PATCH delegate
    const created2 = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "human owned, delegated via patch",
        assigneeType: "human",
        assigneeId: owner!.id,
      }),
    });
    expect(created2.status).toBe(201);
    const key2 = (created2.body as { key: string }).key;

    const patched = await req(`/v1/workspaces/${SLUG}/issues/${key2}`, {
      method: "PATCH",
      body: JSON.stringify({
        delegateType: "agent",
        delegateId: agentId,
      }),
    });
    expect(patched.status).toBe(200);
    const patchedIssue = patched.body as {
      assigneeType: string;
      assigneeId: string;
      delegateType: string;
      delegateId: string;
    };
    expect(patchedIssue.assigneeType).toBe("human");
    expect(patchedIssue.assigneeId).toBe(owner!.id);
    expect(patchedIssue.delegateType).toBe("agent");
    expect(patchedIssue.delegateId).toBe(agentId);

    const patchSessions = await req(
      `/v1/workspaces/${SLUG}/issues/${key2}/agent-sessions`,
    );
    expect(patchSessions.status).toBe(200);
    const sList2 = (
      patchSessions.body as { sessions: { id: string; status: string; agentId: string }[] }
    ).sessions;
    expect(sList2).toHaveLength(1);
    expect(sList2[0]!.status).toBe("pending");
    expect(sList2[0]!.agentId).toBe(agentId);
  });

  it("rejects cross-workspace agent delegateId and mismatched delegateType/delegateId", async () => {
    const [foreignWs] = await db
      .insert(workspaces)
      .values({ slug: `${SLUG}-foreign`, name: "Foreign WS" })
      .returning();
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        workspaceId: foreignWs!.id,
        name: "foreign-bot",
        harness: "local",
      })
      .returning();

    try {
      const badCreate = await req(`/v1/workspaces/${SLUG}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: "cross-tenant delegate create",
          delegateType: "agent",
          delegateId: foreignAgent!.id,
        }),
      });
      expect(badCreate.status).toBe(422);

      const goodIssue = await req(`/v1/workspaces/${SLUG}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "target for cross-tenant delegate patch" }),
      });
      const key = (goodIssue.body as { key: string }).key;

      const badPatch = await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
        method: "PATCH",
        body: JSON.stringify({
          delegateType: "agent",
          delegateId: foreignAgent!.id,
        }),
      });
      expect(badPatch.status).toBe(422);

      const missingId = await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
        method: "PATCH",
        body: JSON.stringify({
          delegateType: "agent",
        }),
      });
      expect(missingId.status).toBe(400);
    } finally {
      await db.delete(agents).where(eq(agents.id, foreignAgent!.id));
      await db.delete(workspaces).where(eq(workspaces.id, foreignWs!.id));
    }
  });

  it("keeps assigneeType='agent' working and emits deprecated_agent_assignee event", async () => {
    const created = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "legacy agent assignee on create",
        assigneeType: "agent",
        assigneeId: agentId,
      }),
    });
    expect(created.status).toBe(201);
    const createdId = (created.body as { id: string }).id;
    const createEvs = await db
      .select()
      .from(events)
      .where(eq(events.entityId, createdId));
    expect(createEvs.some((e) => e.action === "deprecated_agent_assignee")).toBe(true);

    const { key, session } = await newDispatchSession("legacy agent assignee on patch");
    expect(session.status).toBe("pending");
    const [patchedIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.key, key));
    const patchEvs = await db
      .select()
      .from(events)
      .where(eq(events.entityId, patchedIssue!.id));
    expect(patchEvs.some((e) => e.action === "deprecated_agent_assignee")).toBe(true);
  });
});

describe("elicitation reply loop (plan L3)", () => {
  it("resumes an awaitingInput session to active when a human posts a comment on the issue", async () => {
    const { key, session } = await newDispatchSession("L3 elicitation reply loop");

    const elicit = await req(
      `/v1/workspaces/${SLUG}/agent-sessions/${session.id}/activities`,
      {
        method: "POST",
        token: agentToken,
        body: JSON.stringify({
          content: {
            type: "elicitation",
            body: "Which database migration name should I use?",
          },
        }),
      },
    );
    expect(elicit.status).toBe(201);
    expect((elicit.body.session as { status: string }).status).toBe("awaitingInput");

    // Human posts a comment on the issue
    const humanComment = await req(
      `/v1/workspaces/${SLUG}/issues/${key}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Use 0024_linear_l3_l8.sql" }),
      },
    );
    expect(humanComment.status).toBe(201);

    // Session should now be resumed to active with a human prompt activity
    const after = await req(`/v1/workspaces/${SLUG}/agent-sessions/${session.id}`);
    expect(after.status).toBe(200);
    const sessAfter = after.body.session as { status: string };
    expect(sessAfter.status).toBe("active");
    const acts = after.body.activities as {
      type: string;
      actorType: string;
      content: { body?: string };
    }[];
    const promptAct = acts.find((a) => a.type === "prompt");
    expect(promptAct).toBeDefined();
    expect(promptAct!.actorType).toBe("human");
    expect(promptAct!.content.body).toBe("Use 0024_linear_l3_l8.sql");
  });
});

describe("issue suggestions (plan L4)", () => {
  it("generates/creates suggestions idempotently, lists them, and accepts or dismisses with reason", async () => {
    const lbl = await req(`/v1/workspaces/${SLUG}/labels`, {
      method: "POST",
      body: JSON.stringify({ name: "security", color: "#ff0000" }),
    });
    expect(lbl.status).toBe(201);

    const issue = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Audit security headers",
        description: "Ensure security CSP is strict",
      }),
    });
    expect(issue.status).toBe(201);
    const key = issue.body.key as string;

    // Auto-generate suggestions idempotently
    const gen1 = await req(
      `/v1/workspaces/${SLUG}/issues/${key}/suggestions`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(gen1.status).toBe(201);
    const list1 = gen1.body.suggestions as {
      id: string;
      kind: string;
      suggestedValue: string;
      state: string;
    }[];
    expect(list1.length).toBeGreaterThanOrEqual(1);

    const gen2 = await req(
      `/v1/workspaces/${SLUG}/issues/${key}/suggestions`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(gen2.status).toBe(201);
    expect((gen2.body.suggestions as unknown[]).length).toBe(list1.length);

    // Explicit suggestion creation (also idempotent)
    const explicit = await req(
      `/v1/workspaces/${SLUG}/issues/${key}/suggestions`,
      {
        method: "POST",
        body: JSON.stringify({
          kind: "duplicate",
          suggestedValue: "AS-1",
          reason: "looks similar",
        }),
      },
    );
    expect(explicit.status).toBe(201);

    const listed = await req(`/v1/workspaces/${SLUG}/issues/${key}/suggestions`);
    expect(listed.status).toBe(200);
    const allSuggestions = listed.body.suggestions as {
      id: string;
      kind: string;
      suggestedValue: string;
      state: string;
      dismissedReason: string | null;
    }[];
    const labelSug = allSuggestions.find((s) => s.kind === "label")!;
    const dupSug = allSuggestions.find((s) => s.kind === "duplicate")!;
    expect(labelSug).toBeDefined();
    expect(dupSug).toBeDefined();

    // Accept the label suggestion -> attaches label to issue
    const accepted = await req(
      `/v1/workspaces/${SLUG}/issues/${key}/suggestions/${labelSug.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ state: "accepted" }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toBe("accepted");

    const fetchedIssue = await req(`/v1/workspaces/${SLUG}/issues/${key}`);
    expect(fetchedIssue.status).toBe(200);
    const attachedLabels = fetchedIssue.body.labels as { name: string }[];
    expect(attachedLabels.map((l) => l.name)).toContain("security");

    // Dismiss the duplicate suggestion -> records dismissedReason
    const dismissed = await req(
      `/v1/workspaces/${SLUG}/issues/${key}/suggestions/${dupSug.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          state: "dismissed",
          dismissedReason: "different root cause",
        }),
      },
    );
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.state).toBe("dismissed");
    expect(dismissed.body.dismissedReason).toBe("different root cause");
  });
});

describe("issue relations (plan L5)", () => {
  it("rejects self-relation and blocks cycles with 409, transitions duplicate source, and deletes relations", async () => {
    const mkIss = async (title: string) => {
      const r = await req(`/v1/workspaces/${SLUG}/issues`, {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      expect(r.status).toBe(201);
      return r.body as { id: string; key: string; state: string };
    };
    const i1 = await mkIss("Rel issue 1");
    const i2 = await mkIss("Rel issue 2");
    const i3 = await mkIss("Rel issue 3");

    // Reject self-relation with 409
    const selfRel = await req(
      `/v1/workspaces/${SLUG}/issues/${i1.key}/relations`,
      {
        method: "POST",
        body: JSON.stringify({
          targetIssueId: i1.id,
          relationType: "related",
        }),
      },
    );
    expect(selfRel.status).toBe(409);

    // Create i1 blocks i2, i2 blocks i3
    const b12 = await req(
      `/v1/workspaces/${SLUG}/issues/${i1.key}/relations`,
      {
        method: "POST",
        body: JSON.stringify({
          targetIssueId: i2.id,
          relationType: "blocks",
        }),
      },
    );
    expect(b12.status).toBe(201);

    const b23 = await req(
      `/v1/workspaces/${SLUG}/issues/${i2.key}/relations`,
      {
        method: "POST",
        body: JSON.stringify({
          targetIssueId: i3.id,
          relationType: "blocks",
        }),
      },
    );
    expect(b23.status).toBe(201);

    // Reject cycle i3 blocks i1 with 409
    const cycleRel = await req(
      `/v1/workspaces/${SLUG}/issues/${i3.key}/relations`,
      {
        method: "POST",
        body: JSON.stringify({
          targetIssueId: i1.id,
          relationType: "blocks",
        }),
      },
    );
    expect(cycleRel.status).toBe(409);

    // Duplicate relation transitions source issue to 'duplicate'
    const dupSource = await mkIss("Duplicate source");
    const dupRel = await req(
      `/v1/workspaces/${SLUG}/issues/${dupSource.key}/relations`,
      {
        method: "POST",
        body: JSON.stringify({
          targetIssueId: i1.id,
          relationType: "duplicate",
        }),
      },
    );
    expect(dupRel.status).toBe(201);
    const checkDup = await req(`/v1/workspaces/${SLUG}/issues/${dupSource.key}`);
    expect(checkDup.body.state).toBe("duplicate");

    // List and delete relation
    const listRels = await req(
      `/v1/workspaces/${SLUG}/issues/${i1.key}/relations`,
    );
    expect(listRels.status).toBe(200);
    const rels = listRels.body.relations as { id: string }[];
    expect(rels.length).toBeGreaterThanOrEqual(2);

    const del = await req(
      `/v1/workspaces/${SLUG}/issues/${i1.key}/relations/${b12.body.id as string}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
  });
});

describe("loops / workflow definitions (plan L6)", () => {
  it("creates and lists workflows and evaluates issue.transition triggers", async () => {
    const wf = await req(`/v1/workspaces/${SLUG}/workflows`, {
      method: "POST",
      body: JSON.stringify({
        name: "Auto comment on in_review",
        trigger: "issue.transition",
        condition: { to: "in_review" },
        action: { type: "comment", body: "Automated review checklist posted" },
      }),
    });
    expect(wf.status).toBe(201);

    const listed = await req(`/v1/workspaces/${SLUG}/workflows`);
    expect(listed.status).toBe(200);
    expect((listed.body.workflows as { name: string }[]).some((w) => w.name === "Auto comment on in_review")).toBe(true);

    const iss = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "Workflow transition issue" }),
    });
    expect(iss.status).toBe(201);
    const key = iss.body.key as string;

    const toTodo = await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "todo" }),
    });
    expect(toTodo.status).toBe(200);

    const toInProg = await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "in_progress" }),
    });
    expect(toInProg.status).toBe(200);

    const transitioned = await req(`/v1/workspaces/${SLUG}/issues/${key}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "in_review" }),
    });
    expect(transitioned.status).toBe(200);

    const thread = await req(`/v1/workspaces/${SLUG}/issues/${key}/comments`);
    expect(thread.status).toBe(200);
    const bodies = (thread.body.comments as { body: string }[]).map((c) => c.body);
    expect(bodies).toContain("Automated review checklist posted");
  });
});

describe("delta sync read path (plan L7)", () => {
  it("returns ordered events with id > since and nextCursor", async () => {
    const page1 = await req(`/v1/workspaces/${SLUG}/sync?since=0&limit=3`);
    expect(page1.status).toBe(200);
    const evs1 = page1.body.events as { id: number }[];
    expect(evs1).toHaveLength(3);
    expect(evs1[0]!.id).toBeGreaterThan(0);
    expect(evs1[1]!.id).toBeGreaterThan(evs1[0]!.id);
    expect(evs1[2]!.id).toBeGreaterThan(evs1[1]!.id);
    expect(page1.body.nextCursor).toBe(String(evs1[2]!.id));

    const page2 = await req(
      `/v1/workspaces/${SLUG}/sync?since=${page1.body.nextCursor as string}&limit=3`,
    );
    expect(page2.status).toBe(200);
    const evs2 = page2.body.events as { id: number }[];
    expect(evs2.length).toBeGreaterThan(0);
    for (const e of evs2) {
      expect(e.id).toBeGreaterThan(evs1[2]!.id);
    }
  });
});

describe("agent skills (plan L8)", () => {
  it("sets skills on POST and PATCH and filters agents by skill on GET", async () => {
    const created = await req(`/v1/workspaces/${SLUG}/agents`, {
      method: "POST",
      body: JSON.stringify({
        name: "rust-specialist",
        harness: "local",
        skills: ["rust", "postgres"],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.skills).toEqual(["rust", "postgres"]);
    const rustAgentId = created.body.id as string;

    const patched = await req(
      `/v1/workspaces/${SLUG}/agents/${rustAgentId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ skills: ["rust", "postgres", "ebpf"] }),
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.skills).toEqual(["rust", "postgres", "ebpf"]);

    const filtered = await req(`/v1/workspaces/${SLUG}/agents?skill=ebpf`);
    expect(filtered.status).toBe(200);
    const agentsOut = filtered.body.agents as { id: string; name: string; skills: string[] }[];
    expect(agentsOut).toHaveLength(1);
    expect(agentsOut[0]!.id).toBe(rustAgentId);
  });
});
