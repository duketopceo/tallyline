import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { intakeCredentials, teams, workspaces } from "../db/schema.js";
import { clock } from "./clock.js";
import { hashIntakeKey, INTAKE_KEY_PREFIX } from "./intake-credentials.js";

// Public intake (plan 2026-11-03 U2): resolve a `tlintake_…` key to the
// workspace/team it files into. Only the hash is stored, so the lookup is a
// single indexed equality; the plaintext never reaches the database.

export interface ResolvedIntakeCredential {
  id: string;
  workspaceId: string;
  projectId: string;
  /** the credential's team, when it is still scoped to one */
  teamKey: string | null;
  label: string;
  reporterNotifyEmail: string | null;
}

export type IntakeCredentialLookup =
  | { status: "ok"; credential: ResolvedIntakeCredential }
  | { status: "invalid" }
  | { status: "revoked" };

/**
 * Unknown keys and keys of a workspace pending deletion are both `invalid` —
 * a deleted workspace must not keep receiving reports, and the caller learns
 * nothing about which workspace a key once belonged to.
 */
export async function resolveIntakeCredential(
  key: string,
): Promise<IntakeCredentialLookup> {
  if (!key.startsWith(INTAKE_KEY_PREFIX) || key.length > 128) {
    return { status: "invalid" };
  }
  const [row] = await db
    .select({
      id: intakeCredentials.id,
      workspaceId: intakeCredentials.workspaceId,
      projectId: intakeCredentials.projectId,
      label: intakeCredentials.label,
      reporterNotifyEmail: intakeCredentials.reporterNotifyEmail,
      revokedAt: intakeCredentials.revokedAt,
      teamKey: teams.key,
    })
    .from(intakeCredentials)
    .innerJoin(workspaces, eq(workspaces.id, intakeCredentials.workspaceId))
    .leftJoin(teams, eq(teams.id, intakeCredentials.teamId))
    .where(
      and(
        eq(intakeCredentials.keyHash, hashIntakeKey(key)),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return { status: "invalid" };
  // revoked is distinct from unknown: rotation must tell the embedder to stop
  // sending, and fail closed (410) rather than look like a typo (401)
  if (row.revokedAt) return { status: "revoked" };
  return {
    status: "ok",
    credential: {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      teamKey: row.teamKey ?? null,
      label: row.label,
      reporterNotifyEmail: row.reporterNotifyEmail,
    },
  };
}

/** Stamp the last-use timestamp; only the hash row is touched, never the key. */
export async function touchIntakeCredential(id: string): Promise<void> {
  await db
    .update(intakeCredentials)
    .set({ lastUsedAt: clock.now() })
    .where(eq(intakeCredentials.id, id));
}
