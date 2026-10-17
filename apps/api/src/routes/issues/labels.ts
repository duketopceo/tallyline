// Workspace label CRUD.
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/client.js";
import { labels } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { requireWorkspace } from "../workspaces.js";

export const labelRoutes = new Hono()
  .post(
    "/workspaces/:ws/labels",
    zValidator(
      "json",
      z.object({
        name: z.string().min(1).max(60),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        teamKey: z.string().optional(),
      }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      const [label] = await db
        .insert(labels)
        .values({ workspaceId: ws.id, name: body.name, color: body.color })
        .returning();
      return c.json(label, 201);
    },
  )
  .get("/workspaces/:ws/labels", async (c) => {
    const ws = await requireWorkspace(c);
    const rows = await db
      .select()
      .from(labels)
      .where(eq(labels.workspaceId, ws.id));
    return c.json({ labels: rows });
  })
  .patch(
    "/workspaces/:ws/labels/:id",
    zValidator(
      "json",
      z.object({
        name: z.string().min(1).max(60).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      const [row] = await db
        .update(labels)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
        })
        .where(
          and(eq(labels.id, c.req.param("id")), eq(labels.workspaceId, ws.id)),
        )
        .returning();
      if (!row) throw new HttpError(404, "NOT_FOUND", "label not found");
      return c.json(row);
    },
  )
  .delete("/workspaces/:ws/labels/:id", async (c) => {
    const ws = await requireWorkspace(c);
    const [row] = await db
      .delete(labels)
      .where(
        and(eq(labels.id, c.req.param("id")), eq(labels.workspaceId, ws.id)),
      )
      .returning({ id: labels.id });
    if (!row) throw new HttpError(404, "NOT_FOUND", "label not found");
    return c.json({ ok: true });
  })
;
