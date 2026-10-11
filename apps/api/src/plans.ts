// Plan limits: the ONE place these numbers live (PLAN-059, go-live PLAN.md
// section 6). `null` means unlimited. Only consulted when BILLING=on; with
// BILLING=off (the default, every self-hosted install) entitlements() always
// returns self_host_unlimited and nothing is enforced.
//
// Pricing figures are hypotheses (PLAN.md "Hosted Free" / "Hosted Team"):
// change them here, not at the call sites.

export type PlanId = "free" | "team" | "self_host_unlimited";

export interface PlanLimits {
  /** workspaces one person may own on this plan */
  maxWorkspaces: number | null;
  /** human members (agents are never members, see KTD6/R24) */
  maxSeats: number | null;
  /** registered agents */
  maxAgents: number | null;
  /** agent runs (dispatches) per calendar month, UTC */
  agentRunsPerMonth: number | null;
}

export interface Plan {
  id: PlanId;
  label: string;
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    label: "Free",
    limits: { maxWorkspaces: 1, maxSeats: 3, maxAgents: 3, agentRunsPerMonth: 1_000 },
  },
  team: {
    id: "team",
    label: "Team",
    // seats are bought per person on Team; no seat cap until a billing
    // provider syncs a purchased count (PLAN-060)
    limits: { maxWorkspaces: null, maxSeats: null, maxAgents: null, agentRunsPerMonth: 25_000 },
  },
  self_host_unlimited: {
    id: "self_host_unlimited",
    label: "Self-hosted",
    limits: { maxWorkspaces: null, maxSeats: null, maxAgents: null, agentRunsPerMonth: null },
  },
};
