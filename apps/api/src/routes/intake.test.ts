import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  agentKeys,
  comments,
  cycles,
  cycleVelocity,
  events,
  githubIssueLinks,
  githubRepos,
  githubWebhookEvents,
  intakeEvents,
  invites,
  issues,
  labels,
  oauthCodes,
  projectMilestones,
  projects,
  sessions,
  slackLinks,
  teams,
  users,
  userTokens,
  views,
  webhookDeliveries,
  webhookEndpoints,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";

const SLUG = "intake-test";

let sessionCookie = "";

async function req(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(sessionCookie ? { cookie: sessionCookie } : {}),
        ...(init?.headers as Record<string, string>),
      },
    }),
  );
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("tly_session=")) {
    sessionCookie = setCookie.split(";")[0]!;
  }
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postIntake(event: Record<string, unknown>) {
  return req(`/v1/workspaces/${SLUG}/intake`, {
    method: "POST",
    body: JSON.stringify(event),
  });
}

beforeAll(async () => {
  await runMigrations();
  for (const w of await db.select().from(workspaces)) {
    for (const t of [
      comments, events, intakeEvents, issues, slackLinks, labels, agentKeys,
      userTokens, views, cycleVelocity, cycles, projectMilestones, projects,
      invites, oauthCodes, githubIssueLinks, githubRepos,
      webhookDeliveries, webhookEndpoints, sessions,
      workspaceMembers, teams,
    ] as const) {
      await db.delete(t).where(eq(t.workspaceId, w.id)).catch(() => {});
    }
    await db.delete(githubWebhookEvents).catch(() => {});
    await db.delete(workspaces).where(eq(workspaces.id, w.id));
  }
  await db.delete(users).where(sql`${users.email} like '%@intake.test'`);
});

afterAll(async () => {
  await closeDb();
});

describe("automated intake", () => {
  it("boots a workspace and rejects unauthenticated intake", async () => {
    const unauth = await app.fetch(
      new Request(`http://api.test/v1/workspaces/${SLUG}/intake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "error", title: "x" }),
      }),
    );
    expect(unauth.status).toBe(401);

    const boot = await req("/v1/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        workspaceSlug: SLUG,
        workspaceName: "Intake Test",
        teamKey: "IN",
        email: "owner@intake.test",
        name: "Owner",
        password: "test-password-123",
      }),
    });
    expect(boot.status).toBe(201);
  });

  it("creates a triage issue from an error report with provenance", async () => {
    const res = await postIntake({
      kind: "error",
      provider: "glitchtip",
      title: "TypeError: undefined is not an object",
      body: "at render (list.tsx:42)",
      fingerprint: "fp-abc",
      externalId: "evt-1",
      url: "https://glitchtip.example/issues/1",
      severity: "error",
      occurredAt: "2026-10-19T01:00:00Z",
    });
    expect(res.status).toBe(201);
    const issue = res.body.issue as { key: string; state: string; source: string };
    expect(issue.state).toBe("triage");
    expect(issue.source).toBe("intake");

    const got = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`);
    expect(got.status).toBe(200);
    expect((got.body as { intakeFingerprint?: string }).intakeFingerprint).toBe("fp-abc");
    expect((got.body as { occurrenceCount?: number }).occurrenceCount).toBe(1);
  });

  it("drops duplicate deliveries by external id", async () => {
    const res = await postIntake({
      kind: "error",
      provider: "glitchtip",
      title: "TypeError: undefined is not an object",
      fingerprint: "fp-abc",
      externalId: "evt-1",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("duplicate_delivery");
    expect(res.body.issue).toBeUndefined();
  });

  it("bumps occurrence count on a repeated fingerprint instead of a new issue", async () => {
    const res = await postIntake({
      kind: "error",
      provider: "glitchtip",
      title: "TypeError again",
      fingerprint: "fp-abc",
      externalId: "evt-2",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deduped");
    const issue = res.body.issue as { key: string; occurrenceCount: number };
    expect(issue.occurrenceCount).toBe(2);

    const got = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}/comments`);
    const bodies = ((got.body.comments ?? []) as { body: string }[]).map((c) => c.body);
    expect(bodies.some((b) => b.includes("occurrence"))).toBe(true);
  });

  it("creates a separate issue for a new fingerprint", async () => {
    const res = await postIntake({
      kind: "bug",
      provider: "glitchtip",
      title: "RangeError: max call stack",
      fingerprint: "fp-xyz",
      externalId: "evt-3",
    });
    expect(res.status).toBe(201);
    const issue = res.body.issue as { key: string };
    const got = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`);
    expect((got.body as { intakeFingerprint?: string }).intakeFingerprint).toBe("fp-xyz");
  });

  it("rejects malformed events", async () => {
    const res = await postIntake({ kind: "error" });
    expect(res.status).toBe(400);
    const res2 = await postIntake({ kind: "nonsense", title: "x" });
    expect(res2.status).toBe(400);
  });
});
