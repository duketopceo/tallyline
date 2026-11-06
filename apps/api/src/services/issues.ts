import { and, eq, sql } from "drizzle-orm";
import {
  canTransition,
  InvalidTransitionError,
  type ActorType,
  type IssueSource,
  type IssueState,
} from "@tallyline/types";
import { db } from "../db/client.js";
import { events, issueKeyAliases, issues, projects, teams } from "../db/schema.js";
import { config_ } from "../env.js";
import { mirrorIssueState } from "./github-sync.js";
import { evaluateIssueCreatedLoops, evaluateIssueTransitionLoops } from "./loops.js";
import { notifyUsers, staffUserIds } from "./notifications.js";
import { queueDeliveries } from "./outbound.js";
import { track } from "./background.js";
import { clock } from "./clock.js";

export interface Actor {
  type: ActorType;
  id: string | null;
}

export interface CreateIssueInput {
  workspaceId: string;
  teamId: string;
  title: string;
  description?: string | undefined;
  source?: IssueSource | undefined;
  creator: Actor;
  state?: IssueState | undefined;
  /** provider fingerprint for automated intake dedupe */
  intakeFingerprint?: string | undefined;
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor(entity: string) {
    super(`${entity} not found`);
    this.name = "NotFoundError";
  }
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface InsertIssueInput extends CreateIssueInput {
  projectId?: string | undefined;
  milestoneId?: string | null | undefined;
  /** replaces the default `created` event (plan import writes `imported`) */
  event?: {
    action: string;
    after?: (key: string) => Record<string, unknown>;
    createdAt?: Date;
  };
}

// numbers the issue from its team counter and writes the row plus its event
// inside the caller's transaction, so a batch can be all-or-nothing
export async function insertIssueTx(tx: Tx, input: InsertIssueInput) {
  const [team] = await tx
    .update(teams)
    .set({ nextIssueNumber: sql`${teams.nextIssueNumber} + 1` })
    .where(
      and(
        eq(teams.id, input.teamId),
        eq(teams.workspaceId, input.workspaceId),
      ),
    )
    .returning({
      key: teams.key,
      nextIssueNumber: teams.nextIssueNumber,
    });
  if (!team) throw new NotFoundError("team");

  const number = team.nextIssueNumber - 1;
  const key = `${team.key}-${number}`;

  const [issue] = await tx
    .insert(issues)
    .values({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      key,
      number,
      title: input.title,
      description: input.description ?? null,
      source: input.source ?? "web",
      state: input.state ?? "backlog",
      projectId: input.projectId ?? null,
      milestoneId: input.milestoneId ?? null,
      intakeFingerprint: input.intakeFingerprint ?? null,
      creatorType: input.creator.type,
      creatorId: input.creator.id,
    })
    .returning();

  await tx.insert(events).values({
    workspaceId: input.workspaceId,
    entityType: "issue",
    entityId: issue!.id,
    action: input.event?.action ?? "created",
    actorType: input.creator.type,
    actorId: input.creator.id,
    after: input.event?.after?.(key) ?? { key, title: input.title, state: issue!.state },
    ...(input.event?.createdAt ? { createdAt: input.event.createdAt } : {}),
  });

  return issue!;
}

export async function createIssue(input: CreateIssueInput) {
  const issue = await db.transaction((tx) => insertIssueTx(tx, input));
  await queueDeliveries({
    workspaceId: input.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "created",
    actorType: input.creator.type,
    actorId: input.creator.id,
    after: { key: issue.key, title: issue.title, state: issue.state },
    issueKey: issue.key,
  });
  await evaluateIssueCreatedLoops({ workspaceId: input.workspaceId, issue });
  const [fresh] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issue.id), eq(issues.workspaceId, input.workspaceId)));
  return fresh ?? issue;
}

export async function transitionIssue(
  workspaceId: string,
  key: string,
  to: IssueState,
  actor: Actor,
  extra?: Record<string, unknown>,
) {
  let fromState!: IssueState;
  const updated = await db.transaction(async (tx) => {
    const [issue] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.key, key)))
      .for("update");
    if (!issue) throw new NotFoundError(`issue ${key}`);
    fromState = issue.state;

    if (!canTransition(issue.state, to)) {
      throw new InvalidTransitionError(issue.state, to);
    }

    const [updated] = await tx
      .update(issues)
      .set({ state: to, updatedAt: clock.now() })
      .where(eq(issues.id, issue.id))
      .returning();

    await tx.insert(events).values({
      workspaceId,
      entityType: "issue",
      entityId: issue.id,
      action: "state_changed",
      actorType: actor.type,
      actorId: actor.id,
      before: { state: issue.state },
      after: { state: to, ...extra },
    });

    return updated!;
  });
  await queueDeliveries({
    workspaceId,
    entityType: "issue",
    entityId: updated.id,
    action: "state_changed",
    actorType: actor.type,
    actorId: actor.id,
    before: { state: fromState },
    after: { state: to, ...extra },
    issueKey: key,
  });
  // in_review lands on the review queue — owner+admin members get a row so
  // pending review is ambient without polling. The actor is never notified.
  if (to === "in_review") {
    await notifyUsers(
      workspaceId,
      await staffUserIds(workspaceId),
      { kind: "review_pending", issueId: updated.id, actor },
    );
  }
  await evaluateIssueTransitionLoops({
    workspaceId,
    issue: updated,
    fromState,
    toState: to,
  });
  // best-effort GitHub mirror after commit — never blocks, never throws;
  // inbound-originated transitions (via=github) skip inside (#60)
  track(
    mirrorIssueState({
      issueId: updated.id,
      to,
      via: typeof extra?.via === "string" ? extra.via : undefined,
    }),
  );
  return updated;
}

// The permalink for an issue key on the configured web origin — the one place
// links are assembled, so clients never build their own.
export function issueUrl(key: string): string {
  return `${config_.webUrl}/issues/${encodeURIComponent(key)}`;
}

export function withUrl<T extends { key: string }>(issue: T): T & { url: string } {
  return { ...issue, url: issueUrl(issue.key) };
}

// Resolves a key to its issue, falling back to the aliases a team move leaves
// behind. The current key always wins over an alias.
export async function resolveIssueByKey(workspaceId: string, key: string) {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.workspaceId, workspaceId), eq(issues.key, key)));
  if (issue) return issue;
  const [aliased] = await db
    .select({ issue: issues })
    .from(issueKeyAliases)
    .innerJoin(issues, eq(issues.id, issueKeyAliases.issueId))
    .where(and(eq(issueKeyAliases.workspaceId, workspaceId), eq(issueKeyAliases.key, key)));
  return aliased?.issue;
}

export interface MoveIssueResult {
  issue: typeof issues.$inferSelect;
  moved: boolean;
}

// Moves an issue to another team of the same workspace: new key from the
// target team's counter, old key kept as an alias, one `team_changed` event.
// A cycle or team-scoped project of the old team does not carry over. Moving
// to the current team is a no-op and writes no event.
export async function moveIssueToTeam(
  workspaceId: string,
  issueId: string,
  teamId: string,
  actor: Actor,
): Promise<MoveIssueResult> {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
      .for("update");
    if (!current) throw new NotFoundError("issue");
    if (current.teamId === teamId) return { issue: current, moved: false, before: null };

    const [team] = await tx
      .update(teams)
      .set({ nextIssueNumber: sql`${teams.nextIssueNumber} + 1` })
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
      .returning({ key: teams.key, nextIssueNumber: teams.nextIssueNumber });
    if (!team) throw new NotFoundError("team");

    const number = team.nextIssueNumber - 1;
    const key = `${team.key}-${number}`;

    let projectId = current.projectId;
    let milestoneId = current.milestoneId;
    if (projectId) {
      const [project] = await tx
        .select({ teamId: projects.teamId })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (project?.teamId && project.teamId !== teamId) {
        projectId = null;
        milestoneId = null;
      }
    }

    await tx
      .insert(issueKeyAliases)
      .values({ workspaceId, issueId, key: current.key })
      .onConflictDoNothing();
    const [issue] = await tx
      .update(issues)
      .set({
        teamId,
        key,
        number,
        cycleId: null,
        projectId,
        milestoneId,
        updatedAt: clock.now(),
      })
      .where(eq(issues.id, issueId))
      .returning();

    const before = { teamId: current.teamId, key: current.key };
    await tx.insert(events).values({
      workspaceId,
      entityType: "issue",
      entityId: issueId,
      action: "team_changed",
      actorType: actor.type,
      actorId: actor.id,
      before,
      after: { teamId, key },
    });
    return { issue: issue!, moved: true, before };
  });
  if (result.moved && result.before) {
    await queueDeliveries({
      workspaceId,
      entityType: "issue",
      entityId: issueId,
      action: "team_changed",
      actorType: actor.type,
      actorId: actor.id,
      before: result.before,
      after: { teamId, key: result.issue.key },
      issueKey: result.issue.key,
    });
  }
  return { issue: result.issue, moved: result.moved };
}
