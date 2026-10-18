import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { teams } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { actorFromHeaders } from "../lib/actor.js";
import { importGithubIssues, importLinearCsv } from "../services/import.js";
import { hasRole } from "../services/members.js";
import { importPlan } from "../services/plan-import.js";
import { requireWorkspace } from "./workspaces.js";

const targetSchema = z.enum(["triage", "backlog"]).default("triage");

const githubImportSchema = z.object({
  fullName: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected 'owner/repo'"),
  // caller-supplied PAT or installation token; app-token minting lands with
  // bidirectional sync (#60)
  token: z.string().min(1),
  target: targetSchema,
  teamKey: z.string().regex(/^[A-Z][A-Z0-9]*$/).optional(),
});

const linearImportSchema = z.object({
  teamKey: z.string().regex(/^[A-Z][A-Z0-9]*$/),
  target: targetSchema,
  csv: z.string().min(1),
});

const planImportSchema = z.object({
  project: z.string().min(1).max(200),
  teamKey: z.string().regex(/^[A-Z][A-Z0-9]*$/).optional(),
  plan: z.object({
    scope: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/, "expected 1-8 uppercase letters or digits, e.g. KP"),
    source: z.object({
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected 'owner/repo'"),
      path: z.string().min(1).max(300),
      sha: z.string().regex(/^[0-9a-f]{7,40}$/i),
      url: z.url().max(500).optional(),
    }),
    markdown: z.string().min(1).max(1_000_000),
  }),
  evidence: z
    .record(
      z.string().regex(/^U\d+$/),
      z.object({
        state: z.enum(["backlog", "todo", "in_progress", "done"]).optional(),
        prs: z
          .array(
            z.object({
              repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
              number: z.number().int().positive(),
              url: z.url().max(500).optional(),
            }),
          )
          .max(20)
          .optional(),
        mergedAt: z.iso.datetime().optional(),
      }),
    )
    .optional(),
  historical: z.boolean().default(false),
  resolutions: z
    .record(z.string().regex(/^[A-Z][A-Z0-9]*-U\d+$/), z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/))
    .optional(),
  mode: z.enum(["dry_run", "apply"]).default("dry_run"),
  diffHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const importRoutes = new Hono()
  .post(
    "/workspaces/:ws/import/github",
    zValidator("json", githubImportSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      let teamId: string | undefined;
      if (body.teamKey) {
        const [team] = await db
          .select()
          .from(teams)
          .where(and(eq(teams.workspaceId, ws.id), eq(teams.key, body.teamKey)))
          .limit(1);
        if (!team) {
          throw new HttpError(404, "NOT_FOUND", `team '${body.teamKey}' not found`);
        }
        teamId = team.id;
      }
      const result = await importGithubIssues({
        workspaceId: ws.id,
        fullName: body.fullName,
        token: body.token,
        target: body.target,
        teamId,
      });
      if (result.errors.length > 0 && result.created === 0) {
        throw new HttpError(502, "IMPORT_FAILED", result.errors.join("; "));
      }
      return c.json(result);
    },
  )
  .post(
    "/workspaces/:ws/import/linear",
    zValidator("json", linearImportSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      const [team] = await db
        .select()
        .from(teams)
        .where(and(eq(teams.workspaceId, ws.id), eq(teams.key, body.teamKey)))
        .limit(1);
      if (!team) {
        throw new HttpError(404, "NOT_FOUND", `team '${body.teamKey}' not found`);
      }
      const result = await importLinearCsv({
        workspaceId: ws.id,
        teamId: team.id,
        csv: body.csv,
        target: body.target,
      });
      return c.json(result);
    },
  )
  .post(
    "/workspaces/:ws/import/plan",
    zValidator("json", planImportSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const out = await importPlan(
        {
          workspaceId: ws.id,
          actor: actorFromHeaders(c),
          // agent keys have no role; PATs and sessions carry the member's role
          humanStaff: !c.get("agentAuth") && hasRole(c.get("memberRole"), "admin"),
        },
        c.req.valid("json"),
      );
      if (out.kind === "stale") {
        return c.json(
          {
            error: {
              code: "STALE_DIFF",
              message:
                "the workspace or the input changed since the reviewed dry run; review this diff and apply again with its diffHash",
            },
            diff: out.diff,
          },
          409,
        );
      }
      return c.json(out.diff);
    },
  );
