// Draft a project status update from facts (KTD9): no model call. The draft
// covers the window since the last posted update (or `DEFAULT_WINDOW_DAYS`),
// counting only events that fall inside it.
import { and, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  events,
  issueRelations,
  issues,
  projectMilestones,
  projects,
  projectUpdates,
  type ProjectUpdateHealth,
} from "../db/schema.js";
import { alias } from "drizzle-orm/pg-core";
import { clock } from "./clock.js";

export const DEFAULT_WINDOW_DAYS = 7;
const FINISHED = ["done", "canceled", "duplicate"] as const;

type Project = typeof projects.$inferSelect;

export interface ProjectUpdateDraft {
  since: string;
  until: string;
  suggestedHealth: ProjectUpdateHealth;
  healthReason: string;
  counts: { opened: number; done: number; blocked: number; open: number };
  doneKeys: string[];
  openedKeys: string[];
  blockedKeys: string[];
  milestones: { title: string; done: number; total: number }[];
  body: string;
  empty: boolean;
}

export function suggestHealth(input: {
  targetDate: Date | null;
  now: Date;
  open: number;
  blocked: number;
}): { health: ProjectUpdateHealth; reason: string } {
  if (input.targetDate && input.targetDate < input.now && input.open > 0) {
    return { health: "off_track", reason: `target date passed with ${input.open} open issue(s)` };
  }
  if (input.blocked > 0) {
    return { health: "at_risk", reason: `${input.blocked} open issue(s) blocked` };
  }
  return { health: "on_track", reason: "no overdue target and nothing blocked" };
}

export async function draftProjectUpdate(project: Project): Promise<ProjectUpdateDraft> {
  const now = clock.now();
  const [last] = await db
    .select({ createdAt: projectUpdates.createdAt })
    .from(projectUpdates)
    .where(eq(projectUpdates.projectId, project.id))
    .orderBy(sql`${projectUpdates.createdAt} desc`)
    .limit(1);
  const since = last?.createdAt ?? new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);

  const projectIssues = await db
    .select({ id: issues.id, key: issues.key, state: issues.state })
    .from(issues)
    .where(and(eq(issues.workspaceId, project.workspaceId), eq(issues.projectId, project.id)));
  const byId = new Map(projectIssues.map((i) => [i.id, i]));
  const ids = projectIssues.map((i) => i.id);

  const windowEvents = ids.length
    ? await db
        .select({ entityId: events.entityId, action: events.action, after: events.after })
        .from(events)
        .where(
          and(
            eq(events.workspaceId, project.workspaceId),
            eq(events.entityType, "issue"),
            inArray(events.entityId, ids),
            gt(events.createdAt, since),
            inArray(events.action, ["created", "state_changed"]),
          ),
        )
    : [];
  const doneIds = new Set<string>();
  const openedIds = new Set<string>();
  for (const e of windowEvents) {
    const state = (e.after as { state?: string } | null)?.state;
    if (e.action === "created") openedIds.add(e.entityId);
    if (e.action === "state_changed" && state === "done") doneIds.add(e.entityId);
  }

  const openIds = projectIssues.filter((i) => !(FINISHED as readonly string[]).includes(i.state)).map((i) => i.id);
  const blocker = alias(issues, "blocker");
  const blockedRows = openIds.length
    ? await db
        .selectDistinct({ id: issueRelations.targetIssueId })
        .from(issueRelations)
        .innerJoin(blocker, eq(blocker.id, issueRelations.sourceIssueId))
        .where(
          and(
            eq(issueRelations.workspaceId, project.workspaceId),
            eq(issueRelations.relationType, "blocks"),
            inArray(issueRelations.targetIssueId, openIds),
            notInArray(blocker.state, [...FINISHED]),
          ),
        )
    : [];
  const keyOf = (id: string) => byId.get(id)?.key ?? id;
  const doneKeys = [...doneIds].map(keyOf).sort();
  const openedKeys = [...openedIds].map(keyOf).sort();
  const blockedKeys = blockedRows.map((r) => keyOf(r.id)).sort();

  const ms = await db
    .select({ id: projectMilestones.id, title: projectMilestones.title })
    .from(projectMilestones)
    .where(eq(projectMilestones.projectId, project.id))
    .orderBy(projectMilestones.sortOrder, projectMilestones.createdAt);
  const milestones = await Promise.all(
    ms.map(async (m) => {
      const rows = await db
        .select({ state: issues.state })
        .from(issues)
        .where(and(eq(issues.workspaceId, project.workspaceId), eq(issues.milestoneId, m.id)));
      const counted = rows.filter((r) => r.state !== "canceled" && r.state !== "duplicate");
      return { title: m.title, done: counted.filter((r) => r.state === "done").length, total: counted.length };
    }),
  );

  const { health, reason } = suggestHealth({
    targetDate: project.targetDate,
    now,
    open: openIds.length,
    blocked: blockedKeys.length,
  });
  const empty = doneKeys.length === 0 && openedKeys.length === 0 && blockedKeys.length === 0;
  const list = (keys: string[]) => (keys.length ? keys.join(", ") : "none");
  const lines = [
    `Update for ${since.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}.`,
    empty ? "No tracked activity in this window." : "",
    `- Done: ${doneKeys.length} (${list(doneKeys)})`,
    `- Opened: ${openedKeys.length} (${list(openedKeys)})`,
    `- Blocked: ${blockedKeys.length} (${list(blockedKeys)})`,
    `- Open now: ${openIds.length}`,
    ...milestones.map((m) => `- Milestone ${m.title}: ${m.done}/${m.total} done`),
    `Suggested health: ${health} (${reason}).`,
  ].filter((l) => l !== "");

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    suggestedHealth: health,
    healthReason: reason,
    counts: { opened: openedKeys.length, done: doneKeys.length, blocked: blockedKeys.length, open: openIds.length },
    doneKeys,
    openedKeys,
    blockedKeys,
    milestones,
    body: lines.join("\n"),
    empty,
  };
}
