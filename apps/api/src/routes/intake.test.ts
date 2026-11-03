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
  intakeCredentials,
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
import { hashIntakeKey } from "../services/intake-credentials.js";
import {
  mkProject,
  newSession,
  seedTenant,
  type Tenant,
} from "../../test/tenants.js";

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

// U1 — per-project intake credentials (plan 2026-11-03). A key is minted from a
// human member session, shown once, and can only be revoked inside its own
// workspace. Nothing after mint may carry key material.
describe("intake credentials", () => {
  let A: Tenant;
  let B: Tenant;
  let projectA: { id: string };
  let memberCookie: string;
  let ownerCookie: string;
  let bAdminCookie: string;

  beforeAll(async () => {
    A = await seedTenant("icred-a", "ICA");
    B = await seedTenant("icred-b", "ICB");
    projectA = await mkProject(A);
    memberCookie = `tly_session=${await newSession(A, "member")}`;
    ownerCookie = `tly_session=${await newSession(A, "owner")}`;
    bAdminCookie = `tly_session=${await newSession(B, "admin")}`;
  });

  const call = async (
    path: string,
    init: { method?: string; cookie?: string; bearer?: string; body?: unknown } = {},
  ) => {
    const res = await app.fetch(
      new Request(`http://api.test${path}`, {
        method: init.method ?? "GET",
        headers: {
          "content-type": "application/json",
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  const credsPath = (t: Tenant) =>
    `/v1/workspaces/${t.ws.slug}/intake-credentials`;

  const mint = (cookie = memberCookie, t = A, body: Record<string, unknown> = {}) =>
    call(credsPath(t), {
      method: "POST",
      cookie,
      body: { projectId: projectA.id, label: "web-checkout", ...body },
    });

  it("mints tlintake_… once, stores only the hash, and never repeats the key", async () => {
    const minted = await mint(memberCookie, A, { teamId: A.team.id });
    expect(minted.status).toBe(201);
    const key = minted.body.key as string;
    expect(key).toMatch(/^tlintake_[A-Za-z0-9_-]{32}$/);
    expect(minted.body.keyLast4).toBe(key.slice(-4));
    expect(minted.body.projectId).toBe(projectA.id);
    expect(minted.body.teamId).toBe(A.team.id);

    // a project with no team leaves the credential unscoped — ingest falls
    // back to the workspace's default team (U2)
    expect((await mint()).body.teamId).toBeNull();

    // the row holds the hash, not the plaintext
    const [row] = await db
      .select()
      .from(intakeCredentials)
      .where(eq(intakeCredentials.id, minted.body.id as string));
    expect(row!.keyHash).toBe(hashIntakeKey(key));
    expect(row!.keyHash).not.toContain(key);
    expect(row!.keyLast4).toBe(key.slice(-4));

    const list = await call(credsPath(A), { cookie: memberCookie });
    expect(list.status).toBe(200);
    const rows = list.body.credentials as Record<string, unknown>[];
    const shown = rows.find((r) => r.id === minted.body.id);
    expect(shown).toMatchObject({ label: "web-checkout", revokedAt: null });
    // the list is not a second reveal and carries no hash
    expect(shown).not.toHaveProperty("key");
    expect(shown).not.toHaveProperty("keyHash");
    expect(shown).not.toHaveProperty("hash");
    expect(list.text).not.toContain(key);
    expect(list.text).not.toContain(row!.keyHash);
  });

  it("requires a member session: a foreign admin, an agent key and a PAT are refused", async () => {
    const foreign = await mint(bAdminCookie, A);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toMatchObject({ code: "FORBIDDEN_WORKSPACE" });

    const asAgent = await call(credsPath(A), {
      method: "POST",
      bearer: A.agentKeys.write,
      body: { projectId: projectA.id, label: "agent" },
    });
    expect(asAgent.status).toBe(403);
    expect(asAgent.text).toContain("FORBIDDEN_AGENT");

    const asPat = await call(credsPath(A), {
      method: "POST",
      bearer: A.pats.write,
      body: { projectId: projectA.id, label: "pat" },
    });
    expect(asPat.status).toBe(403);

    // listing is gated the same way
    expect((await call(credsPath(A), { bearer: A.agentKeys.read })).status).toBe(403);
    expect((await call(credsPath(A), { cookie: bAdminCookie })).status).toBe(403);

    // an owner is a member too
    const owned = await mint(ownerCookie, A);
    expect(owned.status).toBe(201);
  });

  it("rejects a project from another workspace", async () => {
    const res = await mint(memberCookie, A, { projectId: (await mkProject(B)).id });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("revoke is idempotent and keeps the first revokedAt", async () => {
    const minted = await mint();
    const id = minted.body.id as string;
    const first = await call(`${credsPath(A)}/${id}`, {
      method: "DELETE",
      cookie: memberCookie,
    });
    expect(first.status).toBe(200);
    const revokedAt = (first.body.credential as { revokedAt: string }).revokedAt;
    expect(revokedAt).toBeTruthy();

    const second = await call(`${credsPath(A)}/${id}`, {
      method: "DELETE",
      cookie: ownerCookie,
    });
    expect(second.status).toBe(200);
    expect((second.body.credential as { revokedAt: string }).revokedAt).toBe(revokedAt);

    const list = await call(credsPath(A), { cookie: memberCookie });
    const shown = (list.body.credentials as { id: string; revokedAt: string }[]).find(
      (r) => r.id === id,
    );
    expect(shown!.revokedAt).toBe(revokedAt);
  });

  it("another workspace's credential id is 404 and leaves it unrevoked", async () => {
    const minted = await mint();
    const id = minted.body.id as string;
    const foreign = await call(`${credsPath(B)}/${id}`, {
      method: "DELETE",
      cookie: bAdminCookie,
    });
    expect(foreign.status).toBe(404);

    const list = await call(credsPath(A), { cookie: memberCookie });
    const shown = (list.body.credentials as { id: string; revokedAt: string | null }[]).find(
      (r) => r.id === id,
    );
    expect(shown!.revokedAt).toBeNull();
  });
});
