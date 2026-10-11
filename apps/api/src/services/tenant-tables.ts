// The tenancy table list: every table with a workspace_id column, and what
// a workspace export does with it. The tenancy suite (test/tenancy.test.ts)
// fails when a table with workspace_id is missing here, so a new tenant table
// forces an export decision in the same change.
//
// export: true  → rows are written to the workspace export, minus `redact`
//                 columns (credentials and their hashes are never exported)
// export: false → rows stay out; `reason` says why
// Hard delete (purge) removes rows from EVERY table listed here regardless.

export interface TenantTablePolicy {
  export: boolean;
  redact?: string[];
  reason?: string;
}

export const TENANT_TABLES: Record<string, TenantTablePolicy> = {
  agent_keys: { export: true, redact: ["token_hash"] },
  agents: { export: true, redact: ["endpoint_secret"] },
  auth_providers: {
    export: false,
    reason: "instance-scoped sign-in config (workspace_id reserved, NULL in v1); holds encrypted client secrets",
  },
  comments: { export: true },
  cycle_velocity: { export: true },
  cycles: { export: true },
  dispatch_events: { export: true },
  dispatches: { export: true },
  events: { export: true },
  github_installations: { export: true },
  github_issue_links: { export: true },
  github_repos: { export: true },
  invites: { export: true, redact: ["token_hash"] },
  issue_external_refs: { export: true },
  issues: { export: true },
  labels: { export: true },
  oauth_codes: {
    export: false,
    reason: "one-minute sign-in handoff codes (hashes); transient auth state, not workspace content",
  },
  oauth_grants: { export: true },
  project_milestones: { export: true },
  projects: { export: true },
  sessions: {
    export: false,
    reason: "live sign-in sessions (token hashes and expiry only); not workspace content",
  },
  slack_links: { export: true },
  teams: { export: true },
  user_tokens: { export: true, redact: ["token_hash"] },
  views: { export: true },
  webhook_deliveries: { export: true },
  webhook_endpoints: { export: true, redact: ["secret"] },
  workspace_members: { export: true },
};

// tenant-owned rows in tables without workspace_id, reached through a parent
// that has one. Exported alongside the tenant tables.
export const TENANT_JOIN_TABLES: Record<string, { parent: string; fk: string }> = {
  issue_labels: { parent: "issues", fk: "issue_id" },
  team_members: { parent: "teams", fk: "team_id" },
};
