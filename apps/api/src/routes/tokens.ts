import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { events, userTokens } from "../db/schema.js";
import { apiError } from "../lib/errors.js";
import { isCookieSession, requireVerifiedEmail } from "./auth.js";
import { requireRole } from "../services/members.js";
import { createUserToken, revokeUserToken } from "../services/tokens.js";
import { requireWorkspace } from "./workspaces.js";

const mintSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(["read", "write"])).min(1).default(["read"]),
  expiresAt: z.iso.datetime().optional(),
});

// Personal access tokens are minted from a live human session only —
// delegated credentials (PATs, JWTs) and agent keys cannot mint or
// enumerate further credentials.
export const tokenRoutes = new Hono()
  .post(
    "/workspaces/:ws/tokens",
    zValidator("json", mintSchema),
    async (c) => {
      const session = c.get("session");
      if (!isCookieSession(c) || !session) {
        return apiError(
          c,
          403,
          "FORBIDDEN",
          "token minting requires a human session",
        );
      }
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      await requireVerifiedEmail(c);
      const body = c.req.valid("json");
      const lowered = body.name.toLowerCase();
      if (lowered.includes("tly_")) {
        return apiError(c, 422, "BAD_NAME", "name may not contain 'tly_'");
      }
      const { token, id } = await createUserToken(
        session.userId,
        ws.id,
        body.name,
        body.scopes,
        body.expiresAt ? new Date(body.expiresAt) : undefined,
      );
      // name and scopes only: the secret is never written anywhere but the hash
      await db.insert(events).values({
        workspaceId: ws.id,
        entityType: "user_token",
        entityId: id,
        action: "token_created",
        actorType: "human",
        actorId: session.userId,
        after: { name: body.name, scopes: body.scopes },
      });
      return c.json({ id, token, scopes: body.scopes }, 201);
    },
  )
  .get("/workspaces/:ws/tokens", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "requires a human session");
    }
    const ws = await requireWorkspace(c);
    const rows = await db
      .select({
        id: userTokens.id,
        name: userTokens.name,
        scopes: userTokens.scopes,
        expiresAt: userTokens.expiresAt,
        lastUsedAt: userTokens.lastUsedAt,
        createdAt: userTokens.createdAt,
      })
      .from(userTokens)
      .where(
        and(
          eq(userTokens.workspaceId, ws.id),
          eq(userTokens.userId, session.userId),
        ),
      )
      .orderBy(asc(userTokens.createdAt));
    return c.json({ tokens: rows });
  })
  .delete("/workspaces/:ws/tokens/:id", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "requires a human session");
    }
    const ws = await requireWorkspace(c);
    const revoked = await revokeUserToken(
      c.req.param("id"),
      session.userId,
      ws.id,
    );
    if (!revoked) return apiError(c, 404, "NOT_FOUND", "token not found");
    await db.insert(events).values({
      workspaceId: ws.id,
      entityType: "user_token",
      entityId: c.req.param("id"),
      action: "token_revoked",
      actorType: "human",
      actorId: session.userId,
    });
    return c.json({ ok: true });
  });
