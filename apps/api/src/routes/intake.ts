import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { actorFromHeaders } from "../lib/actor.js";
import { ingestIntake } from "../services/intake.js";
import { requireWorkspace } from "./workspaces.js";

const intakeSchema = z.object({
  kind: z.enum(["error", "bug", "help", "issue"]),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000).optional(),
  provider: z.string().max(100).optional(),
  fingerprint: z.string().max(500).optional(),
  externalId: z.string().max(500).optional(),
  url: z.string().url().max(2_000).optional(),
  severity: z.enum(["fatal", "error", "warning", "info"]).optional(),
  occurredAt: z.string().max(64).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// Automated intake: GlitchTip, GitHub, help/bug-report senders post normalized
// events here. Session- and agent-key-authed like the rest of /v1 — an agent
// key IS the ingestion credential, so no separate endpoint layer is needed.
export const intakeRoutes = new Hono().post(
  "/workspaces/:ws/intake",
  zValidator("json", intakeSchema),
  async (c) => {
    const ws = await requireWorkspace(c);
    const actor = actorFromHeaders(c);
    const result = await ingestIntake(ws.id, c.req.valid("json"), actor);
    return c.json(result, result.status === "created" ? 201 : 200);
  },
);
