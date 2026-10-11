import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, getTableColumns, isNull, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { safePost } from "../lib/net-guard.js";
import {
  agents,
  comments,
  dispatches,
  events,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
} from "../db/schema.js";
import { clock } from "./clock.js";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;

export interface OutboundEvent {
  workspaceId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorType: string;
  actorId: string | null;
  before?: Record<string, unknown> | undefined;
  after?: Record<string, unknown> | undefined;
  issueKey?: string | undefined;
}

export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

// X-Tallyline-Signature verification for consumers (documented in docs/webhooks.md)
export function signDelivery(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function verifyDeliverySignature(
  body: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = signDelivery(body, secret);
  const received = signatureHeader;
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// fan-out: every recorded event queues a pending delivery per matching endpoint
export async function queueDeliveries(ev: OutboundEvent): Promise<void> {
  // catalog action: 'issue.created', 'dispatch.*' etc = entityType.action
  const action = `${ev.entityType}.${ev.action}`;
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.workspaceId, ev.workspaceId),
        eq(webhookEndpoints.enabled, true),
      ),
    );
  const matching = endpoints.filter(
    (e) => e.events.includes("*") || e.events.includes(action),
  );
  for (const endpoint of matching) {
    const [row] = await db
      .insert(webhookDeliveries)
      .values({
        workspaceId: ev.workspaceId,
        endpointId: endpoint.id,
        action,
        payload: { ...ev, action } as Record<string, unknown>,
      })
      .returning();
    await deliver(row!, endpoint);
  }
}

interface DeliveryTarget {
  url: string;
  secret: string;
}

// agent dispatch → durable delivery. First attempt is synchronous (adapter
// sees the immediate outcome); failures retry via sweepDeliveries and write
// back to the dispatch record + issue thread on terminal states.
export async function queueDispatchDelivery(input: {
  workspaceId: string;
  dispatchId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      workspaceId: input.workspaceId,
      dispatchId: input.dispatchId,
      action: "dispatch.dispatched",
      payload: input.payload,
    })
    .returning();
  const target = await dispatchTarget(input.dispatchId);
  if (!target) {
    await db
      .update(webhookDeliveries)
      .set({ status: "failed", lastError: "agent endpoint removed" })
      .where(eq(webhookDeliveries.id, row!.id));
    await dispatchWriteback(row!, "failed", "agent endpoint removed");
    return;
  }
  await deliver(row!, target);
  const [after] = await db
    .select({ status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, row!.id))
    .limit(1);
  if (after?.status === "delivered") {
    await dispatchWriteback(row!, "delivered", null);
  } else if (after?.status === "failed") {
    await dispatchWriteback(row!, "failed", "dispatch delivery failed");
  }
}

async function dispatchTarget(
  dispatchId: string,
): Promise<DeliveryTarget | null> {
  const [row] = await db
    .select({
      url: agents.endpointUrl,
      secret: agents.endpointSecret,
    })
    .from(dispatches)
    .innerJoin(agents, eq(dispatches.agentId, agents.id))
    .where(eq(dispatches.id, dispatchId))
    .limit(1);
  if (!row?.url || !row.secret) return null;
  return { url: row.url, secret: row.secret };
}

// terminal writeback for dispatch deliveries: delivered → claimed; exhausted
// → dispatch_failed. Always visible on the issue thread.
async function dispatchWriteback(
  row: typeof webhookDeliveries.$inferSelect,
  outcome: "delivered" | "failed",
  reason: string | null,
): Promise<void> {
  if (!row.dispatchId) return;
  const [dispatch] = await db
    .select()
    .from(dispatches)
    .where(eq(dispatches.id, row.dispatchId))
    .limit(1);
  if (!dispatch || dispatch.status !== "queued") return;
  const status = outcome === "delivered" ? "claimed" : "dispatch_failed";
  const lastError = reason ?? row.lastError;
  await db
    .update(dispatches)
    .set({ status, ...(status === "dispatch_failed" ? { reason: lastError } : {}), updatedAt: clock.now() })
    .where(eq(dispatches.id, dispatch.id));
  const action =
    outcome === "delivered" ? "dispatch_delivered" : "dispatch_failed";
  const after = { dispatchId: dispatch.id, ...(reason ? { reason: lastError } : {}) };
  await db.insert(events).values({
    workspaceId: dispatch.workspaceId,
    entityType: "issue",
    entityId: dispatch.issueId,
    action,
    actorType: "system",
    actorId: null,
    after,
  });
  await queueDeliveries({
    workspaceId: dispatch.workspaceId,
    entityType: "issue",
    entityId: dispatch.issueId,
    action,
    actorType: "system",
    actorId: null,
    after,
  });
  await db.insert(comments).values({
    workspaceId: dispatch.workspaceId,
    issueId: dispatch.issueId,
    actorType: "system",
    actorId: null,
    body:
      outcome === "delivered"
        ? "dispatch handed off — endpoint acknowledged"
        : `dispatch_failed: endpoint unreachable after ${MAX_ATTEMPTS} attempts${lastError ? ` (${lastError})` : ""}`,
  });
}

async function deliver(
  row: typeof webhookDeliveries.$inferSelect,
  target: DeliveryTarget,
): Promise<void> {
  const body = JSON.stringify({
    id: row.id,
    action: row.action,
    ...(row.payload as Record<string, unknown>),
  });
  try {
    // SSRF guard: address validated at connect time, redirects not followed
    const status = await safePost(target.url, {
      headers: {
        "content-type": "application/json",
        "x-tallyline-event": row.action,
        "x-tallyline-delivery": row.id,
        "x-tallyline-signature": signDelivery(body, target.secret),
      },
      body,
      timeoutMs: 8000,
    });
    if (status < 200 || status >= 300) {
      throw new Error(`endpoint returned ${status}`);
    }
    await db
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        attempts: row.attempts + 1,
        deliveredAt: clock.now(),
      })
      .where(eq(webhookDeliveries.id, row.id));
  } catch (err) {
    const attempts = row.attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    await db
      .update(webhookDeliveries)
      .set({
        status: exhausted ? "failed" : "pending",
        attempts,
        lastError: err instanceof Error ? err.message : String(err),
        nextAttemptAt: new Date(
          clock.ms() + BASE_BACKOFF_MS * 2 ** (attempts - 1),
        ),
      })
      .where(eq(webhookDeliveries.id, row.id));
  }
}

// sweeper: retries due pending deliveries — runs on an interval at boot
export async function sweepDeliveries(now = clock.now()): Promise<number> {
  const due = await db
    .select(getTableColumns(webhookDeliveries))
    .from(webhookDeliveries)
    .innerJoin(workspaces, eq(workspaces.id, webhookDeliveries.workspaceId))
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, now),
        // pending-deletion workspaces send nothing; retries resume on restore
        isNull(workspaces.deletedAt),
      ),
    )
    .orderBy(asc(webhookDeliveries.createdAt))
    .limit(100);
  let attempted = 0;
  for (const row of due) {
    let target: DeliveryTarget | null = null;
    if (row.endpointId) {
      const [endpoint] = await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, row.endpointId))
        .limit(1);
      if (endpoint?.enabled) target = endpoint;
    } else if (row.dispatchId) {
      target = await dispatchTarget(row.dispatchId);
    }
    if (!target) continue;
    await deliver(row, target);
    attempted++;
    if (row.dispatchId) {
      const [after] = await db
        .select({ status: webhookDeliveries.status })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, row.id))
        .limit(1);
      if (after?.status === "delivered") {
        await dispatchWriteback(row, "delivered", null);
      } else if (after?.status === "failed") {
        await dispatchWriteback(row, "failed", null);
      }
    }
  }
  return attempted;
}
