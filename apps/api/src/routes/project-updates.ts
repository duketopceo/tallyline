// Project status updates (U14, R13): a dated health note per project, drafted
// from the event log and posted by a human or an agent.
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { events, projects, projectUpdateHealth, projectUpdates } from "../db/schema.js";
import { actorFromHeaders } from "../lib/actor.js";
import { HttpError } from "../lib/errors.js";
import { draftProjectUpdate } from "../services/project-update-draft.js";
import { requireWorkspace } from "./workspaces.js";

const postSchema = z.object({
  health: z.enum(projectUpdateHealth),
  body: z.string().trim().min(1).max(20_000),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function findProject(workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)));
  if (!row) throw new HttpError(404, "NOT_FOUND", "project not found");
  return row;
}

export const projectUpdateRoutes = new Hono()
  .get("/workspaces/:ws/projects/:id/update-draft", async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    return c.json(await draftProjectUpdate(project));
  })
  .get(
    "/workspaces/:ws/projects/:id/updates",
    zValidator("query", listQuery),
    async (c) => {
      const ws = await requireWorkspace(c);
      const project = await findProject(ws.id, c.req.param("id"));
      const q = c.req.valid("query");
      const rows = await db
        .select()
        .from(projectUpdates)
        .where(eq(projectUpdates.projectId, project.id))
        .orderBy(desc(projectUpdates.createdAt))
        .limit(q.limit);
      return c.json({ updates: rows });
    },
  )
  .post(
    "/workspaces/:ws/projects/:id/updates",
    zValidator("json", postSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const project = await findProject(ws.id, c.req.param("id"));
      const actor = actorFromHeaders(c);
      const body = c.req.valid("json");
      const update = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(projectUpdates)
          .values({
            workspaceId: ws.id,
            projectId: project.id,
            health: body.health,
            body: body.body,
            authorType: actor.type,
            authorId: actor.id ?? null,
          })
          .returning();
        await tx.insert(events).values({
          workspaceId: ws.id,
          entityType: "project",
          entityId: project.id,
          action: "update_posted",
          actorType: actor.type,
          actorId: actor.id ?? null,
          after: { updateId: row!.id, health: body.health },
        });
        return row!;
      });
      return c.json(update, 201);
    },
  );
