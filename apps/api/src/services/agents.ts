import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentKeys, agents } from "../db/schema.js";
import { config_ } from "../env.js";
import { clock } from "./clock.js";

export interface AgentAuth {
  agentId: string;
  agentName: string;
  workspaceId: string;
  keyId: string;
  scopes: string[];
}

export async function createAgentKey(
  agentId: string,
  workspaceId: string,
  name: string,
  scopes: string[],
  expiresAt?: Date,
): Promise<{ key: string; id: string }> {
  const key = `tly_agt_${randomBytes(24).toString("base64url")}`;
  const [row] = await db
    .insert(agentKeys)
    .values({
      agentId,
      workspaceId,
      name,
      tokenHash: hashKey(key),
      scopes,
      ...(expiresAt ? { expiresAt } : {}),
    })
    .returning();
  return { key, id: row!.id };
}

export const MAX_ROTATE_GRACE_SECONDS = 86_400;

/** default expiry for a key whose caller gave none (null = never) */
export function defaultKeyExpiry(): Date | undefined {
  const days = config_.agentKeyDefaultExpiryDays;
  return days > 0 ? new Date(clock.ms() + days * 86_400_000) : undefined;
}

/**
 * Revoke = delete the row. agentFromKey looks the hash up on every request
 * (no cache), so the key is dead on its next call.
 */
export async function revokeAgentKey(
  agentId: string,
  workspaceId: string,
  keyId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .delete(agentKeys)
    .where(
      and(
        eq(agentKeys.id, keyId),
        eq(agentKeys.agentId, agentId),
        eq(agentKeys.workspaceId, workspaceId),
      ),
    )
    .returning({ id: agentKeys.id, name: agentKeys.name });
  return row ?? null;
}

/**
 * Mint a replacement (same name and scopes) and end the old key: at once, or
 * after graceSeconds for a planned rotation. An old key that already expires
 * sooner keeps its earlier expiry.
 */
export async function rotateAgentKey(
  agentId: string,
  workspaceId: string,
  keyId: string,
  graceSeconds: number,
): Promise<{
  key: string;
  id: string;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
  oldExpiresAt: Date;
} | null> {
  return db.transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(agentKeys)
      .where(
        and(
          eq(agentKeys.id, keyId),
          eq(agentKeys.agentId, agentId),
          eq(agentKeys.workspaceId, workspaceId),
        ),
      )
      .for("update");
    if (!old) return null;
    const now = clock.ms();
    const graceEnd = new Date(now + graceSeconds * 1000);
    const oldExpiresAt =
      old.expiresAt && old.expiresAt < graceEnd ? old.expiresAt : graceEnd;
    const key = `tly_agt_${randomBytes(24).toString("base64url")}`;
    const expiresAt = defaultKeyExpiry() ?? null;
    const [row] = await tx
      .insert(agentKeys)
      .values({
        agentId,
        workspaceId,
        name: old.name,
        tokenHash: hashKey(key),
        scopes: old.scopes,
        ...(expiresAt ? { expiresAt } : {}),
      })
      .returning();
    await tx
      .update(agentKeys)
      .set({ expiresAt: oldExpiresAt })
      .where(eq(agentKeys.id, old.id));
    return {
      key,
      id: row!.id,
      name: old.name,
      scopes: old.scopes,
      expiresAt,
      oldExpiresAt,
    };
  });
}

export async function agentFromKey(
  key: string,
): Promise<AgentAuth | null> {
  const [row] = await db
    .select({
      keyId: agentKeys.id,
      agentId: agentKeys.agentId,
      workspaceId: agentKeys.workspaceId,
      scopes: agentKeys.scopes,
      agentName: agents.name,
    })
    .from(agentKeys)
    .innerJoin(agents, eq(agents.id, agentKeys.agentId))
    .where(
      and(
        eq(agentKeys.tokenHash, hashKey(key)),
        or(
          isNull(agentKeys.expiresAt),
          gt(agentKeys.expiresAt, clock.now()),
        ),
      ),
    );
  if (!row) return null;
  // fire-and-forget usage stamp
  void db
    .update(agentKeys)
    .set({ lastUsedAt: clock.now() })
    .where(eq(agentKeys.id, row.keyId))
    .catch(() => undefined);
  return row;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
