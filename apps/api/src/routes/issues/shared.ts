// Schemas, lookups and label helpers shared across the issues route family.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ISSUE_SOURCES, ISSUE_STATES, PRIORITIES } from "@tallyline/types";
import { db } from "../../db/client.js";
import { agents, cycles, issueLabels, issues, labels, projects, workspaceMembers } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { createAssist } from "../../services/assist.js";
import { mirrorIssueLabels } from "../../services/github-sync.js";
import type { Actor } from "../../services/issues.js";
import { createSlack } from "../../services/slack.js";
import { track } from "../../services/background.js";

export const assist = createAssist();
export const slack = createSlack();

export const createSchema = z.object({
  teamKey: z.string().min(1).max(6).optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  source: z.enum(ISSUE_SOURCES).optional(),
  state: z.enum(["triage", "backlog"]).default("backlog"),
  assigneeType: z.enum(["human", "agent"]).optional(),
  assigneeId: z.uuid().optional(),
  cycleId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  labelIds: z.array(z.uuid()).max(10).optional(),
});

export const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50_000).nullable().optional(),
  state: z.enum(ISSUE_STATES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  estimate: z.number().int().nonnegative().nullable().optional(),
  dueDate: z.iso.datetime().nullable().optional(),
  assigneeType: z.enum(["human", "agent"]).nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  cycleId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  labelIds: z.array(z.uuid()).max(10).optional(),
});

export const listQuerySchema = z.object({
  state: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(z.enum(ISSUE_STATES)))
    .optional(),
  priority: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(z.enum(PRIORITIES)))
    .optional(),
  team: z.string().optional(),
  assignee: z.uuid().optional(),
  cycle: z.uuid().optional(),
  project: z.uuid().optional(),
  label: z.uuid().optional(),
  source: z.enum(ISSUE_SOURCES).optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// bulk project/label update (U12): capped so one call stays one short transaction
export const BULK_MAX = 200;
export const bulkSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(BULK_MAX),
    projectId: z.uuid().nullable().optional(),
    addLabelIds: z.array(z.uuid()).max(10).optional(),
  })
  .refine((b) => b.projectId !== undefined || b.addLabelIds?.length, {
    message: "projectId or addLabelIds required",
  });

export const commentSchema = z.object({
  body: z.string().min(1).max(50_000),
});

// An `x-actor-id` header claiming an agent actor must name a real agent in
// this workspace — otherwise any session could forge agent provenance.
export async function validateAgentActor(
  workspaceId: string,
  actor: Actor,
): Promise<void> {
  if (actor.type !== "agent" || !actor.id) return;
  const [a] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, actor.id), eq(agents.workspaceId, workspaceId)));
  if (!a) {
    throw new HttpError(422, "INVALID_ACTOR", "x-actor-id is not an agent in this workspace");
  }
}

export async function validateAssignee(
  workspaceId: string,
  type: "human" | "agent",
  id: string,
): Promise<void> {
  if (type === "agent") {
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)));
    if (!a)
      throw new HttpError(422, "INVALID_ASSIGNEE", "agent not in workspace");
  } else {
    const [m] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, id),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      );
    if (!m)
      throw new HttpError(422, "INVALID_ASSIGNEE", "user not in workspace");
  }
}

// A cycle assignment is only meaningful inside the issue's own team —
// cross-team or foreign-workspace cycle ids are rejected, not silently kept.
export async function validateCycle(
  workspaceId: string,
  teamId: string,
  cycleId: string,
): Promise<void> {
  const [cycle] = await db
    .select({ teamId: cycles.teamId })
    .from(cycles)
    .where(and(eq(cycles.id, cycleId), eq(cycles.workspaceId, workspaceId)));
  if (!cycle) {
    throw new HttpError(422, "INVALID_CYCLE", "cycle not in workspace");
  }
  if (cycle.teamId !== teamId) {
    throw new HttpError(
      422,
      "INVALID_CYCLE",
      "cycle belongs to a different team",
    );
  }
}

// Same rule as cycles: the project must live in the issue's workspace, and a
// team-scoped project only accepts issues from its own team. Workspace-level
// projects (teamId null) accept issues from any team.
export async function validateProject(
  workspaceId: string,
  teamId: string,
  projectId: string,
): Promise<void> {
  const [project] = await db
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)),
    );
  if (!project) {
    throw new HttpError(422, "INVALID_PROJECT", "project not in workspace");
  }
  if (project.teamId !== null && project.teamId !== teamId) {
    throw new HttpError(
      422,
      "INVALID_PROJECT",
      "project belongs to a different team",
    );
  }
}

// A parent must be another issue in the SAME workspace — an id from another
// tenant would otherwise be stored and surface in that tenant's `children`.
export async function validateParent(
  workspaceId: string,
  parentId: string,
  selfKey?: string,
): Promise<void> {
  const [parent] = await db
    .select({ key: issues.key })
    .from(issues)
    .where(and(eq(issues.id, parentId), eq(issues.workspaceId, workspaceId)));
  if (!parent) {
    throw new HttpError(422, "INVALID_PARENT", "parent issue not in workspace");
  }
  if (selfKey !== undefined && parent.key === selfKey) {
    throw new HttpError(422, "INVALID_PARENT", "an issue cannot be its own parent");
  }
}


export async function findIssue(workspaceId: string, key: string) {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.workspaceId, workspaceId), eq(issues.key, key)));
  if (!issue) throw new HttpError(404, "NOT_FOUND", `issue ${key} not found`);
  return issue;
}

export async function setIssueLabels(
  issueId: string,
  workspaceId: string,
  labelIds: string[],
) {
  const valid = await db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(eq(labels.workspaceId, workspaceId), inArray(labels.id, labelIds)),
    );
  // ids that are unknown or belong to another workspace are dropped; if none
  // remain there is nothing to insert (drizzle throws on an empty values())
  if (valid.length === 0) return;
  await db
    .insert(issueLabels)
    .values(valid.map((l) => ({ issueId, labelId: l.id })));
  // best-effort GitHub mirror — no-ops for unlinked issues (#60)
  if (valid.length > 0) track(mirrorIssueLabels(issueId));
}

// PATCH label set — replace semantics, matching the web editor's chip model.
// Ids are pre-validated against the workspace in the PATCH handler; the swap
// is transactional so an insert failure can't strip the existing set.
export async function replaceIssueLabels(
  issueId: string,
  workspaceId: string,
  labelIds: string[],
) {
  await db.transaction(async (tx) => {
    await tx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (labelIds.length > 0) {
      await tx
        .insert(issueLabels)
        .values(labelIds.map((labelId) => ({ issueId, labelId })));
    }
  });
  if (labelIds.length > 0) track(mirrorIssueLabels(issueId));
}
