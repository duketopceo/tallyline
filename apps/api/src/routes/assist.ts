import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { resolveProvider } from "../services/ai-providers.js";
import { requireAi } from "../services/ai-seam.js";
import { createAssist } from "../services/assist.js";
import { requireWorkspace } from "./workspaces.js";

const assist = createAssist();

const dupCheckSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
});

export const assistRoutes = new Hono()
  .get("/workspaces/:ws/llm/status", async (c) => {
    const ws = await requireWorkspace(c);
    // model name is not a secret: the UI shows what it would call
    const p = await resolveProvider(ws.id).catch(() => null);
    return c.json({ enabled: p !== null, model: p?.model ?? null, source: p?.source ?? null });
  })
  .post("/workspaces/:ws/issues/:key/summarize", async (c) => {
    const ws = await requireWorkspace(c);
    await requireAi(ws.id);
    const summary = await assist.summarizeIssue(ws.id, c.req.param("key"));
    return c.json({ summary });
  })
  .post("/workspaces/:ws/issues/:key/triage-suggest", async (c) => {
    const ws = await requireWorkspace(c);
    await requireAi(ws.id);
    return c.json(await assist.suggestTriage(ws.id, c.req.param("key")));
  })
  .post("/workspaces/:ws/issues/:key/breakdown-suggest", async (c) => {
    const ws = await requireWorkspace(c);
    await requireAi(ws.id);
    const subIssues = await assist.suggestSubIssues(ws.id, c.req.param("key"));
    // suggestions only: nothing is created until a person picks them
    return c.json({ subIssues });
  })
  .post(
    "/workspaces/:ws/issues/dup-check",
    zValidator("json", dupCheckSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      await requireAi(ws.id);
      const body = c.req.valid("json");
      const duplicates = await assist.checkDuplicates(
        ws.id,
        body.title,
        body.description,
      );
      return c.json({ duplicates });
    },
  );
