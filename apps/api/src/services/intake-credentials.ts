import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { events, intakeCredentials, projects, teams } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { clock } from "./clock.js";

// Intake credentials (plan 2026-11-03 U1): a per-project key an outside app
// embeds to file reports without a human session. Same shape as agent keys and
// PATs — the plaintext is shown once at mint, only its sha256 hash is stored.

export const INTAKE_KEY_PREFIX = "tlintake_";

export function hashIntakeKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Everything a view may return. The hash is deliberately absent so no list or
// revoke response can ever carry key material.
const viewColumns = {
  id: intakeCredentials.id,
  projectId: intakeCredentials.projectId,
  teamId: intakeCredentials.teamId,
  label: intakeCredentials.label,
  keyLast4: intakeCredentials.keyLast4,
  reporterNotifyEmail: intakeCredentials.reporterNotifyEmail,
  revokedAt: intakeCredentials.revokedAt,
  lastUsedAt: intakeCredentials.lastUsedAt,
  createdBy: intakeCredentials.createdBy,
  createdAt: intakeCredentials.createdAt,
};

export type IntakeCredentialView = {
  id: string;
  projectId: string;
  teamId: string | null;
  label: string;
  keyLast4: string;
  reporterNotifyEmail: string | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
};

export interface MintIntakeCredentialInput {
  workspaceId: string;
  projectId: string;
  teamId?: string | undefined;
  label: string;
  reporterNotifyEmail?: string | undefined;
  createdBy: string;
}

/**
 * Mint a `tlintake_…` key bound to one project. The plaintext is returned once,
 * alongside the row that stores only its hash and last four characters.
 */
export async function mintIntakeCredential(
  input: MintIntakeCredentialInput,
): Promise<{ key: string; credential: IntakeCredentialView }> {
  const [project] = await db
    .select({ id: projects.id, teamId: projects.teamId })
    .from(projects)
    .where(
      and(
        eq(projects.id, input.projectId),
        eq(projects.workspaceId, input.workspaceId),
      ),
    );
  if (!project) {
    throw new HttpError(
      422,
      "PROJECT_NOT_FOUND",
      "project not found in this workspace",
    );
  }
  const teamId = input.teamId ?? project.teamId;
  if (teamId) {
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, input.workspaceId)));
    if (!team) {
      throw new HttpError(
        422,
        "TEAM_NOT_FOUND",
        "team not found in this workspace",
      );
    }
  }

  const key = `${INTAKE_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const keyLast4 = key.slice(-4);

  const credential = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(intakeCredentials)
      .values({
        workspaceId: input.workspaceId,
        projectId: project.id,
        teamId: teamId ?? null,
        label: input.label,
        keyHash: hashIntakeKey(key),
        keyLast4,
        reporterNotifyEmail: input.reporterNotifyEmail ?? null,
        createdBy: input.createdBy,
      })
      .returning(viewColumns);
    await tx.insert(events).values({
      workspaceId: input.workspaceId,
      entityType: "intake_credential",
      entityId: row!.id,
      action: "intake_credential_minted",
      actorType: "human",
      actorId: input.createdBy,
      // audit carries no key material — last4 and the binding only
      after: {
        projectId: project.id,
        teamId: teamId ?? null,
        label: input.label,
        keyLast4,
      },
    });
    return row!;
  });

  return { key, credential };
}

export async function listIntakeCredentials(
  workspaceId: string,
): Promise<IntakeCredentialView[]> {
  return db
    .select(viewColumns)
    .from(intakeCredentials)
    .where(eq(intakeCredentials.workspaceId, workspaceId))
    .orderBy(desc(intakeCredentials.createdAt));
}

/**
 * Revoke is idempotent: a repeat keeps the original revokedAt and succeeds. A
 * credential id from another workspace is invisible here and yields null, so
 * the route answers 404 rather than leaking that the id exists.
 */
export async function revokeIntakeCredential(
  workspaceId: string,
  id: string,
  actorId: string,
): Promise<IntakeCredentialView | null> {
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(intakeCredentials)
      .set({ revokedAt: clock.now() })
      .where(
        and(
          eq(intakeCredentials.id, id),
          eq(intakeCredentials.workspaceId, workspaceId),
          isNull(intakeCredentials.revokedAt),
        ),
      )
      .returning(viewColumns);
    if (revoked) {
      await tx.insert(events).values({
        workspaceId,
        entityType: "intake_credential",
        entityId: revoked.id,
        action: "intake_credential_revoked",
        actorType: "human",
        actorId,
        after: { label: revoked.label, keyLast4: revoked.keyLast4 },
      });
      return revoked;
    }
    const [existing] = await tx
      .select(viewColumns)
      .from(intakeCredentials)
      .where(
        and(
          eq(intakeCredentials.id, id),
          eq(intakeCredentials.workspaceId, workspaceId),
        ),
      );
    return existing ?? null;
  });
}
