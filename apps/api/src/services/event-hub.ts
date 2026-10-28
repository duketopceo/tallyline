import { and, asc, desc, eq, gt, sql, type SQL } from "drizzle-orm";
import type { ActorType } from "@tallyline/types";
import { db } from "../db/client.js";
import { agents, events, issues, users } from "../db/schema.js";

// Shared events feed query + the process-wide poller behind the SSE stream.
//
// One poller per API process, not one per connection: a single 1s tick reads
// `events.id > highWater` and fans rows out to per-workspace subscribers.
// Postgres LISTEN/NOTIFY is the documented upgrade path if ~1s fan-out ever
// proves too slow — the subscriber surface is already the right shape.

export const EVENT_POLL_MS = 1_000;
const BATCH_SIZE = 200;

export interface FeedEvent {
  id: string; // bigserial — serialized as string so clients never truncate
  entityType: string;
  entityId: string;
  action: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  issueKey: string | null;
  issueTitle: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export function feedEventsQuery(
  where: SQL | undefined,
  order: "asc" | "desc",
  limit: number,
) {
  return db
    .select({
      id: events.id,
      workspaceId: events.workspaceId,
      entityType: events.entityType,
      entityId: events.entityId,
      action: events.action,
      actorType: events.actorType,
      actorId: events.actorId,
      before: events.before,
      after: events.after,
      createdAt: events.createdAt,
      issueKey: issues.key,
      issueTitle: issues.title,
      userName: users.name,
      agentName: agents.name,
    })
    .from(events)
    .leftJoin(
      issues,
      and(eq(issues.id, events.entityId), eq(events.entityType, "issue")),
    )
    .leftJoin(users, eq(users.id, events.actorId))
    .leftJoin(agents, eq(agents.id, events.actorId))
    .where(where)
    .orderBy(order === "asc" ? asc(events.id) : desc(events.id))
    .limit(limit);
}

export type FeedRow = Awaited<ReturnType<typeof feedEventsQuery>>[number];

export function toFeedEvent(row: FeedRow): FeedEvent {
  return {
    id: String(row.id),
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName:
      row.actorType === "agent"
        ? row.agentName
        : row.actorType === "human"
          ? row.userName
          : null,
    issueKey: row.issueKey,
    issueTitle: row.issueTitle,
    before: row.before,
    after: row.after,
    createdAt: row.createdAt.toISOString(),
  };
}

type Listener = (row: FeedRow) => void;

const listeners = new Map<string, Set<Listener>>();
let highWater: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let polls = 0;

/** Test hook — how many polls the process has run since boot. */
export function getPollCount(): number {
  return polls;
}

async function tick(): Promise<void> {
  polls += 1;
  if (highWater === null) {
    // first tick only establishes the watermark — backlog rows belong to each
    // connection's own resume/drain path, never to push fan-out
    const [row] = await db
      .select({ m: sql<number | null>`max(${events.id})` })
      .from(events);
    highWater = row?.m ?? 0;
    return;
  }
  // drain pages: a burst larger than one batch must not fall behind
  for (;;) {
    const rows = await feedEventsQuery(
      gt(events.id, highWater),
      "asc",
      BATCH_SIZE,
    );
    for (const row of rows) {
      highWater = row.id;
      const set = listeners.get(row.workspaceId);
      if (!set) continue;
      for (const cb of set) {
        try {
          cb(row);
        } catch {
          // one broken stream must not stall fan-out for the rest
        }
      }
    }
    if (rows.length < BATCH_SIZE) break;
  }
}

/**
 * Subscribe to committed events for one workspace. Lazily starts the shared
 * poller on first subscriber; stops it when the last one disconnects.
 * Returns an unsubscribe function.
 */
export function subscribeEvents(
  workspaceId: string,
  listener: Listener,
): () => void {
  let set = listeners.get(workspaceId);
  if (!set) {
    set = new Set();
    listeners.set(workspaceId, set);
  }
  set.add(listener);

  if (timer === null) {
    void tick().catch(() => undefined);
    timer = setInterval(() => {
      void tick().catch(() => undefined);
    }, EVENT_POLL_MS);
  }

  return () => {
    const s = listeners.get(workspaceId);
    if (s?.delete(listener) && s.size === 0) listeners.delete(workspaceId);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      // next stream re-establishes the watermark — avoids replaying whatever
      // landed while nobody was listening
      highWater = null;
    }
  };
}
