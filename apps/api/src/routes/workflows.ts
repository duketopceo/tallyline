import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  agents,
  workflowDefinitions,
  workflowTriggers,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { clock } from "../services/clock.js";
import { requireWorkspace } from "./workspaces.js";

const workflowCreateSchema = z.object({
  name: z.string().min(1).max(160),
  trigger: z.enum(workflowTriggers),
  condition: z.record(z.string(), z.unknown()).default({}),
  action: z.record(z.string(), z.unknown()),
  enabled: z.boolean().default(true),
});

export const workflowRoutes = new Hono()
  .get("/workspaces/:ws/workflows", async (c) => {
    const ws = await requireWorkspace(c);
    const rows = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.workspaceId, ws.id))
      .orderBy(asc(workflowDefinitions.createdAt));
    return c.json({ workflows: rows });
  })
  .post(
    "/workspaces/:ws/workflows",
    zValidator("json", workflowCreateSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      if (typeof body.action.agentId === "string") {
        const [a] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.id, body.action.agentId),
              eq(agents.workspaceId, ws.id),
            ),
          );
        if (!a) {
          throw new HttpError(
            422,
            "INVALID_AGENT",
            "agent not in workspace",
          );
        }
      }
      const [row] = await db
        .insert(workflowDefinitions)
        .values({
          workspaceId: ws.id,
          name: body.name,
          trigger: body.trigger,
          condition: body.condition,
          action: body.action,
          enabled: body.enabled,
          createdAt: clock.now(),
        })
        .returning();
      return c.json({ ...row!, workflow: row! }, 201);
    },
  );
