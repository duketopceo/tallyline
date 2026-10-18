import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentKeys, agents, events } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
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

// In-process fan-out so a revoke or an immediate rotate aborts that key's open
// SSE streams at once. Other processes (and grace-window expiry) are caught by
// the stream heartbeat re-validating with agentKeyActive.
const keyEndListeners = new Map<string, Set<() => void>>();

export function onAgentKeyEnded(keyId: string, fn: () => void): () => void {
  let set = keyEndListeners.get(keyId);
  if (!set) keyEndListeners.set(keyId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) keyEndListeners.delete(keyId);
  };
}

function signalAgentKeyEnded(keyId: string): void {
  for (const fn of [...(keyEndListeners.get(keyId) ?? [])]) fn();
}

/** true while the key row exists and has not expired */
export async function agentKeyActive(keyId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentKeys.id })
    .from(agentKeys)
    .where(
      and(
        eq(agentKeys.id, keyId),
        or(isNull(agentKeys.expiresAt), gt(agentKeys.expiresAt, clock.now())),
      ),
    );
  return Boolean(row);
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
  if (row) signalAgentKeyEnded(row.id);
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
  actorId: string,
): Promise<{
  key: string;
  id: string;
  name: string;
  scopes: string[];
  expiresAt: Date | null;
  oldExpiresAt: Date;
} | null> {
  const result = await db.transaction(async (tx) => {
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
    // an expired key is as good as gone; a key already rotated out is still
    // inside its grace window (a rotation event exists), so refuse a second
    if (!old || (old.expiresAt && old.expiresAt <= clock.now())) return null;
    const [pending] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.entityType, "agent_key"),
          eq(events.entityId, old.id),
          eq(events.action, "agent_key_rotated"),
        ),
      )
      .limit(1);
    if (pending) {
      throw new HttpError(409, "CONFLICT", "key is already being rotated out");
    }
    const now = clock.ms();
    const graceEnd = new Date(now + graceSeconds * 1000);
    const oldExpiresAt =
      old.expiresAt && old.expiresAt < graceEnd ? old.expiresAt : graceEnd;
    const key = `tly_agt_${randomBytes(24).toString("base64url")}`;
    // keep the old key's original lifespan when it had one
    const lifespanMs = old.expiresAt
      ? old.expiresAt.getTime() - old.createdAt.getTime()
      : 0;
    const expiresAt =
      lifespanMs > 0 ? new Date(now + lifespanMs) : (defaultKeyExpiry() ?? null);
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
    // written in the same transaction: it is also the pending-rotation marker.
    // Names and ids only, never key material.
    await tx.insert(events).values({
      workspaceId,
      entityType: "agent_key",
      entityId: old.id,
      action: "agent_key_rotated",
      actorType: "human",
      actorId,
      after: {
        agentId,
        name: old.name,
        newKeyId: row!.id,
        graceSeconds,
        oldExpiresAt: oldExpiresAt.toISOString(),
      },
    });
    return {
      key,
      id: row!.id,
      name: old.name,
      scopes: old.scopes,
      expiresAt,
      oldExpiresAt,
    };
  });
  if (result && graceSeconds === 0) signalAgentKeyEnded(keyId);
  return result;
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
