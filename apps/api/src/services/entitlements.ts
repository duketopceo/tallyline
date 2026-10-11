import { and, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agents,
  dispatches,
  invites,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { PLANS, type PlanId, type PlanLimits } from "../plans.js";
import { clock } from "./clock.js";

// The single entitlement choke point (PLAN-059, go-live PLAN.md 1.2).
// entitlements() says what a workspace may do; assertWithinLimit() is called
// at exactly four places: member add (invite create / accept / SSO join),
// agent create + agent-key create, dispatch create, and workspace create.
// BILLING=off (default) => self_host_unlimited and every assert is a no-op.

export type LimitKind = "seats" | "agents" | "agent_keys" | "agent_runs" | "workspaces";

export interface Entitlements {
  plan: PlanId;
  planLabel: string;
  /** true only when BILLING=on: limits are enforced */
  enforced: boolean;
  limits: PlanLimits;
}

// test hook: flip billing without re-importing env (null = follow config)
let billingOverride: boolean | null = null;
export function setBillingForTests(on: boolean | null): void {
  billingOverride = on;
}
export function billingEnabled(): boolean {
  return billingOverride ?? config_.billing;
}

export function entitlementsFor(plan: PlanId): Entitlements {
  const effective: PlanId = billingEnabled() ? plan : "self_host_unlimited";
  const p = PLANS[effective];
  return { plan: p.id, planLabel: p.label, enforced: billingEnabled(), limits: { ...p.limits } };
}

export async function entitlements(workspaceId: string): Promise<Entitlements> {
  if (!billingEnabled()) return entitlementsFor("self_host_unlimited");
  const [ws] = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return entitlementsFor(ws?.plan ?? "free");
}

/** first instant of the current UTC calendar month, and of the next one */
export function monthWindow(now = clock.now()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

const count = sql<number>`count(*)::int`;

export async function seatCount(workspaceId: string): Promise<number> {
  const [r] = await db
    .select({ n: count })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return r?.n ?? 0;
}

/** live, unaccepted, unexpired invites: each one reserves a seat */
export async function pendingInviteCount(workspaceId: string): Promise<number> {
  const [r] = await db
    .select({ n: count })
    .from(invites)
    .where(
      and(
        eq(invites.workspaceId, workspaceId),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, clock.now()),
      ),
    );
  return r?.n ?? 0;
}

export async function agentCount(workspaceId: string): Promise<number> {
  const [r] = await db
    .select({ n: count })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  return r?.n ?? 0;
}

export async function agentRunsThisMonth(workspaceId: string): Promise<number> {
  const { start, end } = monthWindow();
  const [r] = await db
    .select({ n: count })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.workspaceId, workspaceId),
        gte(dispatches.createdAt, start),
        lt(dispatches.createdAt, end),
      ),
    );
  return r?.n ?? 0;
}

/** workspaces this person owns on the given plan (the per-person cap) */
export async function ownedWorkspaceCount(userId: string, plan: PlanId): Promise<number> {
  const [r] = await db
    .select({ n: count })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.role, "owner"),
        eq(workspaces.plan, plan),
      ),
    );
  return r?.n ?? 0;
}

export interface PlanLimitDetail {
  limit: LimitKind;
  plan: PlanId;
  max: number;
  used: number;
}

/** 402 PLAN_LIMIT with a machine-readable body (agents/CLI/MCP read `limit`) */
export class PlanLimitError extends HttpError {
  constructor(
    message: string,
    readonly detail: PlanLimitDetail,
  ) {
    super(402, "PLAN_LIMIT", message);
    this.name = "PlanLimitError";
  }
}

const n = (v: number) => v.toLocaleString("en-US");

function monthName(d: Date): string {
  return d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
}

// Copy rules (Silver Lining section 12): say what went wrong and what to do
// next, from the operator's side, no apology.
function limitMessage(kind: LimitKind, planLabel: string, max: number, used = max): string {
  switch (kind) {
    case "seats":
      return `This workspace has all ${n(max)} member seats included in the ${planLabel} plan in use (pending invites count). Remove a member or revoke an invite, or move to the Team plan.`;
    case "agents":
      return `This workspace has all ${n(max)} agents included in the ${planLabel} plan. Delete an agent you no longer use, or move to the Team plan.`;
    case "agent_keys":
      return `This workspace has more agents than the ${planLabel} plan includes (${n(max)}), so new agent keys are paused. Delete agents until you are within the limit, or move to the Team plan.`;
    case "agent_runs": {
      const { end } = monthWindow();
      return `This workspace has used all ${n(max)} agent runs included in the ${planLabel} plan this month. Runs reset on ${monthName(end)} 1. Assign the issue to a person for now, or move to the Team plan.`;
    }
    case "workspaces":
      return `You already own ${n(used)} workspace${used === 1 ? "" : "s"} on the ${planLabel} plan, which includes ${n(max)}. Use your existing workspace, or move it to the Team plan first.`;
  }
}

/**
 * Throws PlanLimitError (402 PLAN_LIMIT) when adding `adding` (default 1)
 * more of `kind` would exceed the workspace's plan. No-op with BILLING=off.
 * For "workspaces" pass the acting user's id as `subject`.
 *
 * Concurrency: this is a count, not a lock. Agent and invite creation
 * re-check with `adding = 0` after their insert and undo it when a
 * concurrent request got there first (both may lose; never both win).
 * Agent runs are pre-checked only, so simultaneous dispatches can overshoot
 * the monthly cap by at most the number in flight: a soft limit by design
 * (go-live PLAN.md: overage = block or upsell, never data loss).
 */
export async function assertWithinLimit(
  kind: Exclude<LimitKind, "workspaces">,
  workspaceId: string,
  adding?: number,
): Promise<void>;
export async function assertWithinLimit(kind: "workspaces", userId: string): Promise<void>;
export async function assertWithinLimit(kind: LimitKind, subject: string, adding = 1): Promise<void> {
  if (!billingEnabled()) return;
  if (kind === "workspaces") {
    // a new workspace starts on Free when billing is on
    const ent = entitlementsFor("free");
    const max = ent.limits.maxWorkspaces;
    if (max === null) return;
    const used = await ownedWorkspaceCount(subject, "free");
    if (used >= max) {
      throw new PlanLimitError(limitMessage(kind, ent.planLabel, max, used), {
        limit: kind,
        plan: ent.plan,
        max,
        used,
      });
    }
    return;
  }
  const ent = await entitlements(subject);
  let max: number | null;
  let used: number;
  let over: boolean;
  switch (kind) {
    case "seats":
      max = ent.limits.maxSeats;
      if (max === null) return;
      used = (await seatCount(subject)) + (await pendingInviteCount(subject));
      over = used + adding > max;
      break;
    case "agents":
      max = ent.limits.maxAgents;
      if (max === null) return;
      used = await agentCount(subject);
      over = used + adding > max;
      break;
    case "agent_keys":
      // keys are not capped themselves; minting pauses while the workspace
      // holds more agents than its plan allows (e.g. after a downgrade)
      max = ent.limits.maxAgents;
      if (max === null) return;
      used = await agentCount(subject);
      over = used > max;
      break;
    case "agent_runs":
      max = ent.limits.agentRunsPerMonth;
      if (max === null) return;
      used = await agentRunsThisMonth(subject);
      over = used + adding > max;
      break;
  }
  if (over) {
    throw new PlanLimitError(limitMessage(kind, ent.planLabel, max), {
      limit: kind,
      plan: ent.plan,
      max,
      used,
    });
  }
}

/** seat check for paths that must not throw (SSO joins); counts members only */
export async function hasFreeSeat(workspaceId: string): Promise<boolean> {
  if (!billingEnabled()) return true;
  const ent = await entitlements(workspaceId);
  const max = ent.limits.maxSeats;
  return max === null || (await seatCount(workspaceId)) < max;
}

/** invite accept: the invite already reserved its seat, so count members only */
export async function assertSeatForJoin(workspaceId: string): Promise<void> {
  if (!billingEnabled()) return;
  const ent = await entitlements(workspaceId);
  const max = ent.limits.maxSeats;
  if (max === null) return;
  const used = await seatCount(workspaceId);
  if (used >= max) {
    throw new PlanLimitError(limitMessage("seats", ent.planLabel, max), {
      limit: "seats",
      plan: ent.plan,
      max,
      used,
    });
  }
}
