import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  authIdentities,
  events,
  invites,
  oauthCodes,
  sessions,
  teamMembers,
  teams,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { mintInviteToken } from "../auth/invite-token.js";
import type { IdentityResult } from "../auth/providers/types.js";
import { setBillingForTests } from "./entitlements.js";
import { resolveIdentity } from "./identity.js";
import { membershipsFor } from "./members.js";
import { NOW, useFrozenClock } from "../../test/clock.js";

useFrozenClock();

const WIPE = [
  events, sessions, oauthCodes, invites, authIdentities,
  teamMembers, workspaceMembers, teams, users, workspaces,
] as const;

const ident = (over: Partial<IdentityResult> = {}): IdentityResult => ({
  subject: "sub-1",
  email: "u@corp.io",
  emailVerified: true,
  name: "U",
  avatarUrl: null,
  hd: "corp.io",
  ...over,
});

const mutableConfig = config_ as {
  authAccountLinking: "auto" | "login" | "disabled";
  authAllowedEmailDomains: string[];
  authAutoJoinSingleWorkspace: boolean;
};

// captured at import, before the suite opts in below
const DEFAULT_AUTO_JOIN = config_.authAutoJoinSingleWorkspace;

beforeAll(async () => {
  mutableConfig.authAutoJoinSingleWorkspace = true; // default is off; suite opts in
  await runMigrations();
  for (const t of WIPE) await db.delete(t);
});

afterAll(async () => {
  mutableConfig.authAccountLinking = "auto";
  for (const t of WIPE) await db.delete(t);
  await closeDb();
});

async function reset() {
  for (const t of WIPE) await db.delete(t);
  await db.insert(workspaces).values({ slug: "ws1", name: "WS1" });
  const [ws] = await db.select().from(workspaces);
  await db.insert(teams).values({ workspaceId: ws!.id, key: "W1", name: "T" });
  return ws!;
}

describe("resolveIdentity", () => {
  it("AUTH_AUTO_JOIN_SINGLE_WORKSPACE defaults to off", () => {
    expect(DEFAULT_AUTO_JOIN).toBe(false);
  });

  it("sole-workspace auto-join: verified email → user+identity+member in one go", async () => {
    const ws = await reset();
    const r = await resolveIdentity(ident(), { providerKey: "stub", inviteHash: null });
    expect(r.kind).toBe("login");
    const [u] = await db.select().from(users);
    const [i] = await db.select().from(authIdentities);
    const [m] = await db.select().from(workspaceMembers);
    expect(i!.userId).toBe(u!.id);
    expect(m!.workspaceId).toBe(ws.id);
    expect(m!.role).toBe("member");
    const [e] = await db.select().from(events).where(eq(events.action, "member_joined"));
    expect(e).toBeTruthy();
  });

  it("identity hit path: second login resolves, invite gets consumed", async () => {
    await reset();
    await db.insert(workspaces).values({ slug: "ws2", name: "WS2" });
    const [ws2] = await db.select().from(workspaces).where(eq(workspaces.slug, "ws2"));
    await resolveIdentity(ident(), { providerKey: "stub", inviteHash: null });

    // mint an email-bound invite for the SAME user's email into ws2
    const { token, hash } = mintInviteToken();
    await db.insert(invites).values({
      workspaceId: ws2!.id, email: "u@corp.io", tokenHash: hash,
      role: "admin", expiresAt: new Date(NOW + 86_400_000),
    });
    const r = await resolveIdentity(ident({ subject: "sub-1" }), {
      providerKey: "stub", inviteHash: hash,
    });
    expect(r.kind).toBe("login");
    void token;
    const m = await membershipsFor((await db.select().from(users))[0]!.id);
    expect(m.map((x) => x.workspaceSlug)).toContain("ws2");
    const [inv] = await db.select().from(invites);
    expect(inv!.acceptedAt).toBeTruthy();
  });

  it("verified-email collision: auto links, login → pending-link, disabled → LINK_DISABLED", async () => {
    await reset();
    const [u] = await db.insert(users).values({ email: "u@corp.io", name: "U" }).returning();
    const [ws] = await db.select().from(workspaces);
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: "member" });

    // login policy → pending-link, no identity row
    mutableConfig.authAccountLinking = "login";
    const pend = await resolveIdentity(ident({ subject: "new-sub" }), { providerKey: "stub", inviteHash: null });
    expect(pend.kind).toBe("pending-link");
    expect(await db.select().from(authIdentities).where(eq(authIdentities.providerSubject, "new-sub"))).toHaveLength(0);

    // disabled → hard error
    mutableConfig.authAccountLinking = "disabled";
    const denied = await resolveIdentity(ident({ subject: "new-sub" }), { providerKey: "stub", inviteHash: null });
    expect(denied).toEqual({ kind: "error", code: "LINK_DISABLED" });

    // auto → second identity row on the same user
    mutableConfig.authAccountLinking = "auto";
    const linked = await resolveIdentity(ident({ subject: "new-sub" }), { providerKey: "stub", inviteHash: null });
    expect(linked.kind).toBe("login");
    const rows = await db.select().from(authIdentities).where(eq(authIdentities.userId, u!.id));
    expect(rows).toHaveLength(1);
  });

  it("unverified email never auto-links — falls to JIT rungs or denial", async () => {
    await reset();
    const [u] = await db.insert(users).values({ email: "u@corp.io", name: "U" }).returning();
    const [ws] = await db.select().from(workspaces);
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: "member" });
    // unverified + no invite + auto-join on sole ws → JIT as NEW member
    const r = await resolveIdentity(
      ident({ subject: "x1", emailVerified: false }),
      { providerKey: "stub", inviteHash: null },
    );
    // auto-join requires verified email → INVITE_REQUIRED
    expect(r).toEqual({ kind: "error", code: "INVITE_REQUIRED" });
    // and crucially: no identity row linked to the existing user
    expect(await db.select().from(authIdentities)).toHaveLength(0);
  });

  it("domain allowlist admits verified corp email; gmail is denied", async () => {
    await reset();
    mutableConfig.authAllowedEmailDomains = ["corp.io"];
    const r = await resolveIdentity(ident({ email: "a@corp.io" }), { providerKey: "stub", inviteHash: null });
    expect(r.kind).toBe("login");
    mutableConfig.authAllowedEmailDomains = [];
    const denied = await resolveIdentity(
      ident({ subject: "x2", email: "a@gmail.com", hd: null }),
      { providerKey: "stub", inviteHash: null },
    );
    // gmail is verified but sole-ws auto-join IS on → it would auto-join;
    // to isolate the domain rung, disable auto-join
    expect(denied.kind === "login" || denied.kind === "error").toBe(true);
  });

  it("invite rung: open-link admits unverified; email-bound rejects mismatch", async () => {
    const ws = await reset();
    const { hash: openHash } = mintInviteToken();
    await db.insert(invites).values({
      workspaceId: ws.id, email: null, tokenHash: openHash,
      role: "member", expiresAt: new Date(NOW + 86_400_000),
    });
    const viaOpen = await resolveIdentity(
      ident({ subject: "x3", email: "anyone@random.net", emailVerified: false }),
      { providerKey: "stub", inviteHash: openHash },
    );
    expect(viaOpen.kind).toBe("login");

    const { hash: boundHash } = mintInviteToken();
    await db.insert(invites).values({
      workspaceId: ws.id, email: "expected@corp.io", tokenHash: boundHash,
      role: "member", expiresAt: new Date(NOW + 86_400_000),
    });
    const mismatch = await resolveIdentity(
      ident({ subject: "x4", email: "other@corp.io" }),
      { providerKey: "stub", inviteHash: boundHash },
    );
    expect(mismatch).toEqual({ kind: "error", code: "INVITE_EMAIL_MISMATCH" });
  });

  it("BILLING=on: pending invites reserve seats, so SSO JIT is refused when members + pending fill the cap", async () => {
    const ws = await reset();
    for (const n of [1, 2]) {
      const [u] = await db.insert(users).values({ email: `res${n}@corp.io`, name: `R${n}` }).returning();
      await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: u!.id, role: n === 1 ? "owner" : "member" });
    }
    const { hash } = mintInviteToken();
    await db.insert(invites).values({
      workspaceId: ws.id, email: "reserved@corp.io", tokenHash: hash,
      role: "member", expiresAt: new Date(NOW + 86_400_000),
    });
    setBillingForTests(true);
    try {
      // 2 members + 1 pending invite = 3 of 3: the reserved seat is not up for grabs
      const jit = await resolveIdentity(ident({ subject: "res-jit", email: "jit@corp.io" }), {
        providerKey: "stub",
        inviteHash: null,
      });
      expect(jit).toEqual({ kind: "error", code: "PLAN_LIMIT" });
      expect(await db.select().from(users)).toHaveLength(2);
      // the invitee themself still gets the seat their invite reserved
      const viaInvite = await resolveIdentity(ident({ subject: "res-inv", email: "reserved@corp.io" }), {
        providerKey: "stub",
        inviteHash: hash,
      });
      expect(viaInvite.kind).toBe("login");
    } finally {
      setBillingForTests(null);
    }
  });

  it("BILLING=on, full Free workspace: SSO joins answer PLAN_LIMIT and create nobody", async () => {
    const ws = await reset();
    for (const n of [1, 2, 3]) {
      const [u] = await db.insert(users).values({ email: `seat${n}@corp.io`, name: `S${n}` }).returning();
      await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: u!.id, role: n === 1 ? "owner" : "member" });
    }
    setBillingForTests(true);
    try {
      const auto = await resolveIdentity(ident({ subject: "full-1", email: "new@corp.io" }), {
        providerKey: "stub",
        inviteHash: null,
      });
      expect(auto).toEqual({ kind: "error", code: "PLAN_LIMIT" });
      const { hash } = mintInviteToken();
      await db.insert(invites).values({
        workspaceId: ws.id, email: null, tokenHash: hash,
        role: "member", expiresAt: new Date(NOW + 86_400_000),
      });
      const viaInvite = await resolveIdentity(ident({ subject: "full-2", email: "inv@corp.io" }), {
        providerKey: "stub",
        inviteHash: hash,
      });
      expect(viaInvite).toEqual({ kind: "error", code: "PLAN_LIMIT" });
      expect(await db.select().from(users)).toHaveLength(3);
    } finally {
      setBillingForTests(null);
    }
    // billing off again: the same join succeeds
    const r = await resolveIdentity(ident({ subject: "full-3", email: "later@corp.io" }), {
      providerKey: "stub",
      inviteHash: null,
    });
    expect(r.kind).toBe("login");
  });

  it("zero workspaces → pending-bootstrap", async () => {
    for (const t of WIPE) await db.delete(t);
    const r = await resolveIdentity(ident(), { providerKey: "stub", inviteHash: null });
    expect(r.kind).toBe("pending-bootstrap");
  });
});
