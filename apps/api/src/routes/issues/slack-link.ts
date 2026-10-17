// Slack thread linkage on issues.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db/client.js";
import { slackLinks } from "../../db/schema.js";
import { requireWorkspace } from "../workspaces.js";
import { findIssue } from "./shared.js";

export const slackLinkRoutes = new Hono()
  .get("/workspaces/:ws/issues/:key/slack-link", async (c) => {
    const ws = await requireWorkspace(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    const [link] = await db
      .select()
      .from(slackLinks)
      .where(eq(slackLinks.issueId, issue.id));
    return c.json({ link: link ?? null });
  })
  .delete("/workspaces/:ws/issues/:key/slack-link", async (c) => {
    const ws = await requireWorkspace(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    await db.delete(slackLinks).where(eq(slackLinks.issueId, issue.id));
    return c.json({ ok: true });
  });
