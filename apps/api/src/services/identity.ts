import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  authIdentities,
  events,
  invites,
  teamMembers,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { inviteFromHash } from "../auth/invite-token.js";
import type { IdentityResult } from "../auth/providers/types.js";
import { membershipsFor } from "./members.js";
import { clock } from "./clock.js";

// Identity resolution (U4): a provider IdentityResult becomes a user +
// membership, a pending state, or a denial — per the plan's flowchart.
export interface ResolveContext {
  providerKey: string;
  inviteHash: string | null;
}

export type Resolved =
  | { kind: "login"; userId: string; workspaceId: string; memberships: Awaited<ReturnType<typeof membershipsFor>> }
  | { kind: "pending-bootstrap"; pendingEmail: string | null }
  | { kind: "pending-link"; pendingEmail: string; linkSubject: string }
  | { kind: "error"; code: string };

const norm = (e: string) => e.trim().toLowerCase();

// invite acceptance shared by the identity-hit path and the JIT rung
// (R18): callers pre-check email binding. Marks the invite consumed and
// emits member_joined.
async function acceptInvite(
  userId: string,
  invite: { id: string; workspaceId: string; teamId: string | null; role: "member" | "admin" },
) {
  await db.insert(workspaceMembers).values({
    workspaceId: invite.workspaceId,
    userId,
    role: invite.role,
  }).onConflictDoNothing();
  if (invite.teamId) {
    await db.insert(teamMembers).values({
      teamId: invite.teamId,
      userId,
    }).onConflictDoNothing();
  }
  await db
    .update(invites)
    .set({ acceptedAt: clock.now(), acceptedBy: userId })
    .where(eq(invites.id, invite.id));
  await db.insert(events).values({
    workspaceId: invite.workspaceId,
    actorType: "system",
    actorId: userId,
    action: "member_joined",
    entityType: "member",
    entityId: userId,
  });
}

// invite carried through the flow: consume if the user isn't already a
// member (existing users hit this on the identity-match rung so an
// invite sent to them isn't silently dropped)
async function consumeInviteIfPresent(
  userId: string,
  inviteHash: string | null,
  email: string | null,
) {
  const invite = inviteHash ? await inviteFromHash(inviteHash) : null;
  if (!invite) return;
  if (invite.email && email !== norm(invite.email)) return; // email-bound miss
  const member = await membershipsFor(userId);
  if (!member.some((m) => m.workspaceId === invite.workspaceId)) {
    await acceptInvite(userId, invite);
  }
}

export async function resolveIdentity(
  result: IdentityResult,
  ctx: ResolveContext,
): Promise<Resolved> {
  const email = result.email ? norm(result.email) : null;

  // 1. known identity → load user → consume invite → select workspace
  const [ident] = await db
    .select()
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.providerKey, ctx.providerKey),
        eq(authIdentities.providerSubject, result.subject),
      ),
    );
  if (ident) {
    await consumeInviteIfPresent(ident.userId, ctx.inviteHash, email);
    return loginResolved(ident.userId);
  }

  // 2. verified-email user match → linking policy
  const [matched] = email && result.emailVerified
    ? await db.select().from(users).where(sql`lower(btrim(${users.email})) = ${email}`)
    : [undefined];
  if (matched) {
    const policy = config_.authAccountLinking;
    if (policy === "disabled") return { kind: "error", code: "LINK_DISABLED" };
    if (policy === "login") {
      return { kind: "pending-link", pendingEmail: email!, linkSubject: result.subject };
    }
    await db.insert(authIdentities).values({
      userId: matched.id,
      providerKey: ctx.providerKey,
      providerSubject: result.subject,
      email,
      emailVerified: result.emailVerified,
    });
    await consumeInviteIfPresent(matched.id, ctx.inviteHash, email);
    return loginResolved(matched.id);
  }

  // 3. JIT chain — new user, every rung gated (R17)
  const invite = ctx.inviteHash ? await inviteFromHash(ctx.inviteHash) : null;
  if (invite) {
    // email-bound invites require the identity's email to match; open-link
    // invites are token-only authorization — the sole unverified-email path
    if (invite.email) {
      if (!email || email !== norm(invite.email)) {
        return { kind: "error", code: "INVITE_EMAIL_MISMATCH" };
      }
    }
    const [u] = await db.insert(users).values({
      email: email ?? `${ctx.providerKey}-${result.subject}@sso.local`,
      name: result.name ?? email ?? "sso user",
      // the column defaults to now(), but only the provider claim proves the
      // address — an unverified SSO email stays NULL like the invite path
      emailVerifiedAt: result.emailVerified ? clock.now() : null,
    }).returning();
    await db.insert(authIdentities).values({
      userId: u!.id, providerKey: ctx.providerKey,
      providerSubject: result.subject, email, emailVerified: result.emailVerified,
    });
    await acceptInvite(u!.id, invite);
    return loginResolved(u!.id);
  }

  const [firstWs] = await db
    .select()
    .from(workspaces)
    .orderBy(workspaces.createdAt)
    .limit(1);
  if (!firstWs) {
    return { kind: "pending-bootstrap", pendingEmail: email };
  }

  // domain match — verified email only; the email domain or the IdP's hd
  // claim must appear in an allowlist (instance or workspace)
  const domain = email?.split("@")[1];
  if (result.emailVerified && domain) {
    const allowed =
      config_.authAllowedEmailDomains.includes(domain) ||
      (result.hd !== null && config_.authAllowedEmailDomains.includes(result.hd)) ||
      (firstWs.allowedDomains ?? []).includes(domain);
    if (allowed) {
      return createJitUser(result, ctx, email!, firstWs.id);
    }
  }

  // sole-workspace auto-join — verified email only (R17)
  const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(workspaces);
  const n = countRow?.n ?? 0;
  if (
    config_.authAutoJoinSingleWorkspace &&
    result.emailVerified &&
    email &&
    n === 1
  ) {
    return createJitUser(result, ctx, email, firstWs.id);
  }

  return { kind: "error", code: "INVITE_REQUIRED" };
}

async function createJitUser(
  result: IdentityResult,
  ctx: ResolveContext,
  email: string,
  workspaceId: string,
): Promise<Resolved> {
  const [u] = await db.insert(users).values({
    email,
    name: result.name ?? email,
    // honor the provider claim: an unverified SSO email stays NULL and the
    // account still needs a verify link, same as the invite path
    emailVerifiedAt: result.emailVerified ? clock.now() : null,
  }).returning();
  await db.insert(authIdentities).values({
    userId: u!.id, providerKey: ctx.providerKey,
    providerSubject: result.subject, email, emailVerified: result.emailVerified,
  });
  await db.insert(workspaceMembers).values({
    workspaceId, userId: u!.id, role: "member",
  });
  await db.insert(events).values({
    workspaceId, actorType: "system", actorId: u!.id,
    action: "member_joined", entityType: "member", entityId: u!.id,
  });
  return loginResolved(u!.id);
}

async function loginResolved(userId: string): Promise<Resolved> {
  const memberships = await membershipsFor(userId);
  if (memberships.length === 0) {
    return { kind: "error", code: "NO_WORKSPACE" };
  }
  // invite/domain-resolved membership already landed; otherwise the most
  // recent membership is the active one (picker refines via /auth/session)
  const active = memberships.at(-1)!;
  return {
    kind: "login",
    userId,
    workspaceId: active.workspaceId,
    memberships,
  };
}
