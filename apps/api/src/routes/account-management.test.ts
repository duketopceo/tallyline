import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import {
  auditEvents,
  events,
  sessions,
  users,
  userTokens,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { app } from "../index.js";
import { settleBackground } from "../services/background.js";
import { createSession, verifyPassword } from "../services/auth.js";
import { clearDevInbox, devInbox } from "../services/mailer.js";
import { createUserToken, hashToken } from "../services/tokens.js";
import { mkMember, newSession, PASSWORD, seedTenant, type Tenant } from "../../test/tenants.js";

// Account management gaps: profile edit, password change, workspace rename,
// leaving a workspace, and the audit trail for credential mutations. Real
// Postgres throughout; every denial is checked against a real second tenant.

async function req(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {},
) {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.cookie ? { cookie: `tly_session=${init.cookie}` } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
  A = await seedTenant("mgmt-a", "MGA");
  B = await seedTenant("mgmt-b", "MGB");
});

async function userRow(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u!;
}

async function wsEvents(workspaceId: string, action: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.action, action)));
}

describe("profile: PATCH /v1/me", () => {
  it("edits the name and avatar of the signed-in person and audits field names only", async () => {
    const cookie = await newSession(A, "member");
    const r = await req("/v1/me", {
      method: "PATCH",
      cookie,
      body: { name: "  Renamed Person  ", avatarUrl: "https://img.example.test/a.png" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ name: "Renamed Person", avatarUrl: "https://img.example.test/a.png" });
    const u = await userRow(A.people.member.id);
    expect(u.name).toBe("Renamed Person");
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.userId, A.people.member.id));
    const row = audit.find((a) => a.action === "profile_updated")!;
    expect(row.meta).toEqual({ fields: ["name", "avatarUrl"] });
    expect(JSON.stringify(row)).not.toContain("Renamed Person");
    // clearing the avatar
    const cleared = await req("/v1/me", { method: "PATCH", cookie, body: { avatarUrl: null } });
    expect(cleared.status).toBe(200);
    expect((await userRow(A.people.member.id)).avatarUrl).toBeNull();
  });

  it("rejects blank names, non-https avatars and empty bodies", async () => {
    const cookie = await newSession(A, "member");
    for (const body of [{ name: "   " }, { avatarUrl: "http://img.example.test/a.png" }, { avatarUrl: "javascript:alert(1)" }, {}]) {
      const r = await req("/v1/me", { method: "PATCH", cookie, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("never touches another person: tenant B's owner keeps their name", async () => {
    const before = (await userRow(B.people.owner.id)).name;
    const cookie = await newSession(A, "owner");
    await req("/v1/me", { method: "PATCH", cookie, body: { name: "Only Me" } });
    expect((await userRow(B.people.owner.id)).name).toBe(before);
  });

  it("refuses anonymous callers, PATs and agent keys", async () => {
    expect((await req("/v1/me", { method: "PATCH", body: { name: "x" } })).status).toBe(401);
    expect((await req("/v1/me", { method: "PATCH", bearer: A.pats.write, body: { name: "x" } })).status).toBe(403);
    expect((await req("/v1/me", { method: "PATCH", bearer: A.agentKeys.write, body: { name: "x" } })).status).toBe(403);
  });
});

describe("password: POST /v1/me/password", () => {
  const NEW = "a-brand-new-long-password";

  it("changes the password, keeps this session, signs the others out, audits and mails", async () => {
    const t = await seedTenant("pw", "PWA");
    const mine = await newSession(t, "member");
    const other = await newSession(t, "member");
    clearDevInbox();
    const r = await req("/v1/me/password", {
      method: "POST",
      cookie: mine,
      body: { currentPassword: PASSWORD, newPassword: NEW },
    });
    expect(r.status).toBe(200);
    expect(r.body.sessionsRevoked).toBe(1);
    const u = await userRow(t.people.member.id);
    expect(verifyPassword(NEW, u.passwordHash!)).toBe(true);
    expect(verifyPassword(PASSWORD, u.passwordHash!)).toBe(false);
    expect((await req("/v1/auth/me", { cookie: mine })).status).toBe(200);
    expect((await req("/v1/auth/me", { cookie: other })).status).toBe(401);
    const login = await req("/v1/auth/login", {
      method: "POST",
      body: { email: t.people.member.email, password: NEW },
    });
    expect(login.status).toBe(200);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.userId, t.people.member.id));
    expect(audit.map((a) => a.action)).toContain("password_changed");
    expect(JSON.stringify(audit)).not.toContain(NEW);
    await settleBackground();
    const mail = devInbox().filter((m) => m.to === t.people.member.email && m.kind === "password_changed");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).not.toContain(NEW);
    // PATs stay valid, like after a reset
    expect((await req("/v1/auth/me", { bearer: t.pats.write })).status).toBe(200);
  });

  it("refuses a wrong current password and leaves the hash alone", async () => {
    const cookie = await newSession(A, "admin");
    const before = (await userRow(A.people.admin.id)).passwordHash;
    const r = await req("/v1/me/password", {
      method: "POST",
      cookie,
      body: { currentPassword: "definitely-not-it", newPassword: NEW },
    });
    expect(r.status).toBe(400);
    expect(code(r)).toBe("CURRENT_PASSWORD_INVALID");
    expect((await userRow(A.people.admin.id)).passwordHash).toBe(before);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.userId, A.people.admin.id));
    expect(audit.map((a) => a.action)).toContain("password_change_refused");
  });

  it("refuses a reused password, a short one, and an account with no password", async () => {
    const cookie = await newSession(A, "owner");
    const same = await req("/v1/me/password", {
      method: "POST",
      cookie,
      body: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });
    expect(code(same)).toBe("SAME_PASSWORD");
    const short = await req("/v1/me/password", {
      method: "POST",
      cookie,
      body: { currentPassword: PASSWORD, newPassword: "short" },
    });
    expect(short.status).toBe(400);
    const sso = await mkMember(A, "member"); // passwordHash null
    const ssoCookie = await createSession(sso.userId, A.ws.id);
    const none = await req("/v1/me/password", {
      method: "POST",
      cookie: ssoCookie,
      body: { currentPassword: "anything-at-all", newPassword: NEW },
    });
    expect(none.status).toBe(409);
    expect(code(none)).toBe("NO_PASSWORD");
  });

  it("refuses anonymous callers, PATs and agent keys", async () => {
    const body = { currentPassword: PASSWORD, newPassword: NEW };
    expect((await req("/v1/me/password", { method: "POST", body })).status).toBe(401);
    expect((await req("/v1/me/password", { method: "POST", bearer: A.pats.write, body })).status).toBe(403);
    expect((await req("/v1/me/password", { method: "POST", bearer: A.agentKeys.write, body })).status).toBe(403);
  });
});

describe("workspace rename: PATCH /v1/workspaces/:ws", () => {
  it("lets an admin rename but not re-slug, and audits the change", async () => {
    const t = await seedTenant("rn1", "RNA");
    const admin = await newSession(t, "admin");
    const name = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", cookie: admin, body: { name: "Acme HQ" } });
    expect(name.status).toBe(200);
    const slug = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", cookie: admin, body: { slug: "acme-hq-admin" } });
    expect(slug.status).toBe(403);
    expect(code(slug)).toBe("FORBIDDEN_ROLE");
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, t.ws.id));
    expect(row!.slug).toBe(t.ws.slug);
    expect(row!.name).toBe("Acme HQ");
    const ev = await wsEvents(t.ws.id, "workspace_updated");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actorId).toBe(t.people.admin.id);
  });

  it("lets an owner re-slug; the old slug stops resolving and the audit row records both", async () => {
    const t = await seedTenant("rn2", "RNB");
    const owner = await newSession(t, "owner");
    const next = `renamed-${t.ws.slug}`;
    const r = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", cookie: owner, body: { slug: next } });
    expect(r.status).toBe(200);
    expect(r.body.slug).toBe(next);
    expect((await req(`/v1/workspaces/${next}`, { cookie: owner })).status).toBe(200);
    expect((await req(`/v1/workspaces/${t.ws.slug}`, { cookie: owner })).status).not.toBe(200);
    const [ev] = await wsEvents(t.ws.id, "workspace_updated");
    expect(ev!.before).toMatchObject({ slug: t.ws.slug });
    expect(ev!.after).toMatchObject({ slug: next });
  });

  it("refuses a slug another tenant holds and malformed slugs", async () => {
    const t = await seedTenant("rn3", "RNC");
    const owner = await newSession(t, "owner");
    const taken = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", cookie: owner, body: { slug: B.ws.slug } });
    expect(taken.status).toBe(409);
    expect(code(taken)).toBe("SLUG_TAKEN");
    for (const slug of ["Bad Slug!", "x", "UPPER"]) {
      const bad = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", cookie: owner, body: { slug } });
      expect(bad.status, slug).toBe(400);
    }
    const [b] = await db.select().from(workspaces).where(eq(workspaces.id, B.ws.id));
    expect(b!.slug).toBe(B.ws.slug);
  });

  it("keeps tenants apart: another tenant's owner cannot rename or re-slug it", async () => {
    const t = await seedTenant("rn4", "RND");
    const outsider = await newSession(B, "owner");
    const r = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", cookie: outsider, body: { slug: "stolen-slug" } });
    expect(r.status).toBe(403);
    expect(code(r)).toBe("FORBIDDEN_WORKSPACE");
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, t.ws.id));
    expect(row!.slug).toBe(t.ws.slug);
    expect(await wsEvents(t.ws.id, "workspace_updated")).toHaveLength(0);
  });

  it("answers 409, not 500, when two renames race for the same slug", async () => {
    const t = await seedTenant("rn6", "RNF");
    const o = await seedTenant("rn6o", "RNG");
    const want = `contested-${t.ws.slug}`;
    const [r1, r2] = await Promise.all([
      req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", cookie: await newSession(t, "owner"), body: { slug: want } }),
      req(`/v1/workspaces/${o.ws.slug}`, { method: "PATCH", cookie: await newSession(o, "owner"), body: { slug: want } }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });

  it("keeps slug changes human-only: an owner's PAT can rename but not re-slug", async () => {
    const t = await seedTenant("rn7", "RNH");
    const name = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", bearer: t.pats.write, body: { name: "Via PAT" } });
    expect(name.status).toBe(200);
    const slug = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", bearer: t.pats.write, body: { slug: `pat-${t.ws.slug}` } });
    expect(slug.status).toBe(403);
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, t.ws.id));
    expect(row!.slug).toBe(t.ws.slug);
  });

  it("refuses members", async () => {
    const t = await seedTenant("rn5", "RNE");
    const member = await newSession(t, "member");
    const r = await req(`/v1/workspaces/${t.ws.slug}`, { method: "PATCH", cookie: member, body: { name: "Nope" } });
    expect(r.status).toBe(403);
  });
});

describe("leave: POST /v1/workspaces/:ws/leave", () => {
  async function twoWorkspaceMember(t: Tenant, other: Tenant, role: "member" | "admin" | "owner" = "member") {
    const m = await mkMember(t, role);
    await db.insert(workspaceMembers).values({ workspaceId: other.ws.id, userId: m.userId, role: "member" });
    const cookie = await createSession(m.userId, t.ws.id);
    return { userId: m.userId, cookie };
  }

  it("removes the member, revokes their PATs there, rebinds sessions, audits, and spares the other workspace", async () => {
    const t = await seedTenant("lv1", "LVA");
    const o = await seedTenant("lv1o", "LVB");
    const { userId, cookie } = await twoWorkspaceMember(t, o);
    const pat = await createUserToken(userId, t.ws.id, "leaving", ["read"]);
    const keep = await createUserToken(userId, o.ws.id, "staying", ["read"]);
    const r = await req(`/v1/workspaces/${t.ws.slug}/leave`, {
      method: "POST",
      cookie,
      body: { confirm: t.ws.slug },
    });
    expect(r.status).toBe(200);
    expect(r.body.nextWorkspaceSlug).toBe(o.ws.slug);
    const left = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, t.ws.id)));
    expect(left).toHaveLength(0);
    const stay = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, o.ws.id)));
    expect(stay).toHaveLength(1);
    const toks = await db.select().from(userTokens).where(eq(userTokens.userId, userId));
    expect(toks.map((x) => x.id)).toEqual([keep.id]);
    expect(toks.some((x) => x.tokenHash === hashToken(pat.token))).toBe(false);
    const [s] = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(s!.workspaceId).toBe(o.ws.id);
    expect((await req(`/v1/workspaces/${t.ws.slug}/members`, { cookie })).status).toBe(403);
    const ev = await wsEvents(t.ws.id, "member_left");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.after).toMatchObject({ self: true, role: "member" });
    expect(await wsEvents(o.ws.id, "member_left")).toHaveLength(0);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.userId, userId));
    expect(audit.map((a) => a.action)).toContain("workspace_left");
  });

  it("needs the slug typed exactly", async () => {
    const t = await seedTenant("lv2", "LVC");
    const o = await seedTenant("lv2o", "LVD");
    const { userId, cookie } = await twoWorkspaceMember(t, o);
    const r = await req(`/v1/workspaces/${t.ws.slug}/leave`, { method: "POST", cookie, body: { confirm: "wrong" } });
    expect(r.status).toBe(400);
    expect(code(r)).toBe("CONFIRM_MISMATCH");
    expect(await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, t.ws.id)))).toHaveLength(1);
  });

  it("refuses to strand someone in no workspace", async () => {
    const t = await seedTenant("lv3", "LVE");
    const cookie = await newSession(t, "member");
    const r = await req(`/v1/workspaces/${t.ws.slug}/leave`, { method: "POST", cookie, body: { confirm: t.ws.slug } });
    expect(r.status).toBe(409);
    expect(code(r)).toBe("LAST_WORKSPACE");
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, t.people.member.id))).toHaveLength(1);
  });

  it("never orphans a workspace: the last owner is refused, a co-owner may leave", async () => {
    const t = await seedTenant("lv4", "LVF");
    const o = await seedTenant("lv4o", "LVG");
    await db.insert(workspaceMembers).values({ workspaceId: o.ws.id, userId: t.people.owner.id, role: "member" });
    const ownerCookie = await newSession(t, "owner");
    const refused = await req(`/v1/workspaces/${t.ws.slug}/leave`, { method: "POST", cookie: ownerCookie, body: { confirm: t.ws.slug } });
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe("LAST_OWNER");
    // a second owner makes the first one's exit safe
    const co = await twoWorkspaceMember(t, o, "owner");
    const ok = await req(`/v1/workspaces/${t.ws.slug}/leave`, { method: "POST", cookie: co.cookie, body: { confirm: t.ws.slug } });
    expect(ok.status).toBe(200);
    const owners = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, t.ws.id), eq(workspaceMembers.role, "owner")));
    expect(owners.map((x) => x.userId)).toEqual([t.people.owner.id]);
  });

  it("a person outside the workspace cannot leave it for someone else, and tenants stay intact", async () => {
    const t = await seedTenant("lv5", "LVH");
    const outsider = await newSession(B, "owner");
    const r = await req(`/v1/workspaces/${t.ws.slug}/leave`, { method: "POST", cookie: outsider, body: { confirm: t.ws.slug } });
    expect(r.status).toBe(403);
    expect(code(r)).toBe("FORBIDDEN_WORKSPACE");
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, t.ws.id))).toHaveLength(3);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, B.people.owner.id))).toHaveLength(1);
  });

  it("does not land a leaver in a workspace pending deletion", async () => {
    const t = await seedTenant("lv6", "LVI");
    const o = await seedTenant("lv6o", "LVJ");
    const { userId, cookie } = await twoWorkspaceMember(t, o);
    await db.update(workspaces).set({ deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000) }).where(eq(workspaces.id, o.ws.id));
    const r = await req(`/v1/workspaces/${t.ws.slug}/leave`, { method: "POST", cookie, body: { confirm: t.ws.slug } });
    expect(r.status).toBe(409);
    expect(code(r)).toBe("LAST_WORKSPACE");
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId))).toHaveLength(2);
  });

  it("serializes concurrent leaves: a person in two workspaces keeps one", async () => {
    const t = await seedTenant("lv7", "LVK");
    const o = await seedTenant("lv7o", "LVL");
    const { userId, cookie } = await twoWorkspaceMember(t, o);
    const [r1, r2] = await Promise.all([
      req(`/v1/workspaces/${t.ws.slug}/leave`, { method: "POST", cookie, body: { confirm: t.ws.slug } }),
      req(`/v1/workspaces/${o.ws.slug}/leave`, { method: "POST", cookie, body: { confirm: o.ws.slug } }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId))).toHaveLength(1);
  });

  it("refuses anonymous callers, PATs and agent keys", async () => {
    const body = { confirm: A.ws.slug };
    expect((await req(`/v1/workspaces/${A.ws.slug}/leave`, { method: "POST", body })).status).toBe(401);
    expect((await req(`/v1/workspaces/${A.ws.slug}/leave`, { method: "POST", bearer: A.pats.write, body })).status).toBe(403);
    expect((await req(`/v1/workspaces/${A.ws.slug}/leave`, { method: "POST", bearer: A.agentKeys.write, body })).status).toBe(403);
  });
});

describe("credential audit trail", () => {
  it("writes tenant-scoped events for PAT create and revoke without the secret", async () => {
    const t = await seedTenant("au1", "AUA");
    const cookie = await newSession(t, "admin");
    const made = await req(`/v1/workspaces/${t.ws.slug}/tokens`, {
      method: "POST",
      cookie,
      body: { name: "ci", scopes: ["read"] },
    });
    expect(made.status).toBe(201);
    const secret = made.body.token as string;
    const id = made.body.id as string;
    // only the hash is stored, and the list never returns the secret
    const [row] = await db.select().from(userTokens).where(eq(userTokens.id, id));
    expect(row!.tokenHash).toBe(hashToken(secret));
    expect(row!.tokenHash).not.toBe(secret);
    const list = await req(`/v1/workspaces/${t.ws.slug}/tokens`, { cookie });
    expect(list.text).not.toContain(secret);
    expect(list.text).not.toContain(row!.tokenHash);

    const del = await req(`/v1/workspaces/${t.ws.slug}/tokens/${id}`, { method: "DELETE", cookie });
    expect(del.status).toBe(200);
    const created = await wsEvents(t.ws.id, "token_created");
    const revoked = await wsEvents(t.ws.id, "token_revoked");
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    expect(created[0]).toMatchObject({ entityId: id, actorId: t.people.admin.id });
    expect(JSON.stringify([created, revoked])).not.toContain(secret);
    // none of it leaked into another tenant
    expect(await wsEvents(B.ws.id, "token_created")).toHaveLength(0);
    expect(await wsEvents(B.ws.id, "token_revoked")).toHaveLength(0);
  });

  it("does not let tenant B revoke or see tenant A's token, and writes no event for the attempt", async () => {
    const t = await seedTenant("au2", "AUB");
    const owner = await newSession(t, "owner");
    const made = await req(`/v1/workspaces/${t.ws.slug}/tokens`, { method: "POST", cookie: owner, body: { name: "mine" } });
    const id = made.body.id as string;
    const outsider = await newSession(B, "owner");
    const r = await req(`/v1/workspaces/${t.ws.slug}/tokens/${id}`, { method: "DELETE", cookie: outsider });
    expect(r.status).toBe(403);
    expect((await db.select().from(userTokens).where(eq(userTokens.id, id))).length).toBe(1);
    expect(await wsEvents(t.ws.id, "token_revoked")).toHaveLength(0);
  });

  it("writes an agent_key_created event with scopes and no key", async () => {
    const t = await seedTenant("au3", "AUC");
    const cookie = await newSession(t, "owner");
    const r = await req(`/v1/workspaces/${t.ws.slug}/agents/${t.agent.id}/keys`, {
      method: "POST",
      cookie,
      body: { name: "seat", scopes: ["read", "write"] },
    });
    expect(r.status).toBe(201);
    const ev = await wsEvents(t.ws.id, "agent_key_created");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ entityType: "agent_key", entityId: r.body.id, actorId: t.people.owner.id });
    expect(ev[0]!.after).toMatchObject({ name: "seat", scopes: ["read", "write"] });
    expect(JSON.stringify(ev)).not.toContain(r.body.key as string);
    expect(await wsEvents(B.ws.id, "agent_key_created")).toHaveLength(0);
  });
});
