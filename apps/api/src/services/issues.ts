import { and, eq, sql } from "drizzle-orm";
import {
  canTransition,
  InvalidTransitionError,
  type ActorType,
  type IssueSource,
  type IssueState,
} from "@tallyline/types";
import { db } from "../db/client.js";
import { events, issues, teams } from "../db/schema.js";
import { mirrorIssueState } from "./github-sync.js";
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
  return issue;
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
