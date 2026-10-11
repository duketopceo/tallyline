import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  accountTokens,
  auditEvents,
  invites,
  sessions,
  users,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { hashPassword } from "./auth.js";
import { clock } from "./clock.js";
import { mailer } from "./mailer.js";

// Account lifecycle: password reset, email verification, account deletion.
//
// Tokens are single-use, 32 random bytes, stored only as sha256 and bound to
// one purpose. Issuing a new token of a purpose burns the user's older unused
// ones, so only the latest link works.

export const RESET_TTL_MS = 30 * 60 * 1000;
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
// one reset mail per account per minute: stops a script from mail-bombing an
// address through the (always-202) request endpoint
const RESET_COOLDOWN_MS = 60 * 1000;
// same for "send a new confirmation link"
const RESEND_COOLDOWN_MS = 60 * 1000;

type Purpose = "password_reset" | "email_verify";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export async function audit(
  action: string,
  opts: { userId?: string | null; actorUserId?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  await db.insert(auditEvents).values({
    action,
    userId: opts.userId ?? null,
    actorUserId: opts.actorUserId ?? opts.userId ?? null,
    meta: opts.meta ?? null,
  });
}

/**
 * Mints a token and burns the user's older unused ones of the same purpose.
 * With cooldownMs, returns null instead when one was minted that recently.
 * Serialized per (user, purpose) so concurrent requests cannot both pass
 * the cooldown check.
 */
export async function issueAccountToken(
  userId: string,
  email: string,
  purpose: Purpose,
  ttlMs: number,
  opts: { cooldownMs?: number } = {},
): Promise<string | null> {
  const token = randomBytes(32).toString("base64url");
  const issued = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`account-token:${purpose}:${userId}`})::bigint)`,
    );
    if (opts.cooldownMs) {
      const [recent] = await tx
        .select({ id: accountTokens.id })
        .from(accountTokens)
        .where(
          and(
            eq(accountTokens.userId, userId),
            eq(accountTokens.purpose, purpose),
            gt(accountTokens.createdAt, new Date(clock.ms() - opts.cooldownMs)),
          ),
        )
        .limit(1);
      if (recent) return false;
    }
    await tx
      .update(accountTokens)
      .set({ usedAt: clock.now() })
      .where(
        and(
          eq(accountTokens.userId, userId),
          eq(accountTokens.purpose, purpose),
          isNull(accountTokens.usedAt),
        ),
      );
    await tx.insert(accountTokens).values({
      userId,
      purpose,
      email,
      tokenHash: sha256(token),
      expiresAt: new Date(clock.ms() + ttlMs),
      createdAt: clock.now(),
    });
    return true;
  });
  return issued ? token : null;
}

/** atomically burns a live token; null when unknown, used, expired or wrong purpose */
export async function consumeAccountToken(
  token: string,
  purpose: Purpose,
): Promise<{ userId: string; email: string } | null> {
  const [row] = await db
    .update(accountTokens)
    .set({ usedAt: clock.now() })
    .where(
      and(
        eq(accountTokens.tokenHash, sha256(token)),
        eq(accountTokens.purpose, purpose),
        isNull(accountTokens.usedAt),
        gt(accountTokens.expiresAt, clock.now()),
      ),
    )
    .returning({ userId: accountTokens.userId, email: accountTokens.email });
  return row ?? null;
}

async function userByEmail(email: string) {
  const [u] = await db
    .select()
    .from(users)
    .where(sql`lower(btrim(${users.email})) = lower(btrim(${email}))`);
  return u ?? null;
}

// ── password reset ───────────────────────────────────────────────────────────

/**
 * Runs behind an always-202 endpoint: the caller learns nothing about
 * whether the address has an account. Call sites run it in the background so
 * response timing does not leak it either.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  if (config_.authDisablePassword) return;
  const user = await userByEmail(email);
  if (!user) return;
  const token = await issueAccountToken(user.id, user.email, "password_reset", RESET_TTL_MS, {
    cooldownMs: RESET_COOLDOWN_MS,
  });
  if (!token) return;
  await audit("password_reset_requested", { userId: user.id, actorUserId: null });
  const link = `${config_.webUrl}/reset-password?token=${token}`;
  await mailer().send({
    kind: "password_reset",
    to: user.email,
    subject: "Reset your Tallyline password",
    text: [
      `Someone asked to reset the password for ${user.email} on Tallyline.`,
      "",
      "Set a new password with this link. It works once and expires in 30 minutes:",
      link,
      "",
      "Resetting signs you out everywhere. Personal access tokens keep working;",
      "revoke them in Settings > Account if you think someone else has them.",
      "",
      "If you did not ask for this, ignore this email. Your password has not changed.",
    ].join("\n"),
  });
}

export type ResetOutcome =
  | { ok: true; userId: string; sessionsRevoked: number }
  | { ok: false };

/**
 * Sets the new password and revokes every session of the account.
 *
 * Personal access tokens are deliberately kept: they are separately minted,
 * scoped, workspace-bound and individually revocable credentials that CI and
 * agents depend on, a reset is usually a forgotten password rather than a
 * compromise, and a leaked password does not reveal them (only hashes are
 * stored and each was shown once). Sessions are the credential a stolen
 * password produces, so those go. The confirmation mail tells the user where
 * to revoke tokens if they suspect more.
 */
export async function resetPassword(token: string, password: string): Promise<ResetOutcome> {
  const claimed = await consumeAccountToken(token, "password_reset");
  if (!claimed) return { ok: false };
  const [user] = await db.select().from(users).where(eq(users.id, claimed.userId));
  if (!user) return { ok: false };
  // the token is bound to the address it was mailed to: if the account's
  // email changed since, whoever holds the old mailbox must not be able to
  // take the account over with it
  if (claimed.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    return { ok: false };
  }
  const revoked = await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: hashPassword(password),
        // receiving the reset mail proves control of the address it went to
        ...(user.emailVerifiedAt === null ? { emailVerifiedAt: clock.now() } : {}),
      })
      .where(eq(users.id, user.id));
    // burn any other outstanding reset links too
    await tx
      .update(accountTokens)
      .set({ usedAt: clock.now() })
      .where(
        and(
          eq(accountTokens.userId, user.id),
          eq(accountTokens.purpose, "password_reset"),
          isNull(accountTokens.usedAt),
        ),
      );
    return tx.delete(sessions).where(eq(sessions.userId, user.id)).returning({ id: sessions.id });
  });
  await audit("password_reset_completed", {
    userId: user.id,
    actorUserId: null,
    meta: { sessionsRevoked: revoked.length, patsKept: true },
  });
  await mailer().send({
    kind: "password_changed",
    to: user.email,
    subject: "Your Tallyline password was changed",
    text: [
      `The password for ${user.email} on Tallyline was just changed, and every`,
      "signed-in session was signed out.",
      "",
      "If this was not you, reset your password again and revoke your personal",
      "access tokens in Settings > Account.",
    ].join("\n"),
  });
  return { ok: true, userId: user.id, sessionsRevoked: revoked.length };
}

// ── email verification ───────────────────────────────────────────────────────

export async function isEmailVerified(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ at: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId));
  return Boolean(u?.at);
}

/**
 * Mails a fresh verification link. `resend` applies the one-per-minute
 * cooldown (the signup path itself always sends).
 */
export async function sendVerificationEmail(
  userId: string,
  opts: { resend?: boolean } = {},
): Promise<"sent" | "already_verified" | "recently_sent"> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw new Error("user not found");
  if (u.emailVerifiedAt) return "already_verified";
  const token = await issueAccountToken(u.id, u.email, "email_verify", VERIFY_TTL_MS, {
    ...(opts.resend ? { cooldownMs: RESEND_COOLDOWN_MS } : {}),
  });
  if (!token) return "recently_sent";
  await audit("email_verification_sent", { userId: u.id });
  await mailer().send({
    kind: "email_verify",
    to: u.email,
    subject: "Confirm your email for Tallyline",
    text: [
      `Confirm that ${u.email} is your address on Tallyline.`,
      "",
      "Open this link to confirm. It works once and expires in 24 hours:",
      `${config_.webUrl}/verify-email?token=${token}`,
      "",
      "Until you confirm, you can use Tallyline but cannot create personal",
      "access tokens or agent keys.",
    ].join("\n"),
  });
  return "sent";
}

export async function verifyEmail(token: string): Promise<{ userId: string } | null> {
  const claimed = await consumeAccountToken(token, "email_verify");
  if (!claimed) return null;
  // the token is bound to the address it was mailed to: if the account's
  // email changed since, it proves nothing about the current one
  const [u] = await db
    .update(users)
    .set({ emailVerifiedAt: clock.now() })
    .where(
      and(
        eq(users.id, claimed.userId),
        sql`lower(btrim(${users.email})) = lower(btrim(${claimed.email}))`,
      ),
    )
    .returning({ id: users.id });
  if (!u) return null;
  await audit("email_verified", { userId: u.id });
  return { userId: u.id };
}

// ── account deletion ─────────────────────────────────────────────────────────

export class SoleOwnerError extends Error {
  constructor(
    readonly live: { id: string; name: string }[],
    readonly pending: { id: string; name: string }[],
  ) {
    super("sole owner");
    this.name = "SoleOwnerError";
  }

  get userMessage(): string {
    const list = (ws: { name: string }[]) => ws.map((w) => `"${w.name}"`).join(", ");
    const parts: string[] = [];
    if (this.live.length > 0) {
      parts.push(
        `You are the only owner of ${list(this.live)}. Make someone else an owner, or delete the workspace, then delete your account.`,
      );
    }
    if (this.pending.length > 0) {
      parts.push(
        `You are the only owner of ${list(this.pending)}, which is pending deletion. Restore it, or wait for it to be purged, then delete your account.`,
      );
    }
    return parts.join(" ");
  }
}

/**
 * Hard-deletes the account. Memberships, sessions, PATs, personal views,
 * SSO links, OAuth grants and account tokens cascade with the user row.
 * Workspace content the user wrote (issues, comments, events) stays with the
 * workspace — it belongs to the team — but loses its link to a person: the
 * actor ids no longer resolve to a name or email, and open assignments to
 * the user are cleared.
 *
 * Refuses (SoleOwnerError) while the user is the only owner of any workspace,
 * including one pending deletion: its owner is who can still restore it. The
 * check runs inside the transaction with row locks on every owner membership
 * of those workspaces, so two co-owners deleting at once serialize and the
 * second sees the first already gone instead of both passing a stale check.
 */
export async function deleteAccount(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{
      workspace_id: string;
      name: string;
      deleted_at: Date | null;
      user_id: string;
    }>(sql`
      select m.workspace_id, w.name, w.deleted_at, m.user_id
        from workspace_members m
        join workspaces w on w.id = m.workspace_id
       where m.role = 'owner'
         and m.workspace_id in (
           select workspace_id from workspace_members
            where user_id = ${userId} and role = 'owner')
       order by m.id
         for update of m`);
    const byWs = new Map<string, { name: string; pending: boolean; owners: number }>();
    for (const r of rows) {
      const e = byWs.get(r.workspace_id) ?? { name: r.name, pending: r.deleted_at !== null, owners: 0 };
      e.owners++;
      byWs.set(r.workspace_id, e);
    }
    const sole = [...byWs.entries()]
      .filter(([, e]) => e.owners <= 1)
      .map(([id, e]) => ({ id, name: e.name, pending: e.pending }));
    if (sole.length > 0) {
      throw new SoleOwnerError(
        sole.filter((w) => !w.pending),
        sole.filter((w) => w.pending),
      );
    }
    await tx.execute(
      sql`update issues set assignee_id = null, assignee_type = null
           where assignee_type = 'human' and assignee_id = ${userId}`,
    );
    await tx.update(invites).set({ createdBy: null }).where(eq(invites.createdBy, userId));
    await tx.update(invites).set({ acceptedBy: null }).where(eq(invites.acceptedBy, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
  await audit("account_deleted", { userId, actorUserId: userId });
}
