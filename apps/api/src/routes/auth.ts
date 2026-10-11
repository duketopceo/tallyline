import { getCookie, setCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { hasApiTokenPrefix, isAgentToken, isPatToken } from "@tallyline/types";
import { db } from "../db/client.js";
import {
  sessions,
  teams,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { apiError, HttpError } from "../lib/errors.js";
import { isEmailVerified } from "../services/account.js";
import { requestIsHttps } from "../lib/https.js";
import { authLimiter } from "../lib/rate-limit.js";
import { config_ } from "../env.js";
import {
  createSession,
  destroySession,
  hashPassword,
  SESSION_COOKIE,
  sessionFromToken,
  verifyPassword,
} from "../services/auth.js";
import {
  isInstanceAdmin,
  membershipsFor,
  memberOf,
  type MemberRole,
} from "../services/members.js";
import { agentFromKey, type AgentAuth } from "../services/agents.js";
import {
  INTERNAL_HEADER,
  accessFromToken,
  isInternalCall,
  isOAuthAccessToken,
} from "../services/mcp-oauth.js";
import {
  ACCESS_TOKEN_TTL_S,
  signAccessToken,
  userFromToken,
  verifyAccessToken,
} from "../services/tokens.js";

const bootstrapSchema = z.object({
  workspaceSlug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9-]+$/),
  workspaceName: z.string().min(1).max(120),
  teamKey: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Z][A-Z0-9]*$/)
    .default("DOK"),
  email: z.email(),
  name: z.string().min(1).max(120),
  password: z.string().min(10).max(256),
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

export const authRoutes = new Hono()
  .post(
    "/bootstrap",
    authLimiter,
    zValidator("json", bootstrapSchema),
    async (c) => {
      if (config_.authDisablePassword) {
        // first-run under password-disabled goes through OAuth's
        // pending-bootstrap exchange path (R11), not this endpoint
        return apiError(
          c,
          403,
          "BOOTSTRAP_CLOSED",
          "password auth is disabled — bootstrap via your first SSO login",
        );
      }
      const existing = await db.select({ id: workspaces.id }).from(workspaces);
      if (existing.length > 0) {
        return apiError(
          c,
          403,
          "BOOTSTRAP_CLOSED",
          "workspace already exists — use login or an invite",
        );
      }
      const body = c.req.valid("json");

      // serialized with the OAuth pending-bootstrap path: the xact-level
      // advisory lock makes the zero-workspace check + create atomic, so a
      // second concurrent bootstrap sees the row instead of racing past it
      const boot = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('tallyline-bootstrap')::bigint)`,
        );
        const again = await tx.select({ id: workspaces.id }).from(workspaces);
        if (again.length > 0) return null;
        const [ws] = await tx
          .insert(workspaces)
          .values({ slug: body.workspaceSlug, name: body.workspaceName })
          .returning();
        await tx.insert(teams).values({
          workspaceId: ws!.id,
          key: body.teamKey,
          name: "Tallyline",
        });
        const [user] = await tx
          .insert(users)
          .values({
            email: body.email.trim().toLowerCase(),
            name: body.name,
            passwordHash: hashPassword(body.password),
          })
          .returning();
        await tx.insert(workspaceMembers).values({
          workspaceId: ws!.id,
          userId: user!.id,
          role: "owner",
        });
        return { ws: ws!, user: user! };
      });
      if (!boot) {
        return apiError(
          c,
          403,
          "BOOTSTRAP_CLOSED",
          "workspace already exists — use login or an invite",
        );
      }
      const { ws, user } = boot;

      const token = await createSession(user.id, ws.id);
      setSessionCookie(c, token);
      return c.json(
        {
          workspace: { id: ws!.id, slug: ws!.slug, name: ws!.name },
          user: { id: user!.id, email: user!.email, name: user!.name },
        },
        201,
      );
    },
  )
  .post("/login", authLimiter, zValidator("json", loginSchema), async (c) => {
    if (config_.authDisablePassword) {
      return apiError(
        c,
        403,
        "PASSWORD_DISABLED",
        "password auth is disabled on this instance",
      );
    }
    const body = c.req.valid("json");
    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(btrim(${users.email})) = lower(btrim(${body.email}))`);
    if (
      !user ||
      !user.passwordHash ||
      !verifyPassword(body.password, user.passwordHash)
    ) {
      return apiError(c, 401, "BAD_CREDENTIALS", "invalid email or password");
    }
    // session binds to the user's earliest membership; zero-membership
    // users have nowhere to land (U2 refines resolution)
    // land in a live workspace when there is one; a workspace pending
    // deletion is still reachable (Settings > Workspace offers restore)
    const [member] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id))
      .orderBy(sql`${workspaces.deletedAt} is not null`, workspaceMembers.createdAt)
      .limit(1);
    if (!member) {
      return apiError(
        c,
        403,
        "NO_WORKSPACE",
        "account has no workspace membership",
      );
    }
    const token = await createSession(user.id, member.workspaceId);
    setSessionCookie(c, token);
    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
      workspaceId: member.workspaceId,
    });
  })
  .post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await destroySession(token);
    setCookie(c, SESSION_COOKIE, "", { maxAge: 0, path: "/" });
    return c.json({ ok: true });
  })
  .get("/me", async (c) => {
    // Bearer credentials resolve their own identity — CLI/MCP clients need
    // this to learn which agent/user a token belongs to.
    const bearer = c.req.header("authorization");
    const bearerToken = bearer?.startsWith("Bearer ") ? bearer.slice(7) : null;
    if (isAgentToken(bearerToken)) {
      const agent = await agentFromKey(bearerToken);
      if (!agent) return apiError(c, 401, "UNAUTHENTICATED", "bad key");
      return c.json({
        type: "agent",
        agentId: agent.agentId,
        name: agent.agentName,
        workspaceId: agent.workspaceId,
        scopes: agent.scopes,
      });
    }
    if (isPatToken(bearerToken)) {
      const pat = await userFromToken(bearerToken);
      if (!pat) return apiError(c, 401, "UNAUTHENTICATED", "bad token");
      return c.json({
        type: "user",
        userId: pat.userId,
        name: pat.userName,
        workspaceId: pat.workspaceId,
        workspaceSlug: pat.workspaceSlug,
        scopes: pat.scopes,
      });
    }
    if (bearerToken && !hasApiTokenPrefix(bearerToken)) {
      const claims = await verifyAccessToken(bearerToken);
      if (!claims) return apiError(c, 401, "UNAUTHENTICATED", "bad jwt");
      const [ws] = await db
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.id, claims.ws));
      return c.json({
        type: "user",
        userId: claims.sub,
        workspaceId: claims.ws,
        workspaceSlug: ws?.slug ?? null,
        scopes: claims.scopes,
      });
    }
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return apiError(c, 401, "UNAUTHENTICATED", "no session");
    const session = await sessionFromToken(token);
    if (!session) return apiError(c, 401, "UNAUTHENTICATED", "session expired");
    const memberships = await membershipsFor(session.userId);
    return c.json({
      type: "user",
      userId: session.userId,
      name: session.name,
      email: session.email,
      emailVerified: session.emailVerifiedAt !== null,
      workspaceSlug: session.workspaceSlug,
      memberships,
      activeWorkspaceSlug: session.workspaceSlug,
      isInstanceAdmin: await isInstanceAdmin({
        id: session.userId,
        email: session.email,
      }),
    });
  })
  // Re-bind a roaming cookie session's active workspace — the switch the
  // workspace picker calls. Cookie sessions only: PATs/JWTs and agent keys
  // are minted bound and cannot re-bind.
  .post(
    "/session",
    zValidator("json", z.object({ workspaceSlug: z.string().min(1) })),
    async (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (!token) return apiError(c, 401, "UNAUTHENTICATED", "no session");
      const session = await sessionFromToken(token);
      if (!session) return apiError(c, 401, "UNAUTHENTICATED", "session expired");
      const slug = c.req.valid("json").workspaceSlug;
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.slug, slug));
      if (!ws) return apiError(c, 404, "NOT_FOUND", "workspace not found");
      const member = await memberOf(session.userId, ws.id);
      if (!member) {
        return apiError(
          c,
          403,
          "FORBIDDEN_WORKSPACE",
          "not a member of this workspace",
        );
      }
      await db
        .update(sessions)
        .set({ workspaceId: ws.id })
        .where(eq(sessions.id, session.sessionId));
      const memberships = await membershipsFor(session.userId);
      return c.json({ workspaceSlug: ws.slug, memberships });
    },
  )
  // Exchange a session cookie for a short-lived access JWT — the
  // programmatic-auth path for human users (agents mint tly_agt_ keys instead).
  .post("/token", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return apiError(c, 401, "UNAUTHENTICATED", "no session");
    const session = await sessionFromToken(token);
    if (!session) return apiError(c, 401, "UNAUTHENTICATED", "session expired");
    const accessToken = await signAccessToken({
      sub: session.userId,
      ws: session.workspaceId,
    });
    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
    });
  });

export function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: requestIsHttps(c),
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });
}

export interface Session {
  sessionId: string;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  name: string;
}

declare module "hono" {
  interface ContextVariableMap {
    session: Session | null;
    agentAuth: AgentAuth | null;
    // role in the URL-resolved workspace, injected by requireWorkspace;
    // null for agent credentials and unbound routes
    memberRole: MemberRole | null;
    // scopes carried by the presented credential (agent key, PAT, JWT);
    // null for cookie sessions, which always act with full user rights
    tokenScopes: string[] | null;
    // set by provider-admin middleware after the instance-admin check
    instanceAdminUserId: string;
  }
}

// Unverified accounts may use Tallyline but not mint long-lived credentials
// (PATs, agent keys): a credential outlives the session that made it, so the
// address behind it must be proven first.
export async function requireVerifiedEmail(c: Context): Promise<void> {
  const session = c.get("session");
  if (!session) return;
  if (!(await isEmailVerified(session.userId))) {
    throw new HttpError(
      403,
      "EMAIL_UNVERIFIED",
      "confirm your email first — use the link we sent, or resend it from Settings > Account",
    );
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Cookie sessions mint credentials; delegated credentials (PATs, JWTs) and
// agent keys cannot mint or enumerate further credentials.
export function isCookieSession(c: Context): boolean {
  const session = c.get("session");
  return (
    session !== null &&
    session !== undefined &&
    !session.sessionId.startsWith("pat:") &&
    !session.sessionId.startsWith("jwt:")
  );
}

function scopeGuard(c: Context, scopes: string[]) {
  const needed = SAFE_METHODS.has(c.req.method) ? "read" : "write";
  if (!scopes.includes(needed)) {
    return apiError(
      c,
      403,
      "FORBIDDEN_SCOPE",
      `token lacks '${needed}' scope`,
    );
  }
  return null;
}

export async function requireSession(c: Context, next: Next) {
  if (c.req.path.startsWith("/v1/auth/")) return next();
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await sessionFromToken(token);
    if (session) {
      c.set("session", session);
      c.set("agentAuth", null);
      c.set("tokenScopes", null);
      await next();
      return;
    }
  }
  const bearer = c.req.header("authorization");
  const bearerToken = bearer?.startsWith("Bearer ") ? bearer.slice(7) : null;
  if (isAgentToken(bearerToken)) {
    const agent = await agentFromKey(bearerToken);
    if (agent) {
      const denied = scopeGuard(c, agent.scopes);
      if (denied) return denied;
      c.set("session", null);
      c.set("agentAuth", agent);
      c.set("tokenScopes", agent.scopes);
      await next();
      return;
    }
  }
  // OAuth access tokens are audience-bound to the MCP resource: only the
  // in-process MCP dispatch (which holds the per-boot internal secret) may
  // present one to /v1. Presented directly, it falls through to 401.
  if (
    isOAuthAccessToken(bearerToken) &&
    isInternalCall(c.req.header(INTERNAL_HEADER))
  ) {
    const access = await accessFromToken(bearerToken);
    if (access) {
      const denied = scopeGuard(c, access.scopes);
      if (denied) return denied;
      c.set("session", null);
      c.set("agentAuth", {
        agentId: access.agentId,
        agentName: access.agentName,
        workspaceId: access.workspaceId,
        keyId: access.tokenId,
        scopes: access.scopes,
      });
      c.set("tokenScopes", access.scopes);
      await next();
      return;
    }
  }
  if (isPatToken(bearerToken)) {
    const pat = await userFromToken(bearerToken);
    if (pat) {
      const denied = scopeGuard(c, pat.scopes);
      if (denied) return denied;
      c.set("tokenScopes", pat.scopes);
      c.set("session", {
        sessionId: `pat:${pat.keyId}`,
        userId: pat.userId,
        workspaceId: pat.workspaceId,
        workspaceSlug: pat.workspaceSlug,
        name: pat.userName,
      });
      c.set("agentAuth", null);
      await next();
      return;
    }
  }
  if (bearerToken && !hasApiTokenPrefix(bearerToken)) {
    const claims = await verifyAccessToken(bearerToken);
    if (claims) {
      const denied = scopeGuard(c, claims.scopes);
      if (denied) return denied;
      c.set("tokenScopes", claims.scopes);
      c.set("session", {
        sessionId: `jwt:${claims.sub}`,
        userId: claims.sub,
        workspaceId: claims.ws,
        workspaceSlug: "",
        name: "",
      });
      c.set("agentAuth", null);
      await next();
      return;
    }
  }
  // x-actor-* headers alone are NOT credentials — they only shape attribution
  // on an otherwise-authenticated request.
  return apiError(
    c,
    401,
    "UNAUTHENTICATED",
    "sign in or present agent credentials",
  );
}
