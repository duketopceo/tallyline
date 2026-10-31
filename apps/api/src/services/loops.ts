import { and, asc, eq } from "drizzle-orm";
import type { IssueState, Priority } from "@tallyline/types";
import { db } from "../db/client.js";
import {
  agents,
  comments,
  events,
  issues,
  workflowDefinitions,
  type IssueRow,
  type WorkflowTrigger,
} from "../db/schema.js";
import { clock } from "./clock.js";
import { createDispatch } from "./dispatch.js";

function matchesValue(expected: unknown, actual: string | null): boolean {
  if (expected === undefined || expected === null) return true;
  if (Array.isArray(expected)) {
    return actual !== null && expected.includes(actual);
  }
  if (typeof expected === "string") {
    return actual === expected;
  }
  return false;
}

export function matchesTransitionCondition(
  condition: Record<string, unknown>,
  ctx: {
    issue: IssueRow;
    fromState: IssueState;
    toState: IssueState;
  },
): boolean {
  const toExpected = condition.to ?? condition.toState ?? condition.state;
  if (!matchesValue(toExpected, ctx.toState)) return false;

  const fromExpected = condition.from ?? condition.fromState;
  if (!matchesValue(fromExpected, ctx.fromState)) return false;

  if (!matchesValue(condition.priority, ctx.issue.priority)) return false;
  if (!matchesValue(condition.teamId, ctx.issue.teamId)) return false;

  return true;
}

export function matchesCreatedCondition(
  condition: Record<string, unknown>,
  ctx: { issue: IssueRow },
): boolean {
  if (!matchesValue(condition.state, ctx.issue.state)) return false;
  if (!matchesValue(condition.priority, ctx.issue.priority)) return false;
  if (!matchesValue(condition.teamId, ctx.issue.teamId)) return false;
  if (!matchesValue(condition.source, ctx.issue.source)) return false;
  return true;
}

export async function evaluateIssueCreatedLoops(ctx: {
  workspaceId: string;
  issue: IssueRow;
}): Promise<number> {
  return runWorkflows(
    ctx,
    "issue.created",
    (condition) => matchesCreatedCondition(condition, ctx),
  );
}

export async function evaluateIssueTransitionLoops(ctx: {
  workspaceId: string;
  issue: IssueRow;
  fromState: IssueState;
  toState: IssueState;
}): Promise<number> {
  return runWorkflows(
    ctx,
    "issue.transition",
    (condition) => matchesTransitionCondition(condition, ctx),
  );
}

async function runWorkflows(
  ctx: {
    workspaceId: string;
    issue: IssueRow;
  },
  trigger: WorkflowTrigger,
  matches: (condition: Record<string, unknown>) => boolean,
): Promise<number> {
  const workflows = await db
    .select()
    .from(workflowDefinitions)
    .where(
      and(
        eq(workflowDefinitions.workspaceId, ctx.workspaceId),
        eq(workflowDefinitions.trigger, trigger),
        eq(workflowDefinitions.enabled, true),
      ),
    )
    .orderBy(asc(workflowDefinitions.createdAt));

  let executed = 0;
  for (const wf of workflows) {
    const condition = (wf.condition ?? {}) as Record<string, unknown>;
    if (!matches(condition)) continue;

    const action = (wf.action ?? {}) as Record<string, unknown>;
    const actionType =
      typeof action.type === "string"
        ? action.type
        : typeof action.kind === "string"
          ? action.kind
          : typeof action.agentId === "string"
            ? "dispatch"
            : typeof action.body === "string" || typeof action.message === "string"
              ? "comment"
              : "set_field";

    if (actionType === "dispatch" && typeof action.agentId === "string") {
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, action.agentId),
            eq(agents.workspaceId, ctx.workspaceId),
          ),
        );
      if (agent) {
        await createDispatch({
          workspaceId: ctx.workspaceId,
          issueId: ctx.issue.id,
          agentId: agent.id,
          trigger: "assign",
          commentBody: `workflow:${wf.name}`,
        });
      }
    } else if (actionType === "comment") {
      const body =
        typeof action.body === "string"
          ? action.body
          : typeof action.message === "string"
            ? action.message
            : null;
      if (body) {
        await db.insert(comments).values({
          workspaceId: ctx.workspaceId,
          issueId: ctx.issue.id,
          actorType: "system",
          actorId: null,
          body,
        });
      }
    } else if (actionType === "set_field") {
      const rawFields =
        typeof action.fields === "object" && action.fields !== null
          ? (action.fields as Record<string, unknown>)
          : typeof action.field === "string"
            ? { [action.field]: action.value }
            : action;
      const patch: Partial<typeof issues.$inferInsert> = {};
      if (typeof rawFields.priority === "string") {
        patch.priority = rawFields.priority as Priority;
      }
      if (typeof rawFields.estimate === "number" || rawFields.estimate === null) {
        patch.estimate = rawFields.estimate;
      }
      if (typeof rawFields.title === "string") {
        patch.title = rawFields.title;
      }
      if (typeof rawFields.description === "string" || rawFields.description === null) {
        patch.description = rawFields.description;
      }
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = clock.now();
        await db
          .update(issues)
          .set(patch)
          .where(
            and(
              eq(issues.id, ctx.issue.id),
              eq(issues.workspaceId, ctx.workspaceId),
            ),
          );
      }
    }

    await db.insert(events).values({
      workspaceId: ctx.workspaceId,
      entityType: "issue",
      entityId: ctx.issue.id,
      action: "workflow_triggered",
      actorType: "system",
      actorId: null,
      after: {
        workflowId: wf.id,
        workflowName: wf.name,
        trigger: wf.trigger,
        actionType,
      },
    });
    executed++;
  }

  return executed;
}
