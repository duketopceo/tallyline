// Helpers for the /device page, where a person approves the code their CLI
// showed. Keep the code rules in step with apps/api/src/services/device-auth.ts.

const CODE_LEN = 8;

/** What the person typed or pasted -> the XXXX-XXXX display form, or null when it cannot be a code. */
export function parseUserCode(raw: string | null | undefined): string | null {
  const n = (raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (n.length !== CODE_LEN || !/^[A-Z0-9]+$/.test(n)) return null;
  return `${n.slice(0, 4)}-${n.slice(4)}`;
}

interface Membership {
  workspaceSlug: string;
  workspaceName?: string;
  role: string;
  deletedAt?: string | null;
}

export interface ApprovableWorkspace {
  slug: string;
  name: string;
}

/** Device approval needs the same bar as minting a token: admin or owner, in a live workspace. */
export function approvableWorkspaces(memberships: Membership[] | undefined): ApprovableWorkspace[] {
  return (memberships ?? [])
    .filter((m) => (m.role === "admin" || m.role === "owner") && !m.deletedAt)
    .map((m) => ({ slug: m.workspaceSlug, name: m.workspaceName ?? m.workspaceSlug }));
}

/** Workspace slugs and codes go into an upstream path, so only plain characters get through. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const CODE_RE = /^[A-Za-z0-9-]{4,16}$/;
