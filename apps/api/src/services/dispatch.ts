import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { config_ } from "../env.js";
import {
  dispatchFailureTargets,
  notifyUsers,
} from "./notifications.js";
import {
  agents,
  comments,
  dispatches,
  events,
  issues,
} from "../db/schema.js";
import {
  generateEndpointSecret,
  queueDeliveries,
  queueDispatchDelivery,
} from "./outbound.js";
import { clock } from "./clock.js";
import { withAgentRunSlot } from "./entitlements.js";
import { ensureSession } from "./agent-sessions.js";

// ── Adapter contract ─────────────────────────────────────────────
// Third-party harnesses implement this shape and register by harness
// name. launch() must return promptly; long-running work happens in
// the harness itself, which reports back over the REST API.
// See docs/adapters.md.

export interface DispatchContext {
  dispatchId: string;
  workspaceId: string;
  issue: { id: string; key: string; title: string; description: string | null };
  agent: {
    id: string;
    name: string;
    harness: string;
    endpointUrl: string | null;
    endpointSecret: string | null;
  };
  trigger: "assign" | "mention";
  commentBody?: string | undefined;
}

export interface DispatchResult {
  sessionId?: string | undefined;
  // adapter handed the dispatch to an async delivery pipeline — processDispatch
  // must not mark it claimed; the delivery writeback owns the transition
  handoff?: boolean | undefined;
}

export interface DispatchAdapter {
  name: string;
  launch(ctx: DispatchContext): Promise<DispatchResult>;
}

const localAdapter: DispatchAdapter = {
  name: "local",
  // claimed immediately — a human runs `tallyline claim` / MCP on this box
  async launch() {
    return {};
  },
};

const webhookAdapter: DispatchAdapter = {
  name: "webhook",
  async launch(ctx) {
    if (!ctx.agent.endpointUrl) {
      throw new Error(`agent '${ctx.agent.name}' has no endpointUrl configured`);
    }
    // durable signed delivery — first attempt now, retries via the sweeper,
    // terminal states write back to the dispatch + issue thread
    if (!ctx.agent.endpointSecret) {
      await db
        .update(agents)
        .set({ endpointSecret: generateEndpointSecret() })
        .where(eq(agents.id, ctx.agent.id));
    }
    await queueDispatchDelivery({
      workspaceId: ctx.workspaceId,
      dispatchId: ctx.dispatchId,
      payload: {
        dispatchId: ctx.dispatchId,
        issue: ctx.issue,
        agent: { id: ctx.agent.id, name: ctx.agent.name },
        trigger: ctx.trigger,
        comment: ctx.commentBody,
      },
    });
    return { handoff: true };
  },
};

// harness name → adapter. 'claude-code'/'codex'/'opencode' are local
// harnesses: claiming happens in-repo via CLI/MCP, not over HTTP.
const ADAPTERS: Record<string, DispatchAdapter> = {
  local: localAdapter,
  "claude-code": localAdapter,
  codex: localAdapter,
  opencode: localAdapter,
  webhook: webhookAdapter,
};

async function systemComment(
  workspaceId: string,
  issueId: string,
  body: string,
) {
  await db.insert(comments).values({
    workspaceId,
    issueId,
    actorType: "system",
    actorId: null,
    body,
  });
}

async function fail(
  dispatch: { id: string; workspaceId: string; issueId: string },
  reason: string,
) {
  await db
    .update(dispatches)
    .set({ status: "dispatch_failed", reason, updatedAt: clock.now() })
    .where(eq(dispatches.id, dispatch.id));
  await db.insert(events).values({
    workspaceId: dispatch.workspaceId,
    entityType: "issue",
    entityId: dispatch.issueId,
    action: "dispatch_failed",
    actorType: "system",
    actorId: null,
    after: { dispatchId: dispatch.id, reason },
  });
  await queueDeliveries({
    workspaceId: dispatch.workspaceId,
    entityType: "issue",
    entityId: dispatch.issueId,
    action: "dispatch_failed",
    actorType: "system",
    actorId: null,
    after: { dispatchId: dispatch.id, reason },
  });
  await systemComment(
    dispatch.workspaceId,
    dispatch.issueId,
    `dispatch_failed: ${reason}`,
  );
  // a failed dispatch needs human eyes — assignee first, then creator, then staff
  await notifyUsers(
    dispatch.workspaceId,
    await dispatchFailureTargets(dispatch.workspaceId, dispatch.issueId),
    { kind: "dispatch_failed", issueId: dispatch.issueId },
  );
}

async function processDispatch(dispatchId: string): Promise<void> {
  const [dispatch] = await db
    .select()
    .from(dispatches)
    .where(eq(dispatches.id, dispatchId))
    .limit(1);
  if (!dispatch || dispatch.status !== "queued") return;

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, dispatch.agentId))
    .limit(1);
  const [issue] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, dispatch.issueId))
    .limit(1);
  if (!agent || !issue) {
    await fail(dispatch, "agent or issue no longer exists");
    return;
  }

  const adapter = ADAPTERS[agent.harness];
  if (!adapter) {
    await db
      .update(dispatches)
      .set({ adapter: agent.harness, updatedAt: clock.now() })
      .where(eq(dispatches.id, dispatch.id));
    await fail(dispatch, `no adapter registered for harness '${agent.harness}'`);
    return;
  }

  try {
    const result = await adapter.launch({
      dispatchId: dispatch.id,
      workspaceId: dispatch.workspaceId,
      issue: {
        id: issue.id,
        key: issue.key,
        title: issue.title,
        description: issue.description,
      },
      agent: {
        id: agent.id,
        name: agent.name,
        harness: agent.harness,
        endpointUrl: agent.endpointUrl,
        endpointSecret: agent.endpointSecret,
      },
      trigger: dispatch.trigger,
      commentBody: dispatch.commentBody ?? undefined,
    });
    await db
      .update(dispatches)
      .set({ adapter: adapter.name, updatedAt: clock.now() })
      .where(eq(dispatches.id, dispatch.id));
    if (!result?.handoff) {
      await db
        .update(dispatches)
        .set({ status: "claimed", updatedAt: clock.now() })
        .where(eq(dispatches.id, dispatch.id));
      await systemComment(
        dispatch.workspaceId,
        dispatch.issueId,
        `@${agent.name} picked up via ${adapter.name} adapter`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db
      .update(dispatches)
      .set({ adapter: adapter.name, updatedAt: clock.now() })
      .where(eq(dispatches.id, dispatch.id));
    await fail(dispatch, reason);
  }
}

export async function createDispatch(input: {
  workspaceId: string;
  issueId: string;
  agentId: string;
  trigger: "assign" | "mention";
  commentBody?: string;
}) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  if (!agent) return null;
  // Plan limit: callers pre-check assertWithinLimit("agent_runs") before their
  // own writes for a clean refusal. This insert is the authoritative,
  // atomic check (count + insert under an advisory lock); it only throws
  // when concurrent requests filled the month between pre-check and here.
  const [dispatch] = await withAgentRunSlot(input.workspaceId, (tx) => tx
    .insert(dispatches)
    .values({
      // the clock, not the DB, so monthly run windows are testable
      createdAt: clock.now(),
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      agentId: input.agentId,
      trigger: input.trigger,
      commentBody: input.commentBody ?? null,
    })
    .returning());

  // plan L1: one typed agent session per dispatch, pending until the
  // agent's first activity
  await ensureSession({
    workspaceId: input.workspaceId,
    dispatchId: dispatch!.id,
    issueId: input.issueId,
    agentId: input.agentId,
  });

  await db.insert(events).values({
    workspaceId: input.workspaceId,
    entityType: "issue",
    entityId: input.issueId,
    action: "dispatched",
    actorType: "system",
    actorId: null,
    after: {
      dispatchId: dispatch!.id,
      agent: agent.name,
      trigger: input.trigger,
    },
  });
  await queueDeliveries({
    workspaceId: input.workspaceId,
    entityType: "issue",
    entityId: input.issueId,
    action: "dispatched",
    actorType: "system",
    actorId: null,
    after: {
      dispatchId: dispatch!.id,
      agent: agent.name,
      trigger: input.trigger,
    },
  });
  await systemComment(
    input.workspaceId,
    input.issueId,
    `dispatching to @${agent.name} (${input.trigger})…`,
  );

  await processDispatch(dispatch!.id);
  return dispatch!;
}

// Sweeper: a dispatch still `queued` past the ack window means the delivery
// pipeline wedged without a terminal writeback — fail it loudly on the issue
// thread instead of letting it hang. `claimed` rows are never touched:
// claiming is the acknowledgement. Runs on the API interval alongside the
// delivery and cycle sweepers. `timeoutMs <= 0` disables the sweep.
export async function sweepStaleDispatches(
  timeoutMs = config_.dispatchAckTimeoutMs,
  now = clock.now(),
): Promise<number> {
  if (timeoutMs <= 0) return 0;
  const stale = await db
    .select({ id: dispatches.id, workspaceId: dispatches.workspaceId, issueId: dispatches.issueId })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.status, "queued"),
        lt(dispatches.createdAt, new Date(now.getTime() - timeoutMs)),
      ),
    );
  let swept = 0;
  for (const d of stale) {
    // flip only if still queued — a delivery writeback can claim the row
    // between the select and the update; losing that race must not kill it
    const flipped = await db
      .update(dispatches)
      .set({
        status: "dispatch_failed",
        reason: `no acknowledgement within ${Math.round(timeoutMs / 1000)}s`,
        updatedAt: now,
      })
      .where(
        and(eq(dispatches.id, d.id), eq(dispatches.status, "queued")),
      )
      .returning({ id: dispatches.id });
    if (flipped.length === 0) continue;
    // fail() rewrites the same status/reason then fans out event + comment
    await fail(
      d,
      `no acknowledgement within ${Math.round(timeoutMs / 1000)}s`,
    );
    swept++;
  }
  return swept;
}
