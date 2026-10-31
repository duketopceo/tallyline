import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { resolveProvider } from "../services/ai-providers.js";
import { aiEnabledFor, requireAi } from "../services/ai-seam.js";
import { createAssist } from "../services/assist.js";
import { draftProjectUpdate } from "../services/project-update-draft.js";
import { HttpError } from "../lib/errors.js";
import { findProject } from "./project-updates.js";
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
    // an unreadable saved key still counts as on, matching requireAi; calls
    // then fail with the plain AI_KEY_UNREADABLE message
    const enabled = await aiEnabledFor(ws.id);
    const p = await resolveProvider(ws.id).catch(() => null);
    return c.json({ enabled, model: p?.model ?? null, source: p?.source ?? null });
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
  // S3-U4b: the three remaining drafts. Each returns text for a person to
  // edit; none of them writes anything.
  .post("/workspaces/:ws/projects/:id/update-draft/polish", async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    const draft = await draftProjectUpdate(project);
    // nothing happened in the window: there is nothing to word, so no call
    if (draft.empty) return c.json({ ...draft, polished: false });
    await requireAi(ws.id);
    const body = await assist.polishProjectUpdate(ws.id, project.name, draft);
    return c.json({ ...draft, body, factsBody: draft.body, polished: true });
  })
  .post("/workspaces/:ws/issues/:key/pr-brief", async (c) => {
    const ws = await requireWorkspace(c);
    await requireAi(ws.id);
    return c.json({ brief: await assist.draftPrBrief(ws.id, c.req.param("key")) });
  })
  .post("/workspaces/:ws/agent-sessions/:id/answer-draft", async (c) => {
    const ws = await requireWorkspace(c);
    // the reply is a person's voice; agents answer their own questions elsewhere
    if (c.get("agentAuth")) {
      throw new HttpError(403, "FORBIDDEN_AGENT", "answer drafts are for people answering an agent");
    }
    await requireAi(ws.id);
    return c.json(await assist.draftAnswer(ws.id, c.req.param("id")));
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
