import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { isPatToken } from "@tallyline/types";
import { inviteFromToken } from "../auth/invite-token.js";
import { db } from "../db/client.js";
import {
  events,
  invites,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { authLimiter } from "../lib/rate-limit.js";
import {
  createSession,
  hashPassword,
  SESSION_COOKIE,
  sessionFromToken,
} from "../services/auth.js";
import { createInvite, listInvites, revokeInvite } from "../services/invites.js";
import { requireRole } from "../services/members.js";
import { userFromToken } from "../services/tokens.js";
import { setSessionCookie } from "./auth.js";
import { requireWorkspace } from "./workspaces.js";
import { clock } from "../services/clock.js";
import { sendVerificationEmail } from "../services/account.js";
import { track } from "../services/background.js";


const createSchema = z.object({
  email: z.email().optional(),
  role: z.enum(["member", "admin"]).default("member"),
  teamId: z.string().uuid().optional(),
  expiresInDays: z.number().int().min(1).max(90).default(7),
});

const acceptSchema = z.object({
  token: z.string().min(1),
  // unauthenticated claim shape (R18c) — only on password-enabled installs
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(10).max(256).optional(),
});

async function emit(wsId: string, actorId: string | null, action: string, entityId: string) {
  await db.insert(events).values({
    workspaceId: wsId, actorType: actorId ? "human" : "system", actorId,
    action, entityType: "invite", entityId,
  });
}

export const inviteRoutes = new Hono()
  .post(
    "/workspaces/:ws/invites",
    zValidator("json", createSchema),
    async (c) => {
      const session = c.get("session");
      if (!session || !session.sessionId || session.sessionId.startsWith("pat:") || session.sessionId.startsWith("jwt:")) {
        return apiError(c, 403, "FORBIDDEN", "invites require a human session");
      }
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const body = c.req.valid("json");
      if (body.teamId) {
        const [team] = await db
          .select()
          .from(teams)
          .where(and(eq(teams.id, body.teamId), eq(teams.workspaceId, ws.id)));
        if (!team) {
          return apiError(c, 422, "BAD_TEAM", "team_id must belong to this workspace");
        }
      }
      const { invite, token } = await createInvite({
        workspaceId: ws.id,
        email: body.email ?? null,
        role: body.role,
        teamId: body.teamId ?? null,
        createdBy: session.userId,
        expiresAt: new Date(clock.ms() + body.expiresInDays * 86_400_000),
      });
      await emit(ws.id, session.userId, "invite_created", invite!.id);
      return c.json(
        {
          id: invite!.id,
          email: invite!.email,
          role: invite!.role,
          teamId: invite!.teamId,
          expiresAt: invite!.expiresAt,
          joinUrl: `${config_.webUrl}/join/${token}`,
        },
        201,
      );
    },
  )
  .get("/workspaces/:ws/invites", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    return c.json({ invites: await listInvites(ws.id) });
  })
  .delete("/workspaces/:ws/invites/:id", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const revoked = await revokeInvite(c.req.param("id"), ws.id);
    if (!revoked) return apiError(c, 404, "NOT_FOUND", "invite not found");
    const session = c.get("session");
    await emit(ws.id, session?.userId ?? null, "invite_revoked", revoked.id);
    return c.json({ ok: true });
  });

// public acceptance — mounted under /v1/auth so requireSession skips it;
// the credential is resolved server-side, never trusted from the body
export const inviteAcceptRoutes = new Hono()
  .post("/accept-invite", authLimiter, zValidator("json", acceptSchema), async (c) => {
    const body = c.req.valid("json");
    const invite = await inviteFromToken(body.token);
    if (!invite) {
      return apiError(c, 410, "INVITE_GONE", "invite expired, revoked, or already used");
    }

    // resolve the caller: cookie session first, then bearer PAT — a body
    // userId is never honored (R16a)
    let userId: string | null = null;
    const cookieToken = getCookie(c, SESSION_COOKIE);
    if (cookieToken) {
      const session = await sessionFromToken(cookieToken);
      if (session) userId = session.userId;
    }
    if (!userId) {
      const bearer = c.req.header("authorization");
      const bearerToken = bearer?.startsWith("Bearer ") ? bearer.slice(7) : null;
      if (isPatToken(bearerToken)) {
        const pat = await userFromToken(bearerToken);
        if (pat) userId = pat.userId;
      }
    }

    if (userId) {
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u) return apiError(c, 401, "UNAUTHENTICATED", "account not found");
      if (invite.email && invite.email !== u.email.trim().toLowerCase()) {
        return apiError(c, 403, "INVITE_EMAIL_MISMATCH", "this invite is bound to a different email");
      }
      await acceptForUser(userId, invite);
      return c.json({ ok: true, workspaceId: invite.workspaceId });
    }

    // unauthenticated claim: create account + member + session atomically
    // — the only onboarding path on a default install (R18c)
    if (config_.authDisablePassword || !body.name || !body.password) {
      return apiError(c, 401, "UNAUTHENTICATED", "sign in, or claim with {name, password}");
    }
    const email = invite.email;
    if (!email) {
      // open-link invites have no email to derive the account from —
      // the join page collects it alongside name+password
      return apiError(c, 422, "EMAIL_REQUIRED", "open invite requires an email on the claim");
    }
    if (!body.name || !body.password) {
      return apiError(c, 401, "UNAUTHENTICATED", "sign in or claim with name+password");
    }
    const [u] = await db
      .insert(users)
      .values({
        email,
        name: body.name,
        passwordHash: hashPassword(body.password),
        // an invite link is copied by hand, not mailed, so holding it does
        // not prove the address: verify before minting credentials
        emailVerifiedAt: null,
      })
      .returning();
    await acceptForUser(u!.id, invite);
    track(sendVerificationEmail(u!.id));
    const token = await createSession(u!.id, invite.workspaceId);
    setSessionCookie(c, token);
    return c.json({ ok: true, workspaceId: invite.workspaceId }, 201);
  });

async function acceptForUser(
  userId: string,
  invite: { id: string; workspaceId: string; teamId: string | null; role: "member" | "admin" },
) {
  // atomic claim — a concurrent accept yields exactly one member row
  const [claimed] = await db
    .update(invites)
    .set({ acceptedAt: clock.now(), acceptedBy: userId })
    .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
    .returning();
  if (!claimed) {
    throw Object.assign(new Error("invite already used"), { status: 410 });
  }
  await db.insert(workspaceMembers).values({
    workspaceId: invite.workspaceId,
    userId,
    role: invite.role,
  }).onConflictDoNothing();
  if (invite.teamId) {
    await db.insert(teamMembers).values({ teamId: invite.teamId, userId }).onConflictDoNothing();
  }
  await db.insert(events).values({
    workspaceId: invite.workspaceId, actorType: "system", actorId: userId,
    action: "member_joined", entityType: "member", entityId: userId,
  });
}
