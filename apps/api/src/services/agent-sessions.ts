import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
  nextSessionStatus,
  TERMINAL_SESSION_STATUSES,
  type AgentActivityInput,
  type AgentSessionStatus,
} from "@tallyline/types";
import { db } from "../db/client.js";
import { config_ } from "../env.js";
import {
  agentActivities,
  agentSessions,
  comments,
  events,
} from "../db/schema.js";
import { clock } from "./clock.js";
import { queueDeliveries } from "./outbound.js";

// ── Agent sessions (plan L1) ─────────────────────────────────────
// One session per dispatch, created `pending` alongside the dispatch. The
// adapter (or the agent itself over REST/MCP) posts typed activities; the
// transition table in @tallyline/types decides the next status. Every
// transition lands on the issue feed so SSE subscribers and the web
// session thread stay live.

export class SessionTransitionError extends Error {
  constructor(
    readonly status: AgentSessionStatus,
    readonly activityType: string,
  ) {
    super(`activity '${activityType}' is not allowed while session is '${status}'`);
    this.name = "SessionTransitionError";
  }
}

export async function ensureSession(input: {
  workspaceId: string;
  dispatchId: string;
  issueId: string;
  agentId: string;
}) {
  const [existing] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.dispatchId, input.dispatchId))
    .limit(1);
  if (existing) return existing;
  const [row] = await db
    .insert(agentSessions)
    .values({
      workspaceId: input.workspaceId,
      dispatchId: input.dispatchId,
      issueId: input.issueId,
      agentId: input.agentId,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [raced] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.dispatchId, input.dispatchId))
    .limit(1);
  return raced!;
}

export async function getSession(sessionId: string) {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

export async function listActivities(sessionId: string) {
  return db
    .select()
    .from(agentActivities)
    .where(eq(agentActivities.sessionId, sessionId))
    .orderBy(agentActivities.id);
}

async function feed(
  session: typeof agentSessions.$inferSelect,
  action: string,
  actor: { actorType: "human" | "agent" | "system"; actorId: string | null },
  detail: Record<string, unknown>,
) {
  const base = {
    workspaceId: session.workspaceId,
    entityType: "issue",
    entityId: session.issueId,
    action,
    actorType: actor.actorType,
    actorId: actor.actorId,
    after: { sessionId: session.id, dispatchId: session.dispatchId, ...detail },
  };
  await db.insert(events).values(base);
  await queueDeliveries(base);
}

export async function postActivity(
  sessionId: string,
  input: AgentActivityInput,
  actor: { actorType: "human" | "agent" | "system"; actorId: string | null },
) {
  const session = await getSession(sessionId);
  if (!session) return null;
  const next = nextSessionStatus(session.status, input);
  if (next === null) {
    throw new SessionTransitionError(session.status, input.content.type);
  }
  const now = clock.now();

  const { type, ...content } = input.content;
  const ended = TERMINAL_SESSION_STATUSES.has(next);

  // one transaction, compare-and-set on the status we read: a concurrent
  // stop, sweep or final response must not be overwritten by a stale read
  const written = await db.transaction(async (tx) => {
    const [flipped] = await tx
      .update(agentSessions)
      .set({
        status: next,
        lastActivityAt: now,
        updatedAt: now,
        ...(ended ? { endedAt: now } : {}),
      })
      .where(
        and(
          eq(agentSessions.id, session.id),
          eq(agentSessions.status, session.status),
        ),
      )
      .returning();
    if (!flipped) return null;

    // ephemeral rows replace the previous ephemeral row — progress text
    // should not accumulate
    if (input.ephemeral) {
      await tx
        .delete(agentActivities)
        .where(
          and(
            eq(agentActivities.sessionId, session.id),
            eq(agentActivities.ephemeral, true),
          ),
        );
    }
    const [activity] = await tx
      .insert(agentActivities)
      .values({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        type,
        content,
        ephemeral: input.ephemeral ?? false,
        signal: input.signal ?? null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        createdAt: now,
      })
      .returning();

    // elicitation is the one activity a human must see on the thread
    if (type === "elicitation") {
      await tx.insert(comments).values({
        workspaceId: session.workspaceId,
        issueId: session.issueId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        body: `agent needs input: ${(input.content as { body: string }).body}`,
      });
    }
    return { updated: flipped, activity: activity! };
  });
  if (!written) {
    // lost the race: report the status that won
    const current = await getSession(session.id);
    throw new SessionTransitionError(
      current?.status ?? session.status,
      input.content.type,
    );
  }
  const { updated, activity } = written;

  const statusChanged = next !== session.status;
  await feed(
    updated,
    statusChanged ? "session_status" : "session_activity",
    actor,
    {
      status: next,
      previousStatus: session.status,
      activityType: type,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );

  return { session: updated, activity };
}

export async function setSessionPlan(
  sessionId: string,
  patch: { plan?: Record<string, unknown>; pullRequests?: string[] },
) {
  const now = clock.now();
  const [row] = await db
    .update(agentSessions)
    .set({
      ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
      ...(patch.pullRequests !== undefined
        ? { pullRequests: Array.from(new Set(patch.pullRequests)) }
        : {}),
      updatedAt: now,
    })
    .where(eq(agentSessions.id, sessionId))
    .returning();
  return row ?? null;
}

// Sweeper: `pending` sessions past the ack window never produced a first
// activity; `active`/`awaitingInput` sessions quiet past the idle window
// are abandoned. Both become `stale` with a feed entry. The dispatch row is
// left alone — sweepStaleDispatches owns that lifecycle.
export async function sweepStaleSessions(
  ackMs = config_.sessionAckTimeoutMs,
  idleMs = config_.sessionIdleTimeoutMs,
  now = clock.now(),
): Promise<number> {
  const conds = [];
  if (ackMs > 0) {
    conds.push(
      and(
        eq(agentSessions.status, "pending"),
        isNull(agentSessions.lastActivityAt),
        lt(agentSessions.createdAt, new Date(now.getTime() - ackMs)),
      ),
    );
  }
  if (idleMs > 0) {
    conds.push(
      and(
        inArray(agentSessions.status, ["active", "stopping"]),
        lt(agentSessions.lastActivityAt, new Date(now.getTime() - idleMs)),
      ),
    );
  }
  if (conds.length === 0) return 0;
  const stale = await db
    .select()
    .from(agentSessions)
    .where(or(...conds))
    .orderBy(desc(agentSessions.createdAt));
  let swept = 0;
  for (const s of stale) {
    const flipped = await db
      .update(agentSessions)
      .set({ status: "stale", endedAt: now, updatedAt: now })
      .where(and(eq(agentSessions.id, s.id), eq(agentSessions.status, s.status)))
      .returning();
    if (flipped.length === 0) continue;
    await feed(
      flipped[0]!,
      "session_status",
      { actorType: "system", actorId: null },
      {
        status: "stale",
        previousStatus: s.status,
        reason:
          s.status === "pending"
            ? `no activity within ${Math.round(ackMs / 1000)}s`
            : `idle for ${Math.round(idleMs / 1000)}s`,
      },
    );
    swept++;
  }
  return swept;
}
