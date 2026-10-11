import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { stream } from "hono/streaming";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { authLimiter } from "../lib/rate-limit.js";
import {
  audit,
  deleteAccount,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  SoleOwnerError,
  verifyEmail,
} from "../services/account.js";
import { SESSION_COOKIE } from "../services/auth.js";
import { track } from "../services/background.js";
import { clock } from "../services/clock.js";
import { devInbox, devInboxEnabled } from "../services/mailer.js";
import { isInstanceAdmin, requireRole } from "../services/members.js";
import {
  restoreWorkspace,
  scheduleWorkspaceDeletion,
  streamPersonalExport,
  streamWorkspaceExport,
} from "../services/workspace-lifecycle.js";
import { isCookieSession } from "./auth.js";
import { requireWorkspace } from "./workspaces.js";

const tokenField = z.string().min(16).max(256);
const confirmField = z.object({ confirm: z.string().min(1).max(320) });

function humanOnly(c: Context, what: string) {
  if (!isCookieSession(c) || !c.get("session")) {
    return apiError(c, 403, "FORBIDDEN", `${what} requires a signed-in human session`);
  }
  return null;
}

function stamp(): string {
  return clock.now().toISOString().slice(0, 10);
}

// ── public: mounted under /v1/auth (no session required) ────────────────────

export const accountPublicRoutes = new Hono()
  // Always 202 with the same body: whether the address has an account is
  // never revealed, and the lookup + mail run after the response so timing
  // does not reveal it either.
  .post(
    "/password/forgot",
    authLimiter,
    zValidator("json", z.object({ email: z.email().max(320) })),
    (c) => {
      track(requestPasswordReset(c.req.valid("json").email));
      return c.json(
        {
          ok: true,
          message: "If an account uses that address, a reset link is on its way. It expires in 30 minutes.",
        },
        202,
      );
    },
  )
  .post(
    "/password/reset",
    authLimiter,
    zValidator("json", z.object({ token: tokenField, password: z.string().min(10).max(256) })),
    async (c) => {
      if (config_.authDisablePassword) {
        return apiError(c, 403, "PASSWORD_DISABLED", "password auth is disabled on this instance");
      }
      const body = c.req.valid("json");
      const out = await resetPassword(body.token, body.password);
      if (!out.ok) {
        return apiError(
          c,
          400,
          "RESET_TOKEN_INVALID",
          "this reset link is expired or was already used — request a new one",
        );
      }
      return c.json({ ok: true, sessionsRevoked: out.sessionsRevoked });
    },
  )
  .post(
    "/verify-email",
    authLimiter,
    zValidator("json", z.object({ token: tokenField })),
    async (c) => {
      const out = await verifyEmail(c.req.valid("json").token);
      if (!out) {
        return apiError(
          c,
          400,
          "VERIFY_TOKEN_INVALID",
          "this confirmation link is expired or was already used — send a new one from Settings > Account",
        );
      }
      return c.json({ ok: true });
    },
  );

// ── signed-in: mounted under /v1 ────────────────────────────────────────────

export const accountRoutes = new Hono()
  .post("/me/verify-email/resend", async (c) => {
    const denied = humanOnly(c, "resending the confirmation email");
    if (denied) return denied;
    const out = await sendVerificationEmail(c.get("session")!.userId, { resend: true });
    return c.json({ ok: true, status: out }, out === "sent" ? 202 : 200);
  })
  .get("/me/export", async (c) => {
    const denied = humanOnly(c, "personal data export");
    if (denied) return denied;
    const userId = c.get("session")!.userId;
    await audit("personal_export", { userId });
    c.header("content-type", "application/json; charset=utf-8");
    c.header("content-disposition", `attachment; filename="tallyline-personal-${stamp()}.json"`);
    c.header("cache-control", "no-store");
    return stream(c, async (s) => {
      await streamPersonalExport(userId, (chunk) => s.write(chunk).then(() => undefined));
    });
  })
  .post("/me/deletion", zValidator("json", confirmField), async (c) => {
    const denied = humanOnly(c, "account deletion");
    if (denied) return denied;
    const session = c.get("session")!;
    const [u] = await db.select().from(users).where(eq(users.id, session.userId));
    if (!u) return apiError(c, 404, "NOT_FOUND", "account not found");
    if (c.req.valid("json").confirm.trim().toLowerCase() !== u.email.trim().toLowerCase()) {
      return apiError(c, 400, "CONFIRM_MISMATCH", "type your account email exactly to confirm");
    }
    try {
      await deleteAccount(u.id);
    } catch (err) {
      if (err instanceof SoleOwnerError) return apiError(c, 409, "SOLE_OWNER", err.userMessage);
      throw err;
    }
    setCookie(c, SESSION_COOKIE, "", { maxAge: 0, path: "/" });
    return c.json({ ok: true });
  })
  // dev-only inbox for the log mail transport; 404 in production or when a
  // real transport is configured. Instance admins only: it holds live links.
  .get("/dev/mail", async (c) => {
    // existence is decided first: in production (or with a real transport) the
    // endpoint is a 404 for everyone, admin or not, never a 403 that hints at it
    if (!devInboxEnabled()) {
      return apiError(c, 404, "DEV_INBOX_DISABLED", "the dev inbox exists only with MAIL_TRANSPORT=log outside production");
    }
    const denied = humanOnly(c, "the dev inbox");
    if (denied) return denied;
    const session = c.get("session")!;
    if (!(await isInstanceAdmin({ id: session.userId, email: (await emailOf(session.userId)) ?? "" }))) {
      return apiError(c, 403, "FORBIDDEN_INSTANCE_ADMIN", "the dev inbox is for instance admins");
    }
    return c.json({ messages: devInbox() });
  })
  .get("/workspaces/:ws/export", async (c) => {
    const denied = humanOnly(c, "workspace export");
    if (denied) return denied;
    const ws = await requireWorkspace(c, { allowDeleted: true });
    requireRole(c, "admin");
    const userId = c.get("session")!.userId;
    await audit("workspace_exported", { userId, meta: { workspaceId: ws.id } });
    c.header("content-type", "application/json; charset=utf-8");
    c.header("content-disposition", `attachment; filename="tallyline-${ws.slug}-${stamp()}.json"`);
    c.header("cache-control", "no-store");
    return stream(c, async (s) => {
      await streamWorkspaceExport(ws.id, (chunk) => s.write(chunk).then(() => undefined));
    });
  })
  .post("/workspaces/:ws/deletion", zValidator("json", confirmField), async (c) => {
    const denied = humanOnly(c, "workspace deletion");
    if (denied) return denied;
    const ws = await requireWorkspace(c, { allowDeleted: true });
    requireRole(c, "owner");
    if (ws.deletedAt) {
      return apiError(c, 409, "ALREADY_SCHEDULED", "this workspace is already scheduled for deletion");
    }
    if (c.req.valid("json").confirm.trim() !== ws.slug) {
      return apiError(c, 400, "CONFIRM_MISMATCH", `type the workspace slug '${ws.slug}' exactly to confirm`);
    }
    const out = await scheduleWorkspaceDeletion(ws.id, c.get("session")!.userId);
    return c.json({ slug: out.slug, deletedAt: out.deletedAt, purgeAfter: out.purgeAfter }, 202);
  })
  .post("/workspaces/:ws/restore", async (c) => {
    const denied = humanOnly(c, "workspace restore");
    if (denied) return denied;
    const ws = await requireWorkspace(c, { allowDeleted: true });
    requireRole(c, "owner");
    if (!ws.deletedAt) {
      return apiError(c, 409, "NOT_DELETED", "this workspace is not scheduled for deletion");
    }
    const restored = await restoreWorkspace(ws.id, c.get("session")!.userId);
    if (!restored) return apiError(c, 409, "NOT_DELETED", "this workspace is not scheduled for deletion");
    return c.json({ slug: restored.slug, deletedAt: null, purgeAfter: null });
  });

async function emailOf(userId: string): Promise<string | null> {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return u?.email ?? null;
}
