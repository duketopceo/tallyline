import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditEvents, events, sessions, userTokens, workspaceMembers, workspaces } from "../db/schema.js";

export type LeaveOutcome =
  | { ok: true; nextWorkspaceSlug: string }
  | { ok: false; reason: "not_member" | "last_owner" | "last_workspace" };

/**
 * A member leaves a workspace on their own. Refuses to orphan the workspace
 * (the last owner) and to strand the person with no workspace at all. The
 * owner rows are locked so two co-owners leaving at once serialize and the
 * second one sees the first already gone. The person's personal access tokens
 * for the workspace are revoked, and their sessions bound to it move to
 * another workspace they belong to.
 */
export async function leaveWorkspace(userId: string, workspaceId: string): Promise<LeaveOutcome> {
  return db.transaction(async (tx): Promise<LeaveOutcome> => {
    const owners = await tx
      .select({ id: workspaceMembers.id, userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")))
      .orderBy(asc(workspaceMembers.id))
      .for("update");
    const [me] = await tx
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (!me) return { ok: false, reason: "not_member" };
    if (me.role === "owner" && owners.every((o) => o.userId === userId)) {
      return { ok: false, reason: "last_owner" };
    }
    const others = await tx
      .select({ workspaceId: workspaceMembers.workspaceId, slug: workspaces.slug, deletedAt: workspaces.deletedAt })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), ne(workspaceMembers.workspaceId, workspaceId)))
      .orderBy(asc(workspaceMembers.createdAt));
    const next = others.find((o) => o.deletedAt === null) ?? others[0];
    if (!next) return { ok: false, reason: "last_workspace" };
    await tx.delete(workspaceMembers).where(eq(workspaceMembers.id, me.id));
    await tx
      .delete(userTokens)
      .where(and(eq(userTokens.userId, userId), eq(userTokens.workspaceId, workspaceId)));
    await tx
      .update(sessions)
      .set({ workspaceId: next.workspaceId })
      .where(and(eq(sessions.userId, userId), eq(sessions.workspaceId, workspaceId)));
    await tx.insert(events).values({
      workspaceId,
      actorType: "human",
      actorId: userId,
      action: "member_left",
      entityType: "member",
      entityId: userId,
      after: { self: true, role: me.role },
    });
    await tx.insert(auditEvents).values({
      action: "workspace_left",
      userId,
      actorUserId: userId,
      meta: { workspaceId },
    });
    return { ok: true, nextWorkspaceSlug: next.slug };
  });
}
