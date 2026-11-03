import { zValidator } from "@hono/zod-validator";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { z } from "zod";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { createKeyedLimiter } from "../lib/rate-limit.js";
import { ingestIntake } from "../services/intake.js";
import {
  resolveIntakeCredential,
  touchIntakeCredential,
  type ResolvedIntakeCredential,
} from "../services/intake-public.js";

declare module "hono" {
  interface ContextVariableMap {
    intakeCredential: ResolvedIntakeCredential;
  }
}

// The documented cap for one report. Anything larger is refused before it is
// parsed; a 200 KB body (the plan's abuse case) never reaches zod.
export const INTAKE_BODY_MAX_BYTES = 128 * 1024;

// Keyed on the credential, never the client IP: one embedding app reports from
// a fleet behind one egress address, and a leaked key must only throttle
// itself. Every delivery to a known key counts, valid or not, so a loop in the
// embedder cannot flood the workspace.
export const intakeReportLimiter = createKeyedLimiter(
  () => config_.intakeRatePerMin,
  60_000,
  { prefix: "intake" },
);

const reportSchema = z.object({
  kind: z.enum(["error", "bug", "help", "issue"]),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000).optional(),
  provider: z.string().min(1).max(100).optional(),
  fingerprint: z.string().min(1).max(500).optional(),
  externalId: z.string().min(1).max(500).optional(),
  url: z.string().url().max(2_000).optional(),
  severity: z.enum(["fatal", "error", "warning", "info"]).optional(),
  occurredAt: z.string().max(64).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// Public intake: an outside app files a report with a per-project key and no
// human session. Mounted BEFORE requireSession in index.ts — and before the
// per-identity limiter, so this route carries its own credential limiter.
export const intakePublicRoutes = new Hono().post(
  "/intake/:key",
  bodyLimit({
    maxSize: INTAKE_BODY_MAX_BYTES,
    onError: (c) =>
      apiError(c, 413, "PAYLOAD_TOO_LARGE", "report body exceeds 128 KB"),
  }),
  // identity, then budget, then body: a revoked key is refused before any
  // work, and a known key's malformed requests still spend its budget
  async (c, next) => {
    const lookup = await resolveIntakeCredential(c.req.param("key"));
    if (lookup.status === "invalid") {
      return apiError(c, 401, "INTAKE_KEY_INVALID", "intake key is not valid");
    }
    if (lookup.status === "revoked") {
      return apiError(
        c,
        410,
        "INTAKE_KEY_REVOKED",
        "intake key has been revoked",
      );
    }
    const limited = await intakeReportLimiter.hit(c, lookup.credential.id);
    if (limited) return limited;
    await touchIntakeCredential(lookup.credential.id);
    c.set("intakeCredential", lookup.credential);
    return next();
  },
  zValidator("json", reportSchema),
  async (c) => {
    const credential = c.get("intakeCredential");
    const event = c.req.valid("json");
    // Scope identity to the credential: two apps in one workspace may use the
    // same fingerprint (or external id) for different things, and a repeat
    // from the same key must still fold onto one issue.
    const fingerprint = event.fingerprint
      ? `${credential.id}:${event.fingerprint}`
      : undefined;
    const externalId = event.externalId
      ? `${credential.id}:${event.externalId}`
      : undefined;

    const result = await ingestIntake(
      credential.workspaceId,
      {
        ...event,
        fingerprint,
        externalId,
        provider: event.provider ?? "intake",
      },
      // the reporter is not a member; provenance is the credential's
      { type: "system", id: null },
      // outside text never reaches the triage ranker, and the issue lands on
      // the key's team when it has one
      { skipRank: true, teamKey: credential.teamKey ?? undefined },
    );

    // never echo the workspace, its slug, or any issue but this one
    if (result.status === "duplicate_delivery") {
      return c.json({ deduped: true, reporterToken: null }, 200);
    }
    return c.json(
      {
        issueKey: result.issue?.key,
        // reserved for the reporter follow-up handle (U3); a public report has
        // no reply path yet
        reporterToken: null,
        deduped: result.status === "deduped",
      },
      result.status === "created" ? 201 : 200,
    );
  },
);
