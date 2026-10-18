import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { agentKeys, agents, events } from "../db/schema.js";
import { apiError, HttpError } from "../lib/errors.js";
import { assertSafeOutboundUrl } from "../lib/net-guard.js";
import {
  createAgentKey,
  defaultKeyExpiry,
  MAX_ROTATE_GRACE_SECONDS,
  revokeAgentKey,
  rotateAgentKey,
} from "../services/agents.js";
import { requireRole } from "../services/members.js";
import { isCookieSession } from "./auth.js";
import { requireWorkspace } from "./workspaces.js";
import { clock } from "../services/clock.js";

const AGENT_SCOPES = ["read", "write"] as const;

const agentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case identifier"),
  harness: z.string().min(1).max(80),
  endpointUrl: z.url().optional(),
  capabilities: z.array(z.string().max(80)).max(20).default([]),
});

const keySchema = z.object({
  name: z.string().min(1).max(80).default("default"),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1).default(["read"]),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const rotateSchema = z.object({
  graceSeconds: z.number().int().min(0).max(MAX_ROTATE_GRACE_SECONDS).default(0),
});

// Key management is admin + human session only. Agent credentials get
// FORBIDDEN_AGENT; PATs and OAuth JWTs are not cookie sessions either.
function requireKeyAdmin(c: Context): Response | { userId: string } {
  if (c.get("agentAuth")) {
    return apiError(c, 403, "FORBIDDEN_AGENT", "agent credentials cannot manage keys");
  }
  if (!isCookieSession(c)) {
    return apiError(c, 403, "FORBIDDEN", "key management requires a human session");
  }
  return { userId: c.get("session")!.userId };
}

// Agent management requires a human session — agents cannot mint agents.
export const agentRoutes = new Hono()
  .post(
    "/workspaces/:ws/agents",
    zValidator("json", agentSchema),
    async (c) => {
      if (!isCookieSession(c)) {
        return apiError(c, 403, "FORBIDDEN", "agent registry requires a human session");
      }
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const body = c.req.valid("json");
      if (body.endpointUrl) {
        try {
          await assertSafeOutboundUrl(body.endpointUrl);
        } catch (err) {
          throw new HttpError(
            422,
            "UNSAFE_URL",
            err instanceof Error ? err.message : "endpoint URL rejected",
          );
        }
      }
      const dup = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.workspaceId, ws.id), eq(agents.name, body.name)),
        );
      if (dup.length > 0) {
        throw new HttpError(409, "CONFLICT", "agent name already exists");
      }
      const [agent] = await db
        .insert(agents)
        .values({
          workspaceId: ws.id,
          name: body.name,
          harness: body.harness,
          endpointUrl: body.endpointUrl ?? null,
          capabilities: body.capabilities,
        })
        .returning();
      return c.json(agent, 201);
    },
  )
  .get("/workspaces/:ws/agents", async (c) => {
    const ws = await requireWorkspace(c);
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, ws.id))
      .orderBy(asc(agents.name));
    return c.json({ agents: rows });
  })
  .post(
    "/workspaces/:ws/agents/:id/keys",
    zValidator("json", keySchema),
    async (c) => {
      if (!isCookieSession(c)) {
        return apiError(c, 403, "FORBIDDEN", "key minting requires a human session");
      }
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, c.req.param("id")));
      if (!agent || agent.workspaceId !== ws.id) {
        throw new HttpError(404, "NOT_FOUND", "agent not found");
      }
      const body = c.req.valid("json");
      const expiresAt = body.expiresInDays
        ? new Date(clock.ms() + body.expiresInDays * 86_400_000)
        : defaultKeyExpiry();
      const { key, id } = await createAgentKey(
        agent.id,
        ws.id,
        body.name,
        body.scopes,
        expiresAt,
      );
      // plaintext shown once — only the hash is stored
      return c.json({ id, key, scopes: body.scopes, expiresAt: expiresAt ?? null }, 201);
    },
  )
  .get("/workspaces/:ws/agents/:id/keys", async (c) => {
    if (!isCookieSession(c)) {
      return apiError(c, 403, "FORBIDDEN", "key listing requires a human session");
    }
    const ws = await requireWorkspace(c);
    const rows = await db
      .select({
        id: agentKeys.id,
        name: agentKeys.name,
        scopes: agentKeys.scopes,
        expiresAt: agentKeys.expiresAt,
        lastUsedAt: agentKeys.lastUsedAt,
        createdAt: agentKeys.createdAt,
      })
      .from(agentKeys)
      .where(
        and(
          eq(agentKeys.agentId, c.req.param("id")),
          eq(agentKeys.workspaceId, ws.id),
        ),
      );
    return c.json({ keys: rows });
  })
  .delete("/workspaces/:ws/agents/:id/keys/:keyId", async (c) => {
    const actor = requireKeyAdmin(c);
    if (actor instanceof Response) return actor;
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const { id, keyId } = c.req.param();
    if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(keyId).success) {
      throw new HttpError(404, "NOT_FOUND", "key not found");
    }
    const removed = await revokeAgentKey(id, ws.id, keyId);
    if (!removed) throw new HttpError(404, "NOT_FOUND", "key not found");
    await db.insert(events).values({
      workspaceId: ws.id,
      entityType: "agent_key",
      entityId: removed.id,
      action: "agent_key_revoked",
      actorType: "human",
      actorId: actor.userId,
      after: { agentId: id, name: removed.name },
    });
    return c.json({ ok: true });
  })
  .post(
    "/workspaces/:ws/agents/:id/keys/:keyId/rotate",
    zValidator("json", rotateSchema),
    async (c) => {
      const actor = requireKeyAdmin(c);
      if (actor instanceof Response) return actor;
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const { id, keyId } = c.req.param();
      if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(keyId).success) {
        throw new HttpError(404, "NOT_FOUND", "key not found");
      }
      const { graceSeconds } = c.req.valid("json");
      const next = await rotateAgentKey(id, ws.id, keyId, graceSeconds);
      if (!next) throw new HttpError(404, "NOT_FOUND", "key not found");
      await db.insert(events).values({
        workspaceId: ws.id,
        entityType: "agent_key",
        entityId: keyId,
        action: "agent_key_rotated",
        actorType: "human",
        actorId: actor.userId,
        after: {
          agentId: id,
          name: next.name,
          newKeyId: next.id,
          graceSeconds,
          oldExpiresAt: next.oldExpiresAt.toISOString(),
        },
      });
      // plaintext shown once — only the hash is stored
      return c.json(
        {
          id: next.id,
          key: next.key,
          name: next.name,
          scopes: next.scopes,
          expiresAt: next.expiresAt,
          replacesKeyId: keyId,
          oldKeyValidUntil: next.oldExpiresAt,
        },
        201,
      );
    },
  );
