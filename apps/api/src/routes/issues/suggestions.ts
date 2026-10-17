// Issue suggestions (plan L4) — agent- or human-proposed field changes a
// reviewer can accept or dismiss; the audit trail lives in issue_suggestions.
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/client.js";
import {
  events,
  issueLabels,
  issueSuggestionKinds,
  issueSuggestions,
  labels,
  projects,
  workspaceMembers,
  type IssueSuggestionKind,
} from "../../db/schema.js";
import { actorFromHeaders } from "../../lib/actor.js";
import { apiError, HttpError } from "../../lib/errors.js";
import { requireWorkspace } from "../workspaces.js";
import { findIssue } from "./shared.js";

export const suggestionRoutes = new Hono()
  // ── Plan L4: Issue suggestions ─────────────────────────────────
  .get("/workspaces/:ws/issues/:key/suggestions", async (c) => {
    const ws = await requireWorkspace(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    const rows = await db
      .select()
      .from(issueSuggestions)
      .where(
        and(
          eq(issueSuggestions.workspaceId, ws.id),
          eq(issueSuggestions.issueId, issue.id),
        ),
      )
      .orderBy(asc(issueSuggestions.createdAt));
    return c.json({ suggestions: rows });
  })
  .post("/workspaces/:ws/issues/:key/suggestions", async (c) => {
    const ws = await requireWorkspace(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    const rawText = await c.req.text();
    let rawJson: unknown = {};
    if (rawText.trim()) {
      try {
        rawJson = JSON.parse(rawText);
      } catch {
        return apiError(c, 400, "INVALID_JSON", "invalid JSON body");
      }
    }
    const itemSchema = z.object({
      kind: z.enum(issueSuggestionKinds),
      suggestedValue: z.string().min(1).max(500),
      reason: z.string().max(1000).nullable().optional(),
    });
    const bodySchema = z.object({
      kind: z.enum(issueSuggestionKinds).optional(),
      suggestedValue: z.string().min(1).max(500).optional(),
      reason: z.string().max(1000).nullable().optional(),
      suggestions: z.array(itemSchema).max(20).optional(),
    });
    const parsed = bodySchema.safeParse(rawJson);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", parsed.error.message);
    }
    const body = parsed.data;
    const candidates: Array<{
      kind: IssueSuggestionKind;
      suggestedValue: string;
      reason: string | null;
    }> = [];
    if (body.kind && body.suggestedValue) {
      candidates.push({
        kind: body.kind,
        suggestedValue: body.suggestedValue,
        reason: body.reason ?? null,
      });
    }
    if (body.suggestions) {
      for (const s of body.suggestions) {
        candidates.push({
          kind: s.kind,
          suggestedValue: s.suggestedValue,
          reason: s.reason ?? null,
        });
      }
    }

    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const cand of candidates) {
      if (uuidRe.test(cand.suggestedValue)) {
        if (cand.kind === "label") {
          const [l] = await db
            .select({ id: labels.id })
            .from(labels)
            .where(
              and(
                eq(labels.id, cand.suggestedValue),
                eq(labels.workspaceId, ws.id),
              ),
            );
          if (!l) {
            throw new HttpError(
              422,
              "INVALID_SUGGESTION",
              "label not in workspace",
            );
          }
        } else if (cand.kind === "project") {
          const [p] = await db
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, cand.suggestedValue),
                eq(projects.workspaceId, ws.id),
              ),
            );
          if (!p) {
            throw new HttpError(
              422,
              "INVALID_SUGGESTION",
              "project not in workspace",
            );
          }
        } else if (cand.kind === "team") {
          const [t] = await db
            .select({ id: teams.id })
            .from(teams)
            .where(
              and(
                eq(teams.id, cand.suggestedValue),
                eq(teams.workspaceId, ws.id),
              ),
            );
          if (!t) {
            throw new HttpError(
              422,
              "INVALID_SUGGESTION",
              "team not in workspace",
            );
          }
        } else if (cand.kind === "assignee") {
          const [m] = await db
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, ws.id),
                eq(workspaceMembers.userId, cand.suggestedValue),
              ),
            );
          const [a] = await db
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.id, cand.suggestedValue),
                eq(agents.workspaceId, ws.id),
              ),
            );
          if (!m && !a) {
            throw new HttpError(
              422,
              "INVALID_SUGGESTION",
              "assignee not in workspace",
            );
          }
        } else if (cand.kind === "duplicate") {
          const [other] = await db
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.id, cand.suggestedValue),
                eq(issues.workspaceId, ws.id),
              ),
            );
          if (!other) {
            throw new HttpError(
              422,
              "INVALID_SUGGESTION",
              "duplicate issue not in workspace",
            );
          }
        }
      }
    }

    if (candidates.length === 0) {
      const textBlob = `${issue.title} ${issue.description ?? ""}`.toLowerCase();
      const wsLabels = await db
        .select()
        .from(labels)
        .where(eq(labels.workspaceId, ws.id))
        .orderBy(asc(labels.createdAt));
      for (const l of wsLabels) {
        if (textBlob.includes(l.name.toLowerCase())) {
          candidates.push({
            kind: "label",
            suggestedValue: l.name,
            reason: `matches label "${l.name}"`,
          });
        }
      }
      if (candidates.length === 0 && wsLabels[0]) {
        candidates.push({
          kind: "label",
          suggestedValue: wsLabels[0].name,
          reason: "workspace label candidate",
        });
      }
      const wsProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.workspaceId, ws.id))
        .orderBy(asc(projects.createdAt));
      for (const p of wsProjects) {
        if (textBlob.includes(p.name.toLowerCase())) {
          candidates.push({
            kind: "project",
            suggestedValue: p.id,
            reason: `matches project "${p.name}"`,
          });
        }
      }
      if (candidates.length === 0) {
        candidates.push({
          kind: "team",
          suggestedValue: issue.teamId,
          reason: "default team routing",
        });
      }
    }

    for (const cand of candidates) {
      await db
        .insert(issueSuggestions)
        .values({
          workspaceId: ws.id,
          issueId: issue.id,
          kind: cand.kind,
          suggestedValue: cand.suggestedValue,
          reason: cand.reason,
          state: "pending",
        })
        .onConflictDoNothing();
    }

    const rows = await db
      .select()
      .from(issueSuggestions)
      .where(
        and(
          eq(issueSuggestions.workspaceId, ws.id),
          eq(issueSuggestions.issueId, issue.id),
        ),
      )
      .orderBy(asc(issueSuggestions.createdAt));
    const matched =
      (candidates[0] &&
        rows.find(
          (r) =>
            r.kind === candidates[0]!.kind &&
            r.suggestedValue === candidates[0]!.suggestedValue,
        )) ??
      rows[0];
    return c.json(
      {
        ...(matched ?? {}),
        suggestion: matched ?? null,
        suggestions: rows,
      },
      201,
    );
  })
  .patch(
    "/workspaces/:ws/issues/:key/suggestions/:sid",
    zValidator(
      "json",
      z.object({
        state: z.enum(["accepted", "dismissed"]),
        dismissedReason: z.string().max(1000).nullable().optional(),
      }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      const actor = actorFromHeaders(c);
      const issue = await findIssue(ws.id, c.req.param("key"));
      const sid = c.req.param("sid");
      const body = c.req.valid("json");

      const [existing] = await db
        .select()
        .from(issueSuggestions)
        .where(
          and(
            eq(issueSuggestions.id, sid),
            eq(issueSuggestions.workspaceId, ws.id),
            eq(issueSuggestions.issueId, issue.id),
          ),
        );
      if (!existing) {
        throw new HttpError(404, "NOT_FOUND", "suggestion not found");
      }

      const [updated] = await db
        .update(issueSuggestions)
        .set({
          state: body.state,
          dismissedReason:
            body.state === "dismissed" ? (body.dismissedReason ?? null) : null,
        })
        .where(eq(issueSuggestions.id, existing.id))
        .returning();

      const uuidRe =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (body.state === "accepted") {
        if (existing.kind === "label") {
          const [label] = await db
            .select({ id: labels.id })
            .from(labels)
            .where(
              and(
                eq(labels.workspaceId, ws.id),
                uuidRe.test(existing.suggestedValue)
                  ? or(
                      eq(labels.id, existing.suggestedValue),
                      eq(labels.name, existing.suggestedValue),
                    )
                  : eq(labels.name, existing.suggestedValue),
              ),
            );
          if (label) {
            await db
              .insert(issueLabels)
              .values({ issueId: issue.id, labelId: label.id })
              .onConflictDoNothing();
          }
        } else if (existing.kind === "project") {
          const [proj] = await db
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.workspaceId, ws.id),
                uuidRe.test(existing.suggestedValue)
                  ? or(
                      eq(projects.id, existing.suggestedValue),
                      eq(projects.name, existing.suggestedValue),
                    )
                  : eq(projects.name, existing.suggestedValue),
              ),
            );
          if (proj) {
            await db
              .update(issues)
              .set({ projectId: proj.id })
              .where(eq(issues.id, issue.id));
          }
        } else if (existing.kind === "team") {
          const [team] = await db
            .select({ id: teams.id })
            .from(teams)
            .where(
              and(
                eq(teams.workspaceId, ws.id),
                uuidRe.test(existing.suggestedValue)
                  ? or(
                      eq(teams.id, existing.suggestedValue),
                      eq(teams.key, existing.suggestedValue),
                    )
                  : eq(teams.key, existing.suggestedValue),
              ),
            );
          if (team) {
            await db
              .update(issues)
              .set({ teamId: team.id })
              .where(eq(issues.id, issue.id));
          }
        } else if (
          existing.kind === "assignee" &&
          uuidRe.test(existing.suggestedValue)
        ) {
          await db
            .update(issues)
            .set({
              assigneeType: "human",
              assigneeId: existing.suggestedValue,
            })
            .where(eq(issues.id, issue.id));
        } else if (existing.kind === "duplicate") {
          await db
            .update(issues)
            .set({ state: "duplicate" })
            .where(eq(issues.id, issue.id));
        }
      }

      await db.insert(events).values({
        workspaceId: ws.id,
        entityType: "issue",
        entityId: issue.id,
        action:
          body.state === "accepted"
            ? "suggestion_accepted"
            : "suggestion_dismissed",
        actorType: actor.type,
        actorId: actor.id,
        after: {
          suggestionId: updated!.id,
          kind: updated!.kind,
          suggestedValue: updated!.suggestedValue,
          state: updated!.state,
          dismissedReason: updated!.dismissedReason,
        },
      });

      return c.json({ ...updated!, suggestion: updated! });
    },
  )
  );
