import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { actorFromHeaders } from "../lib/actor.js";
import { apiError, HttpError } from "../lib/errors.js";
import {
  listIntakeCredentials,
  mintIntakeCredential,
  revokeIntakeCredential,
} from "../services/intake-credentials.js";
import { requireRole } from "../services/members.js";
import { ingestIntake } from "../services/intake.js";
import { isCookieSession } from "./auth.js";
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
  skipRank: z.boolean().optional(),
});

const intakeCredentialSchema = z.object({
  projectId: z.uuid(),
  teamId: z.uuid().optional(),
  label: z.string().min(1).max(120),
  reporterNotifyEmail: z.email().max(320).optional(),
});

// Intake credentials are managed from a live human session only — a PAT or an
// agent key is itself a delegated credential and cannot mint another one. The
// member role (checked after requireWorkspace resolves membership) is the gate:
// whoever can file intake can issue its key.
function requireIntakeUser(c: Context): string | Response {
  if (c.get("agentAuth")) {
    return apiError(
      c,
      403,
      "FORBIDDEN_AGENT",
      "agent credentials cannot manage intake credentials",
    );
  }
  if (!isCookieSession(c)) {
    return apiError(
      c,
      403,
      "FORBIDDEN",
      "intake credential management requires a human session",
    );
  }
  return c.get("session")!.userId;
}

// Automated intake: GlitchTip, GitHub, help/bug-report senders post normalized
// events here. Session- and agent-key-authed like the rest of /v1 — an agent
// key IS the ingestion credential, so no separate endpoint layer is needed.
export const intakeRoutes = new Hono()
  .post(
    "/workspaces/:ws/intake",
    zValidator("json", intakeSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const actor = actorFromHeaders(c);
      const { skipRank, ...event } = c.req.valid("json");
      const result = await ingestIntake(ws.id, event, actor, { skipRank });
      return c.json(result, result.status === "created" ? 201 : 200);
    },
  )
  // Mint a per-project key. The plaintext `tlintake_…` key is in this response
  // and nowhere else — list and revoke never repeat it.
  .post(
    "/workspaces/:ws/intake-credentials",
    zValidator("json", intakeCredentialSchema),
    async (c) => {
      const actor = requireIntakeUser(c);
      if (actor instanceof Response) return actor;
      const ws = await requireWorkspace(c);
      requireRole(c, "member");
      const body = c.req.valid("json");
      if (body.label.toLowerCase().includes("tlintake_")) {
        return apiError(c, 422, "BAD_LABEL", "label may not contain 'tlintake_'");
      }
      const { key, credential } = await mintIntakeCredential({
        workspaceId: ws.id,
        projectId: body.projectId,
        teamId: body.teamId,
        label: body.label,
        reporterNotifyEmail: body.reporterNotifyEmail,
        createdBy: actor,
      });
      return c.json({ ...credential, key }, 201);
    },
  )
  // Labels, last4, last use and revocation state — never the key or its hash.
  .get("/workspaces/:ws/intake-credentials", async (c) => {
    const actor = requireIntakeUser(c);
    if (actor instanceof Response) return actor;
    const ws = await requireWorkspace(c);
    requireRole(c, "member");
    const credentials = await listIntakeCredentials(ws.id);
    return c.json({ credentials });
  })
  .delete("/workspaces/:ws/intake-credentials/:id", async (c) => {
    const actor = requireIntakeUser(c);
    if (actor instanceof Response) return actor;
    const ws = await requireWorkspace(c);
    requireRole(c, "member");
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) {
      throw new HttpError(404, "NOT_FOUND", "intake credential not found");
    }
    // already-revoked is a success that keeps its original timestamp
    const credential = await revokeIntakeCredential(ws.id, id, actor);
    if (!credential) {
      throw new HttpError(404, "NOT_FOUND", "intake credential not found");
    }
    return c.json({ credential });
  });
