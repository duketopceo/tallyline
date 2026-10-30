import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  issues,
  notificationKinds,
  notifications,
  workspaceMembers,
} from "../db/schema.js";
import { track } from "./background.js";
import { clock } from "./clock.js";
import type { Actor } from "./issues.js";
import { pushToUsers } from "./push.js";

export type NotificationKind = (typeof notificationKinds)[number];

export interface NotificationInput {
  kind: NotificationKind;
  issueId?: string;
  eventId?: number;
  actor?: Actor;
}

// Materialize one inbox row per recipient at write time. The actor never
// notifies themselves — self-assignment and self-mention are no-ops.
export async function notifyUsers(
  workspaceId: string,
  userIds: Iterable<string>,
  input: NotificationInput,
): Promise<number> {
  const targets = [...new Set(userIds)].filter(
    (id) => !(input.actor?.type === "human" && input.actor.id === id),
  );
  if (targets.length === 0) return 0;
  const rows = await db
    .insert(notifications)
    .values(
      targets.map((userId) => ({
        workspaceId,
        userId,
        kind: input.kind,
        issueId: input.issueId ?? null,
        eventId: input.eventId ?? null,
        actorType: input.actor?.type ?? "system",
        actorId: input.actor?.id ?? null,
        createdAt: clock.now(),
      })),
    )
    .returning({ id: notifications.id });
  // content-free phone ping (S4-U3); off unless a relay is configured, and a
  // slow or dead relay never holds up the write
  track(pushToUsers(workspaceId, targets, input.kind));
  return rows.length;
}

// owner+admin members of a workspace — the fallback audience when a
// notification has no natural owner (e.g. a dispatch failed on an
// unassigned issue)
export async function staffUserIds(workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.role, ["owner", "admin"]),
      ),
    );
  return rows.map((r) => r.userId);
}

// dispatch_failed audience: the issue's human assignee, then its human
// creator, then workspace staff
export async function dispatchFailureTargets(
  workspaceId: string,
  issueId: string,
): Promise<string[]> {
  const [issue] = await db
    .select({
      assigneeType: issues.assigneeType,
      assigneeId: issues.assigneeId,
      creatorType: issues.creatorType,
      creatorId: issues.creatorId,
    })
    .from(issues)
    .where(eq(issues.id, issueId));
  if (issue?.assigneeType === "human" && issue.assigneeId) {
    return [issue.assigneeId];
  }
  if (issue?.creatorType === "human" && issue.creatorId) {
    return [issue.creatorId];
  }
  return staffUserIds(workspaceId);
}

export async function unreadCount(
  workspaceId: string,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    );
  return row?.count ?? 0;
}
