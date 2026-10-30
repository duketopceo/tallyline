import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { ackAgentInbox, listAgentInbox } from "../services/agent-inbox.js";
import { requireWorkspace } from "./workspaces.js";

// U20: an agent's own inbox of mentions and answered questions. Agent keys
// only — the agent id comes from the credential, never from the request, so
// one agent cannot read another's inbox.
function requireAgent(c: {
  get: (k: "agentAuth") => { agentId: string } | null;
}): { agentId: string } {
  const agent = c.get("agentAuth");
  if (!agent) {
    throw new HttpError(
      403,
      "FORBIDDEN_AGENT",
      "the agent inbox is for agent credentials",
    );
  }
  return agent;
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ackBody = z.object({ through: z.iso.datetime() });

export const agentInboxRoutes = new Hono()
  .get(
    "/workspaces/:ws/agent-inbox",
    zValidator("query", listQuery),
    async (c) => {
      const ws = await requireWorkspace(c);
      const agent = requireAgent(c);
      const { limit } = c.req.valid("query");
      return c.json(await listAgentInbox(ws.id, agent.agentId, limit));
    },
  )
  .post(
    "/workspaces/:ws/agent-inbox/ack",
    zValidator("json", ackBody),
    async (c) => {
      const ws = await requireWorkspace(c);
      const agent = requireAgent(c);
      const { through } = c.req.valid("json");
      const ackedAt = await ackAgentInbox(ws.id, agent.agentId, new Date(through));
      return c.json({ ackedAt });
    },
  );
