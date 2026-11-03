import { zValidator } from "@hono/zod-validator";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { intakeEvents, issues } from "../db/schema.js";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { createKeyedLimiter } from "../lib/rate-limit.js";
import { ingestIntake } from "../services/intake.js";
import { normalizeFirstPartyReport } from "../services/intake-normalize.js";
import {
  resolveIntakeCredential,
  touchIntakeCredential,
  type ResolvedIntakeCredential,
} from "../services/intake-public.js";
import { issueReporterHandle } from "../services/reporters.js";

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
  // the reporter's way back (U3): an address to reply to, or just a request
  // for a follow-up handle
  reporter: z
    .object({
      email: z.email().max(320).optional(),
      name: z.string().min(1).max(200).optional(),
      followUp: z.boolean().optional(),
    })
    .optional(),
});

// Public intake: an outside app files a report with a per-project key and no
// human session. Mounted BEFORE requireSession in index.ts — and before the
// per-identity limiter, so this route carries its own credential limiter.
type ReportInput = z.infer<typeof reportSchema>;

/** mint a follow-up handle only when the reporter asked for one and we know the issue */
async function followUpToken(
  credential: ResolvedIntakeCredential,
  reporter: ReportInput["reporter"],
  issueId: string | null,
): Promise<string | null> {
  if (!issueId) return null;
  if (!reporter?.email && !reporter?.followUp) return null;
  const handle = await issueReporterHandle({
    workspaceId: credential.workspaceId,
    issueId,
    credentialId: credential.id,
    reporterEmail: reporter.email ?? null,
    reporterName: reporter.name ?? null,
  });
  return handle.token;
}

/** the issue a replayed delivery already filed, if any */
async function priorIssueId(
  credential: ResolvedIntakeCredential,
  event: ReportInput,
): Promise<string | null> {
  if (!event.externalId) return null;
  const [row] = await db
    .select({ issueId: intakeEvents.issueId })
    .from(intakeEvents)
    .where(
      and(
        eq(intakeEvents.workspaceId, credential.workspaceId),
        eq(intakeEvents.provider, event.provider ?? "intake"),
        eq(intakeEvents.externalId, `${credential.id}:${event.externalId}`),
      ),
    )
    .limit(1);
  return row?.issueId ?? null;
}

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
      // the same normaliser the Sentry and GlitchTip receivers use, so every
      // source lands in one shape
      normalizeFirstPartyReport({
        ...event,
        fingerprint,
        externalId,
        provider: event.provider ?? "intake",
      }),
      // the reporter is not a member; provenance is the credential's
      { type: "system", id: null },
      // outside text never reaches the triage ranker, and the issue lands on
      // the key's team when it has one
      { skipRank: true, teamKey: credential.teamKey ?? undefined },
    );

    // never echo the workspace, its slug, or any issue but this one
    if (result.status === "duplicate_delivery") {
      // a replay of an accepted delivery still owes the caller a way back if
      // it asked for one, so resolve the issue the first delivery filed
      const token = await followUpToken(
        credential,
        event.reporter,
        await priorIssueId(credential, event),
      );
      return c.json({ deduped: true, reporterToken: token }, 200);
    }

    let reporterToken: string | null = null;
    if (result.issue) {
      const [filed] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.workspaceId, credential.workspaceId),
            eq(issues.key, result.issue.key),
          ),
        )
        .limit(1);
      reporterToken = await followUpToken(
        credential,
        event.reporter,
        filed?.id ?? null,
      );
    }
    return c.json(
      {
        issueKey: result.issue?.key,
        // the reporter's handle (U3): present only when they asked to be
        // followed up with, and shown once — only its hash is stored
        reporterToken,
        deduped: result.status === "deduped",
      },
      result.status === "created" ? 201 : 200,
    );
  },
);
