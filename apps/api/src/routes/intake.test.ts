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

  it("done then a new alert opens one fresh issue; a third alert bumps it instead of making a third", async () => {
    const fp = "fp-regress";
    const first = await postIntake({ kind: "error", provider: "glitchtip", title: "regress", fingerprint: fp, externalId: "reg-1" });
    expect(first.status).toBe(201);
    const oldKey = (first.body.issue as { key: string }).key;
    await db.update(issues).set({ state: "done" }).where(eq(issues.key, oldKey));

    // done issues are never bumped: the regression opens a new issue
    const second = await postIntake({ kind: "error", provider: "glitchtip", title: "regress", fingerprint: fp, externalId: "reg-2" });
    expect(second.status).toBe(201);
    const newKey = (second.body.issue as { key: string }).key;
    expect(newKey).not.toBe(oldKey);

    // with a done issue and a newer live one, the live one wins (newest-first
    // alone would also pick it, so make the done one the NEWEST row too)
    await db.update(issues).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(issues.key, oldKey));
    const third = await postIntake({ kind: "error", provider: "glitchtip", title: "regress", fingerprint: fp, externalId: "reg-3" });
    expect(third.body.status).toBe("deduped");
    expect((third.body.issue as { key: string; occurrenceCount: number })).toMatchObject({ key: newKey, occurrenceCount: 2 });
    const rows = await db.select().from(issues).where(eq(issues.intakeFingerprint, fp));
    expect(rows).toHaveLength(2);
  });

  it("a canceled issue only absorbs repeats when no live one exists", async () => {
    const fp = "fp-canceled";
    const first = await postIntake({ kind: "error", provider: "glitchtip", title: "cx", fingerprint: fp, externalId: "cx-1" });
    const key = (first.body.issue as { key: string }).key;
    await db.update(issues).set({ state: "canceled" }).where(eq(issues.key, key));
    const again = await postIntake({ kind: "error", provider: "glitchtip", title: "cx", fingerprint: fp, externalId: "cx-2" });
    expect(again.body.status).toBe("deduped");
    expect((again.body.issue as { key: string }).key).toBe(key);
  });

  it("rejects malformed events", async () => {
    const res = await postIntake({ kind: "error" });
    expect(res.status).toBe(400);
    const res2 = await postIntake({ kind: "nonsense", title: "x" });
    expect(res2.status).toBe(400);
  });
});
