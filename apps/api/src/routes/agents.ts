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
import { isCookieSession, requireVerifiedEmail } from "./auth.js";
import { requireWorkspace } from "./workspaces.js";
import { clock } from "../services/clock.js";
import { assertWithinLimit } from "../services/entitlements.js";

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
  skills: z.array(z.string().min(1).max(80)).max(50).default([]),
});

const patchAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case identifier")
    .optional(),
  harness: z.string().min(1).max(80).optional(),
  endpointUrl: z.url().nullable().optional(),
  capabilities: z.array(z.string().max(80)).max(20).optional(),
  skills: z.array(z.string().min(1).max(80)).max(50).optional(),
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
      await assertWithinLimit("agents", ws.id);
      const [agent] = await db
        .insert(agents)
        .values({
          workspaceId: ws.id,
          name: body.name,
          harness: body.harness,
          endpointUrl: body.endpointUrl ?? null,
          capabilities: body.capabilities,
          skills: Array.from(new Set(body.skills)),
        })
        .returning();
      try {
        await assertWithinLimit("agents", ws.id, 0); // lost a race? undo
      } catch (err) {
        await db.delete(agents).where(eq(agents.id, agent!.id));
        throw err;
      }
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
    const skillFilterRaw = c.req.query("skill") ?? c.req.query("skills");
    const requiredSkills = skillFilterRaw
      ? skillFilterRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const filtered =
      requiredSkills.length > 0
        ? rows.filter((r) =>
            requiredSkills.every((s) => (r.skills ?? []).includes(s)),
          )
        : rows;
    return c.json({ agents: filtered });
  })
  // plan L8: skills are settable via PATCH — by path id or body id
  .patch(
    "/workspaces/:ws/agents",
    zValidator("json", patchAgentSchema.extend({ id: z.uuid() })),
    async (c) => {
      const body = c.req.valid("json");
      return patchAgent(c, body.id, body);
    },
  )
  .patch(
    "/workspaces/:ws/agents/:id",
    zValidator("json", patchAgentSchema),
    async (c) => patchAgent(c, c.req.param("id"), c.req.valid("json")),
  )
  .post(
    "/workspaces/:ws/agents/:id/keys",
    zValidator("json", keySchema),
    async (c) => {
      if (!isCookieSession(c)) {
        return apiError(c, 403, "FORBIDDEN", "key minting requires a human session");
      }
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      await requireVerifiedEmail(c);
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, c.req.param("id")));
      if (!agent || agent.workspaceId !== ws.id) {
        throw new HttpError(404, "NOT_FOUND", "agent not found");
      }
      await assertWithinLimit("agent_keys", ws.id);
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
    async (c) => {
      const actor = requireKeyAdmin(c);
      if (actor instanceof Response) return actor;
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const { id, keyId } = c.req.param();
      if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(keyId).success) {
        throw new HttpError(404, "NOT_FOUND", "key not found");
      }
      // the body is optional: none means graceSeconds 0
      const raw = (await c.req.text()).trim();
      let input: unknown = {};
      if (raw) {
        try {
          input = JSON.parse(raw);
        } catch {
          return apiError(c, 400, "BAD_REQUEST", "body must be JSON");
        }
      }
      const parsed = rotateSchema.safeParse(input);
      if (!parsed.success) {
        return apiError(c, 400, "BAD_REQUEST", "graceSeconds must be an integer from 0 to 86400");
      }
      const { graceSeconds } = parsed.data;
      const next = await rotateAgentKey(id, ws.id, keyId, graceSeconds, actor.userId);
      if (!next) throw new HttpError(404, "NOT_FOUND", "key not found");
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

async function patchAgent(
  c: Context,
  id: string,
  body: z.infer<typeof patchAgentSchema>,
) {
  if (!isCookieSession(c)) {
    return apiError(c, 403, "FORBIDDEN", "agent registry requires a human session");
  }
  const ws = await requireWorkspace(c);
  requireRole(c, "admin");
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
  const [existing] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.workspaceId, ws.id)));
  if (!existing) throw new HttpError(404, "NOT_FOUND", "agent not found");
  if (body.name !== undefined && body.name !== existing.name) {
    const dup = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.id), eq(agents.name, body.name)));
    if (dup.length > 0) {
      throw new HttpError(409, "CONFLICT", "agent name already exists");
    }
  }
  const [updated] = await db
    .update(agents)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.harness !== undefined ? { harness: body.harness } : {}),
      ...(body.endpointUrl !== undefined ? { endpointUrl: body.endpointUrl } : {}),
      ...(body.capabilities !== undefined ? { capabilities: body.capabilities } : {}),
      ...(body.skills !== undefined ? { skills: Array.from(new Set(body.skills)) } : {}),
    })
    .where(eq(agents.id, existing.id))
    .returning();
  return c.json(updated!);
}
