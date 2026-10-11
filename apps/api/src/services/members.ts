import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/client.js";
import { config_ } from "../env.js";
import { workspaceMembers, workspaces } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";

export type MemberRole = "member" | "admin" | "owner";

const ROLE_RANK: Record<MemberRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export async function memberOf(userId: string, workspaceId: string) {
  const [m] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    );
  return m ?? null;
}

export async function membershipsFor(userId: string) {
  return db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      workspaceSlug: workspaces.slug,
      workspaceName: workspaces.name,
      role: workspaceMembers.role,
      // non-null while the workspace is pending deletion (restore window)
      deletedAt: workspaces.deletedAt,
      purgeAfter: workspaces.purgeAfter,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaceMembers.createdAt);
}

export function hasRole(
  role: MemberRole | null | undefined,
  min: MemberRole,
): role is MemberRole {
  return role !== null && role !== undefined && ROLE_RANK[role] >= ROLE_RANK[min];
}

// requireWorkspace resolves memberRole into context — role gates read it.
// A null memberRole (agent credentials — agents are never members per R24)
// always fails any role gate.
export function requireRole(c: Context, min: MemberRole): MemberRole {
  const role = c.get("memberRole") ?? null;
  if (!hasRole(role, min)) {
    throw new HttpError(
      403,
      "FORBIDDEN_ROLE",
      `requires ${min} role or higher`,
    );
  }
  return role;
}

// Approving or sending back a review item (PLAN-056) is a human decision:
// agent credentials (read or write) never pass, whatever they are scoped to.
// Humans need at least the member role (sessions, PATs and OAuth JWTs alike).
export function requireHumanReviewer(c: Context): MemberRole {
  if (c.get("agentAuth")) {
    throw new HttpError(
      403,
      "FORBIDDEN_AGENT",
      "agent credentials cannot approve or send back review items — a human member must",
    );
  }
  return requireRole(c, "member");
}

// Instance admin: AUTH_ADMIN_EMAILS allowlist by verified email, or — when
// unset — the bootstrap owner (owner of the first-created workspace) so a
// clean install always has an admin path (KTD10).
export async function isInstanceAdmin(user: {
  id: string;
  email: string;
}): Promise<boolean> {
  const allowlist = config_.authAdminEmails;
  if (allowlist.length > 0) {
    return allowlist.includes(user.email.trim().toLowerCase());
  }
  const [first] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(workspaces.createdAt)
    .limit(1);
  if (!first) return false;
  const m = await memberOf(user.id, first.id);
  return m?.role === "owner";
}
