import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { teams, users, workspaceMembers, workspaces } from "../db/schema.js";
import { apiError, HttpError } from "../lib/errors.js";
import { isInstanceAdmin, memberOf, requireRole } from "../services/members.js";
import { isValidTimezone } from "../services/cycle-schedule.js";
import { config_ } from "../env.js";
import { isCookieSession } from "./auth.js";
import { assertWithinLimit } from "../services/entitlements.js";
import { countApiCall } from "../services/usage.js";

const createWorkspaceSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
});

const createTeamSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Z][A-Z0-9]*$/),
  name: z.string().min(1).max(120),
  rolloverBehavior: z.enum(["next_cycle", "backlog"]).default("next_cycle"),
});

const patchTeamSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  rolloverBehavior: z.enum(["next_cycle", "backlog"]).optional(),
  cycleAutoEnabled: z.boolean().optional(),
  cycleLengthDays: z.number().int().min(1).max(28).optional(),
  cycleStartWeekday: z.number().int().min(0).max(6).optional(),
  cycleUpcomingCount: z.number().int().min(1).max(6).optional(),
  timezone: z
    .string()
    .max(64)
    .refine(isValidTimezone, { message: "unknown IANA timezone" })
    .nullable()
    .optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), {
  message: "patch body must set at least one field",
});

export const workspaceRoutes = new Hono()
  .post("/workspaces", zValidator("json", createWorkspaceSchema), async (c) => {
    // Humans mint workspaces; delegated credentials and agent keys cannot —
    // the workspace is the security boundary an org pays for.
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "workspace creation requires a human session",
      );
    }
    if (!config_.allowWorkspaceCreate) {
      const [u] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, session.userId));
      const admin = u && (await isInstanceAdmin({ id: session.userId, email: u.email }));
      if (!admin) {
        return apiError(
          c,
          403,
          "FORBIDDEN_INSTANCE_ADMIN",
          "workspace creation is limited to instance admins (set TALLYLINE_ALLOW_WORKSPACE_CREATE=1 to allow all members)",
        );
      }
    }
    const body = c.req.valid("json");
    const existing = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, body.slug));
    if (existing.length > 0) {
      return apiError(c, 409, "CONFLICT", `workspace '${body.slug}' exists`);
    }
    // billing on: a new workspace starts on Free, capped per owner
    await assertWithinLimit("workspaces", session.userId);
    const [ws] = await db.insert(workspaces).values(body).returning();
    await db.insert(workspaceMembers).values({
      workspaceId: ws!.id,
      userId: session.userId,
      role: "owner",
    });
    return c.json(ws, 201);
  })
  // readable while pending deletion so the client can show the restore path
  .get("/workspaces/:ws", async (c) => {
    const ws = await requireWorkspace(c, { allowDeleted: true });
    return c.json(ws);
  })
  // declared email domains for the SSO domain-match rung (R17) — the only
  // write path for workspaces.allowed_domains
  .patch(
    "/workspaces/:ws",
    zValidator(
      "json",
      z.object({
        name: z.string().min(1).max(120).optional(),
        allowedDomains: z.array(z.string().min(1).max(253)).optional(),
      }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const body = c.req.valid("json");
      const [updated] = await db
        .update(workspaces)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.allowedDomains !== undefined
            ? { allowedDomains: body.allowedDomains.map((d) => d.trim().toLowerCase()) }
            : {}),
        })
        .where(eq(workspaces.id, ws.id))
        .returning();
      return c.json(updated);
    },
  )
  .post(
    "/workspaces/:ws/teams",
    zValidator("json", createTeamSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      const [existing] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.workspaceId, ws.id), eq(teams.key, body.key)));
      if (existing) {
        return apiError(c, 409, "CONFLICT", `team key '${body.key}' exists`);
      }
      const [team] = await db
        .insert(teams)
        .values({
          workspaceId: ws.id,
          key: body.key,
          name: body.name,
          rolloverBehavior: body.rolloverBehavior,
        })
        .returning();
      return c.json(team, 201);
    },
  )
  .get("/workspaces/:ws/teams", async (c) => {
    const ws = await requireWorkspace(c);
    const rows = await db
      .select()
      .from(teams)
      .where(eq(teams.workspaceId, ws.id));
    return c.json({ teams: rows });
  })
  .patch(
    "/workspaces/:ws/teams/:id",
    zValidator("json", patchTeamSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      const [team] = await db
        .update(teams)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.rolloverBehavior !== undefined
            ? { rolloverBehavior: body.rolloverBehavior }
            : {}),
          ...(body.cycleAutoEnabled !== undefined
            ? { cycleAutoEnabled: body.cycleAutoEnabled }
            : {}),
          ...(body.cycleLengthDays !== undefined
            ? { cycleLengthDays: body.cycleLengthDays }
            : {}),
          ...(body.cycleStartWeekday !== undefined
            ? { cycleStartWeekday: body.cycleStartWeekday }
            : {}),
          ...(body.cycleUpcomingCount !== undefined
            ? { cycleUpcomingCount: body.cycleUpcomingCount }
            : {}),
          ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        })
        .where(
          and(
            eq(teams.id, c.req.param("id")),
            eq(teams.workspaceId, ws.id),
          ),
        )
        .returning();
      if (!team) return apiError(c, 404, "NOT_FOUND", "team not found");
      return c.json(team);
    },
  );

export async function findWorkspace(slug: string) {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, slug));
  return ws ?? null;
}

// Per-class access matrix (KTD4):
// - cookie sessions roam: membership in the URL workspace is the gate,
//   sessions.workspaceId only seeds where login lands
// - PATs/JWTs stay hard-bound to their minted workspace AND require a live
//   membership — a removed member's token dies on the next request
// - agent keys stay hard-bound; agents are never members (R24)
// On success, memberRole is injected for role gates.
// A workspace pending deletion is closed to every route (410) except the
// few that opt in with allowDeleted (read, export, restore) — and only after
// the same credential/membership checks, so 410 never leaks existence.
export async function requireWorkspace(
  c: Context,
  opts: { allowDeleted?: boolean } = {},
) {
  const ws = await findWorkspace(c.req.param("ws") ?? "");
  if (!ws) throw new HttpError(404, "NOT_FOUND", "workspace not found");
  const resolved = await authorizeWorkspace(c, ws);
  if (resolved.deletedAt && !opts.allowDeleted) {
    throw new HttpError(
      410,
      "WORKSPACE_DELETED",
      `workspace '${ws.slug}' is scheduled for deletion — an owner can restore it in Settings > Workspace`,
    );
  }
  return resolved;
}

async function authorizeWorkspace(
  c: Context,
  ws: NonNullable<Awaited<ReturnType<typeof findWorkspace>>>,
) {
  const session = c.get("session");
  const agent = c.get("agentAuth");
  if (agent) {
    if (agent.workspaceId !== ws.id) {
      throw new HttpError(403, "FORBIDDEN_WORKSPACE", "credential not scoped to this workspace");
    }
    c.set("memberRole", null);
    countApiCall(ws.id);
    return ws;
  }
  if (session) {
    const delegated =
      session.sessionId.startsWith("pat:") ||
      session.sessionId.startsWith("jwt:");
    if (delegated && session.workspaceId !== ws.id) {
      throw new HttpError(403, "FORBIDDEN_WORKSPACE", "credential not scoped to this workspace");
    }
    const member = await memberOf(session.userId, ws.id);
    if (!member) {
      throw new HttpError(403, "FORBIDDEN_WORKSPACE", "not a member of this workspace");
    }
    c.set("memberRole", member.role);
    countApiCall(ws.id);
    return ws;
  }
  throw new HttpError(401, "UNAUTHENTICATED", "sign in or present agent credentials");
}
