import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import {
  agents,
  comments,
  cycles,
  events,
  githubInstallations,
  githubRepos,
  issues,
  oauthGrants,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { app } from "../index.js";
import { hashPassword } from "../services/auth.js";
import { clearDevInbox } from "../services/mailer.js";
import { settleBackground } from "../services/background.js";
import { sweepExpiredCycles } from "../services/cycles.js";
import { sweepDeliveries } from "../services/outbound.js";
import { createAuthRequest, registerClient, RESOURCE } from "../services/mcp-oauth.js";
import { issueAccountToken, RESET_TTL_MS } from "../services/account.js";
import { devInbox } from "../services/mailer.js";
import { createSession } from "../services/auth.js";
import { mkIssue, mkMember, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// Adversarial-review fixes for the account lifecycle PR (#111).

async function req(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string } = {},
) {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.cookie ? { cookie: `dok_session=${init.cookie}` } : {}),
        ...(init.headers ?? {}),
      },
      ...(init.raw !== undefined
        ? { body: init.raw }
        : init.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
    }),
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: res.status, body, text };
}
const code = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { code?: string } | undefined)?.code;

let A: Tenant;
let B: Tenant;
beforeAll(async () => {
  A = await seedTenant("rva", "RVA");
  B = await seedTenant("rvb", "RVB");
});
afterEach(() => {
  clearDevInbox();
});

async function newUser(label: string, verified = true) {
  const [u] = await db
    .insert(users)
    .values({
      email: `${label}-${randomBytes(4).toString("hex")}@review.test`,
      name: label,
      passwordHash: hashPassword("password-1234"),
      ...(verified ? {} : { emailVerifiedAt: null }),
    })
    .returning();
  return u!;
}

// ── blocker 1: personal export tenancy ───────────────────────────────────────

describe("review: personal export never carries rows from workspaces the user left", () => {
  it("export_excludes_workspaces_user_was_removed_from", async () => {
    const m = await newUser("leaver");
    await db.insert(workspaceMembers).values([
      { workspaceId: A.ws.id, userId: m.id, role: "member" },
      { workspaceId: B.ws.id, userId: m.id, role: "member" },
    ]);
    const inA = await mkIssue(A, { creatorType: "human", creatorId: m.id, title: "Alpha visible title" });
    const inB = await mkIssue(B, {
      creatorType: "human",
      creatorId: m.id,
      assigneeType: "human",
      assigneeId: m.id,
      title: "Beta secret title",
      description: "Beta secret description",
      state: "in_progress",
    });
    await db.insert(comments).values({
      workspaceId: B.ws.id,
      issueId: inB.id,
      actorType: "human",
      actorId: m.id,
      body: "Beta secret comment",
    });
    await db.insert(events).values({
      workspaceId: B.ws.id,
      entityType: "issue",
      entityId: inB.id,
      action: "beta_secret_action",
      actorType: "human",
      actorId: m.id,
    });
    // someone removes m from B
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, B.ws.id), eq(workspaceMembers.userId, m.id)));
    const cookie = await createSession(m.id, A.ws.id);
    const r = await req("/v1/me/export", { cookie });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Alpha visible title");
    expect(r.text).toContain(inA.id);
    expect(r.text).not.toContain("Beta secret title");
    expect(r.text).not.toContain("Beta secret description");
    expect(r.text).not.toContain("Beta secret comment");
    expect(r.text).not.toContain("beta_secret_action");
    expect(r.text).not.toContain("in_progress");
    expect(r.text).not.toContain(inB.id);
    expect(r.text).not.toContain(B.sentinel);
  });

  it("export_excludes_soft_deleted_workspaces", async () => {
    const m = await newUser("softdel");
    await db.insert(workspaceMembers).values({ workspaceId: B.ws.id, userId: m.id, role: "member" });
    await mkIssue(B, { creatorType: "human", creatorId: m.id, title: "Pending deletion title" });
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, B.ws.id));
    try {
      const r = await req("/v1/me/export", { cookie: await createSession(m.id, A.ws.id) });
      expect(r.text).not.toContain("Pending deletion title");
    } finally {
      await db.update(workspaces).set({ deletedAt: null }).where(eq(workspaces.id, B.ws.id));
    }
  });
});

// ── blocker 2 + consent: verification gate, soft-deleted workspace ───────────

async function consentRequest() {
  const reg = await registerClient({ client_name: "Review Client", redirect_uris: ["https://client.test/cb"] });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return createAuthRequest({
    clientId: reg.client_id,
    redirectUri: "https://client.test/cb",
    scopes: ["read", "write"],
    state: "s",
    codeChallenge: challenge,
    resource: RESOURCE,
  });
}

async function openConsent(requestId: string, cookie: string) {
  const v = await req(`/v1/oauth/consent/${requestId}`, { cookie });
  expect(v.status).toBe(200);
  return v.body as { csrf: string; emailVerified?: boolean; unavailableReason?: string | null };
}

async function mcpRows(userId: string, workspaceId: string) {
  const grants = await db.select().from(oauthGrants).where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.workspaceId, workspaceId)));
  const ags = await db.select().from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.harness, "mcp-connector")));
  return { grants: grants.length, agents: ags.length };
}

describe("review: MCP consent", () => {
  it("consent_refuses_unverified_email", async () => {
    const u = await newUser("unverified", false);
    await db.insert(workspaceMembers).values({ workspaceId: A.ws.id, userId: u.id, role: "member" });
    const cookie = await createSession(u.id, A.ws.id);
    const requestId = await consentRequest();
    const view = await openConsent(requestId, cookie);
    expect(view.emailVerified).toBe(false);
    const before = await mcpRows(u.id, A.ws.id);
    const d = await req(`/v1/oauth/consent/${requestId}`, {
      method: "POST",
      cookie,
      body: { csrf: view.csrf, approve: true, workspace: A.ws.slug },
    });
    expect(d.status).toBe(403);
    expect(code(d)).toBe("EMAIL_UNVERIFIED");
    expect(await mcpRows(u.id, A.ws.id)).toEqual(before);
  });

  it("consent_refuses_soft_deleted_workspace_and_writes_nothing", async () => {
    const u = await newUser("consenter");
    await db.insert(workspaceMembers).values({ workspaceId: B.ws.id, userId: u.id, role: "member" });
    const cookie = await createSession(u.id, B.ws.id);
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, B.ws.id));
    try {
      const requestId = await consentRequest();
      const view = await openConsent(requestId, cookie);
      const before = await mcpRows(u.id, B.ws.id);
      const d = await req(`/v1/oauth/consent/${requestId}`, {
        method: "POST",
        cookie,
        body: { csrf: view.csrf, approve: true, workspace: B.ws.slug },
      });
      expect(d.status).toBe(410);
      expect(await mcpRows(u.id, B.ws.id)).toEqual(before);
    } finally {
      await db.update(workspaces).set({ deletedAt: null }).where(eq(workspaces.id, B.ws.id));
    }
  });
});

// ── account deletion ─────────────────────────────────────────────────────────

describe("review: account deletion", () => {
  it("sole_owner_of_pending_deletion_workspace_cannot_delete_account", async () => {
    const t = await seedTenant("pend", "PND");
    const owner = await newSession(t, "owner");
    await req(`/v1/workspaces/${t.ws.slug}/deletion`, { method: "POST", cookie: owner, body: { confirm: t.ws.slug } });
    const r = await req("/v1/me/deletion", { method: "POST", cookie: owner, body: { confirm: t.people.owner.email } });
    expect(r.status).toBe(409);
    expect(code(r)).toBe("SOLE_OWNER");
    expect(String((r.body.error as { message: string }).message)).toMatch(/restore|purge/i);
    expect(await db.select().from(users).where(eq(users.id, t.people.owner.id))).toHaveLength(1);
  });

  it("sole_owner_message_lists_names_not_slugs", async () => {
    const t = await seedTenant("nm", "NMS");
    const owner = await newSession(t, "owner");
    const r = await req("/v1/me/deletion", { method: "POST", cookie: owner, body: { confirm: t.people.owner.email } });
    expect(r.status).toBe(409);
    const msg = String((r.body.error as { message: string }).message);
    expect(msg).toContain(`Tenant ${t.sentinel}`);
    expect(msg).not.toContain(t.ws.slug);
  });

  it("concurrent_co_owner_deletions_never_orphan_a_workspace", async () => {
    for (let round = 0; round < 6; round++) {
      const t = await seedTenant(`cc${round}`, `CC${round}`);
      // owner + one extra owner = exactly two owners
      const second = await mkMember(t, "owner");
      const c1 = await newSession(t, "owner");
      const c2 = await createSession(second.userId, t.ws.id);
      const [row2] = await db.select({ email: users.email }).from(users).where(eq(users.id, second.userId));
      const e2 = row2!.email;
      const results = await Promise.all([
        req("/v1/me/deletion", { method: "POST", cookie: c1, body: { confirm: t.people.owner.email } }),
        req("/v1/me/deletion", { method: "POST", cookie: c2, body: { confirm: e2 } }),
      ]);
      const owners = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, t.ws.id), eq(workspaceMembers.role, "owner")));
      expect(owners.length, `round ${round}: statuses ${results.map((x) => x.status)}`).toBeGreaterThanOrEqual(1);
      expect(results.filter((x) => x.status === 200)).toHaveLength(1);
      expect(results.filter((x) => x.status === 409)).toHaveLength(1);
    }
  });
});

// ── webhooks and sweeps skip soft-deleted workspaces ─────────────────────────

describe("review: soft-deleted workspaces are inert", () => {
  it("github_webhook_skips_soft_deleted_workspace", async () => {
    const t = await seedTenant("gh", "GHD");
    const installationId = 7_000_000 + Math.floor(Math.random() * 1000);
    await db.insert(githubInstallations).values({ workspaceId: t.ws.id, installationId, accountLogin: "acme" });
    const fullName = `acme/${t.ws.slug}`;
    await db.insert(githubRepos).values({
      workspaceId: t.ws.id,
      installationId,
      repoId: installationId,
      fullName,
      enabled: true,
      teamId: t.team.id,
    });
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, t.ws.id));
    const body = JSON.stringify({
      action: "opened",
      installation: { id: installationId },
      repository: { id: installationId, full_name: fullName },
      issue: { id: 1, number: 1, title: "from github", body: "x", html_url: "https://github.com/x/y/issues/1", state: "open" },
    });
    const res = await app.fetch(
      new Request("http://api.test/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "test-webhook-secret").update(body, "utf8").digest("hex")}`,
          "x-github-event": "issues",
          "x-github-delivery": `rv-${randomBytes(4).toString("hex")}`,
        },
        body,
      }),
    );
    expect(res.status).toBe(200);
    await settleBackground();
    const rows = await db.select().from(issues).where(eq(issues.workspaceId, t.ws.id));
    expect(rows.filter((i) => i.title === "from github")).toHaveLength(0);
  });

  it("cycle_sweep_skips_soft_deleted_workspace", async () => {
    const t = await seedTenant("cy", "CYD");
    const [c] = await db
      .insert(cycles)
      .values({
        workspaceId: t.ws.id,
        teamId: t.team.id,
        number: 1,
        startsAt: new Date(Date.now() - 3 * 86_400_000),
        endsAt: new Date(Date.now() - 86_400_000),
        isActive: true,
      })
      .returning();
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, t.ws.id));
    await sweepExpiredCycles();
    const [after] = await db.select().from(cycles).where(eq(cycles.id, c!.id));
    expect(after!.isActive).toBe(true);
  });

  it("delivery_sweep_skips_soft_deleted_workspace", async () => {
    const t = await seedTenant("dl", "DLD");
    const [ep] = await db
      .insert(webhookEndpoints)
      .values({ workspaceId: t.ws.id, url: "http://127.0.0.1:1/never", secret: "s", events: ["*"], enabled: true })
      .returning();
    const [d] = await db
      .insert(webhookDeliveries)
      .values({
        workspaceId: t.ws.id,
        endpointId: ep!.id,
        action: "issue.created",
        payload: {},
        nextAttemptAt: new Date(Date.now() - 1000),
      })
      .returning();
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, t.ws.id));
    await sweepDeliveries();
    const [after] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, d!.id));
    expect(after!.attempts).toBe(0);
  });
});

// ── reset token vs email change ──────────────────────────────────────────────

describe("review: reset token is bound to the email it was issued for", () => {
  it("reset_token_invalid_after_email_change", async () => {
    const u = await newUser("emailchg");
    const token = await issueAccountToken(u.id, u.email, "password_reset", RESET_TTL_MS);
    await db.update(users).set({ email: `changed-${u.email}` }).where(eq(users.id, u.id));
    const r = await req("/v1/auth/password/reset", {
      method: "POST",
      body: { token, password: "a-brand-new-password" },
    });
    expect(r.status).toBe(400);
    expect(code(r)).toBe("RESET_TOKEN_INVALID");
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after!.passwordHash).toBe(u.passwordHash);
  });
});

// ── dev inbox in production ──────────────────────────────────────────────────

describe("review: dev inbox", () => {
  it("dev_mail_is_404_in_production_even_for_admins_and_members", async () => {
    const admin = await newSession(A, "owner");
    const member = await newSession(A, "member");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect((await req("/v1/dev/mail", { cookie: admin })).status).toBe(404);
      expect((await req("/v1/dev/mail", { cookie: member })).status).toBe(404);
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(devInbox()).toEqual([]);
  });
});
