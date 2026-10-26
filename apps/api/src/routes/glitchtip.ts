import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { glitchtipIntegrations } from "../db/schema.js";
import { config_ } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { clock } from "../services/clock.js";
import {
  missingTeamKeys,
  mintGlitchtipToken,
  normalizeProjectMap,
  type GlitchtipIntegration,
  webhookPath,
} from "../services/glitchtip.js";
import { requireRole } from "../services/members.js";
import { requireWorkspace } from "./workspaces.js";

const teamKey = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .transform((s) => s.toUpperCase());

const configSchema = z.object({
  projectMap: z.record(z.string().min(1).max(200), teamKey).optional(),
  defaultTeamKey: teamKey.nullable().optional(),
  enabled: z.boolean().optional(),
});

function present(row: GlitchtipIntegration) {
  return {
    id: row.id,
    configured: true,
    enabled: row.enabled,
    tokenLast4: row.tokenLast4,
    glitchtipHost: row.glitchtipHost,
    projectMap: row.projectMap,
    defaultTeamKey: row.defaultTeamKey,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    lastReceivedAt: row.lastReceivedAt,
  };
}

function reveal(token: string) {
  return {
    token,
    webhookUrl: `${config_.apiBaseUrl}${webhookPath(token)}`,
  };
}

async function assertTeamsExist(
  workspaceId: string,
  keys: string[],
): Promise<void> {
  const missing = await missingTeamKeys(workspaceId, keys);
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "UNKNOWN_TEAM",
      `team not found: ${missing.join(", ")}`,
    );
  }
}

async function load(workspaceId: string) {
  const [row] = await db
    .select()
    .from(glitchtipIntegrations)
    .where(eq(glitchtipIntegrations.workspaceId, workspaceId));
  return row;
}

export const glitchtipRoutes = new Hono()
  .get("/workspaces/:ws/glitchtip", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const row = await load(ws.id);
    return c.json({ integration: row ? present(row) : null });
  })
  // create, or update the project map / default team / enabled flag
  .put(
    "/workspaces/:ws/glitchtip",
    zValidator("json", configSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const body = c.req.valid("json");
      const projectMap = body.projectMap
        ? normalizeProjectMap(body.projectMap)
        : undefined;
      await assertTeamsExist(ws.id, [
        ...Object.values(projectMap ?? {}),
        ...(body.defaultTeamKey ? [body.defaultTeamKey] : []),
      ]);

      const existing = await load(ws.id);
      if (!existing) {
        const { token, tokenHash, tokenLast4 } = mintGlitchtipToken();
        const [row] = await db
          .insert(glitchtipIntegrations)
          .values({
            workspaceId: ws.id,
            tokenHash,
            tokenLast4,
            projectMap: projectMap ?? {},
            defaultTeamKey: body.defaultTeamKey ?? null,
            enabled: body.enabled ?? true,
          })
          .returning();
        // the secret is shown once, here
        return c.json({ integration: present(row!), ...reveal(token) }, 201);
      }
      const [row] = await db
        .update(glitchtipIntegrations)
        .set({
          ...(projectMap ? { projectMap } : {}),
          ...(body.defaultTeamKey !== undefined
            ? { defaultTeamKey: body.defaultTeamKey }
            : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        })
        .where(eq(glitchtipIntegrations.id, existing.id))
        .returning();
      return c.json({ integration: present(row!) });
    },
  )
  // new secret; the old one stops working immediately
  .post("/workspaces/:ws/glitchtip/rotate", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const existing = await load(ws.id);
    if (!existing) {
      throw new HttpError(404, "NOT_FOUND", "glitchtip integration not set up");
    }
    const { token, tokenHash, tokenLast4 } = mintGlitchtipToken();
    const [row] = await db
      .update(glitchtipIntegrations)
      .set({
        tokenHash,
        tokenLast4,
        rotatedAt: clock.now(),
      })
      .where(eq(glitchtipIntegrations.id, existing.id))
      .returning();
    return c.json({ integration: present(row!), ...reveal(token) });
  })
  .delete("/workspaces/:ws/glitchtip", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const [row] = await db
      .delete(glitchtipIntegrations)
      .where(eq(glitchtipIntegrations.workspaceId, ws.id))
      .returning({ id: glitchtipIntegrations.id });
    if (!row) throw new HttpError(404, "NOT_FOUND", "glitchtip integration not set up");
    return c.json({ ok: true });
  });
