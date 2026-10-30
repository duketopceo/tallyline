import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const issueStateEnum = pgEnum("issue_state", [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
  "duplicate",
]);

export const priorityEnum = pgEnum("priority", [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
]);

export const actorTypeEnum = pgEnum("actor_type", ["human", "agent", "system"]);

export const assigneeTypeEnum = pgEnum("assignee_type", ["human", "agent"]);

export const issueSourceEnum = pgEnum("issue_source", [
  "web",
  "github",
  "slack",
  "api",
  "voice",
  "intake",
]);

export const rolloverEnum = pgEnum("rollover_behavior", [
  "next_cycle",
  "backlog",
]);

// hosted plans (PLAN-059). Only read when BILLING=on; self-host (BILLING=off,
// the default) is always self_host_unlimited regardless of this column.
export const workspacePlanEnum = pgEnum("workspace_plan", [
  "free",
  "team",
  "self_host_unlimited",
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // declared email domains for SSO JIT workspace matching (R17)
  allowedDomains: text("allowed_domains").array(),
  // soft delete: set when an owner schedules deletion; the purge job hard
  // deletes every tenant row once purge_after passes (restore clears both)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  plan: workspacePlanEnum("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    avatarUrl: text("avatar_url"),
    // NULL = address not yet proven. Defaults to now() because most paths
    // that create users already prove the address (SSO with a verified
    // email, the bootstrap operator); the password paths that cannot
    // (invite claim) set it to NULL explicitly and mail a verify link.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // global identity: index predicate must match the R15a lookup predicate
  // exactly — lower() alone does not trim, so whitespace variants would
  // evade the constraint
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(btrim(${t.email}))`),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    harness: text("harness").notNull(),
    endpointUrl: text("endpoint_url"),
    endpointSecret: text("endpoint_secret"),
    capabilities: jsonb("capabilities").$type<string[]>().default([]).notNull(),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    // U20: inbox items (mentions, answered questions) at or before this
    // instant are acknowledged; the mark only moves forward
    inboxAckedAt: timestamp("inbox_acked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique().on(t.workspaceId, t.name), index().on(t.workspaceId)],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    nextIssueNumber: integer("next_issue_number").notNull().default(1),
    rolloverBehavior: rolloverEnum("rollover_behavior")
      .notNull()
      .default("next_cycle"),
    // weekly auto-schedule (services/cycle-schedule.ts); off until a team opts in
    cycleAutoEnabled: boolean("cycle_auto_enabled").notNull().default(false),
    cycleLengthDays: integer("cycle_length_days").notNull().default(7),
    // 0 = Sunday .. 6 = Saturday; default Monday
    cycleStartWeekday: integer("cycle_start_weekday").notNull().default(1),
    cycleUpcomingCount: integer("cycle_upcoming_count").notNull().default(2),
    // IANA zone the cycle boundaries are computed in; null means UTC
    timezone: text("timezone"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique().on(t.workspaceId, t.key), index().on(t.workspaceId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    teamId: uuid("team_id").references(() => teams.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("planned"),
    // https URL of the project's logo, stored once (explicit, or auto-filled from
    // a bound GitHub repo's owner avatar); null = clients show a fallback
    iconUrl: text("icon_url"),
    // startDate/targetDate are the roadmap span; either may be null — an
    // open project renders from createdAt to "now" (open-ended)
    startDate: timestamp("start_date", { withTimezone: true }),
    targetDate: timestamp("target_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId)],
);

// Dated health notes on a project (U14). Drafted from the event log (KTD9),
// edited and posted by a human or an agent; agent-authored rows say so.
export const projectUpdateHealth = ["on_track", "at_risk", "off_track"] as const;
export type ProjectUpdateHealth = (typeof projectUpdateHealth)[number];

export const projectUpdates = pgTable(
  "project_updates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    health: text("health", { enum: projectUpdateHealth }).notNull(),
    body: text("body").notNull(),
    authorType: actorTypeEnum("author_type").notNull(),
    authorId: uuid("author_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.projectId, t.createdAt)],
);

// Date markers on a project's roadmap span — undated milestones are
// checklist items that never render on the axis. Cascade on project delete.
// Issues link through issues.milestone_id (U16); progress counts linked issues.
export const projectMilestones = pgTable(
  "project_milestones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    targetDate: timestamp("target_date", { withTimezone: true }),
    sortOrder: real("sort_order").notNull().default(0),
    done: boolean("done").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index().on(t.workspaceId),
    index().on(t.projectId),
    unique().on(t.projectId, t.title),
  ],
);

export const cycles = pgTable(
  "cycles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    name: text("name"),
    number: integer("number").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index().on(t.workspaceId, t.teamId),
    // "one active cycle per team" is a hard invariant — the partial unique
    // index backstops the application-level deactivate-others logic.
    uniqueIndex("cycles_one_active_per_team")
      .on(t.teamId)
      .where(sql`${t.isActive}`),
  ],
);

// Velocity snapshot per completed cycle — written by completeCycle (manual
// or boundary sweep) so Insights queries never have to reconstruct it from
// the event log.
export const cycleVelocity = pgTable(
  "cycle_velocity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    cycleId: uuid("cycle_id")
      .notNull()
      .references(() => cycles.id),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    issueCount: integer("issue_count").notNull(),
    doneCount: integer("done_count").notNull(),
    estimateDone: integer("estimate_done").notNull().default(0),
    estimateTotal: integer("estimate_total").notNull().default(0),
  },
  (t) => [
    index().on(t.workspaceId, t.teamId),
    uniqueIndex("cycle_velocity_cycle_unique").on(t.cycleId),
  ],
);

export const labels = pgTable(
  "labels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    teamId: uuid("team_id").references(() => teams.id),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    key: text("key").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    state: issueStateEnum("state").notNull().default("backlog"),
    priority: priorityEnum("priority").notNull().default("none"),
    estimate: integer("estimate"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    assigneeType: assigneeTypeEnum("assignee_type"),
    assigneeId: uuid("assignee_id"),
    delegateType: actorTypeEnum("delegate_type"),
    delegateId: uuid("delegate_id"),
    creatorType: actorTypeEnum("creator_type").notNull().default("human"),
    creatorId: uuid("creator_id"),
    projectId: uuid("project_id").references(() => projects.id),
    // deleting a milestone keeps its issues (U16)
    milestoneId: uuid("milestone_id").references(() => projectMilestones.id, {
      onDelete: "set null",
    }),
    cycleId: uuid("cycle_id").references(() => cycles.id),
    parentId: uuid("parent_id"),
    source: issueSourceEnum("source").notNull().default("web"),
    externalRef: jsonb("external_ref").$type<Record<string, unknown>>(),
    // automated intake (§ plan 2026-10-16): provider fingerprint groups repeated
    // reports into one issue; occurrenceCount bumps instead of new issues.
    intakeFingerprint: text("intake_fingerprint"),
    triageSuggestion: jsonb("triage_suggestion").$type<{
      action: "accept" | "decline";
      reason: string;
      model?: string;
      at: string;
    }>(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    sortOrder: real("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique().on(t.workspaceId, t.key),
    index().on(t.workspaceId, t.state),
    index().on(t.workspaceId, t.teamId),
    index().on(t.workspaceId, t.cycleId),
    index().on(t.workspaceId, t.assigneeId),
    index().on(t.milestoneId),
    index().on(t.workspaceId, t.delegateId),
    index("issues_intake_fingerprint_index")
      .on(t.workspaceId, t.intakeFingerprint)
      .where(sql`${t.intakeFingerprint} is not null`),
  ],
);

// One row per automated-intake delivery (GlitchTip, GitHub, help/bug reports).
// externalId gives provider delivery idempotency; fingerprint groups repeated
// errors onto the same issue. status records what the pipe did with it.
export const intakeEvents = pgTable(
  "intake_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id"),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    fingerprint: text("fingerprint"),
    issueId: uuid("issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    status: text("status", {
      enum: ["accepted", "deduped", "duplicate_delivery", "failed"],
    })
      .notNull()
      .default("accepted"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
  },
  (t) => [
    index().on(t.workspaceId, t.issueId),
    uniqueIndex("intake_events_delivery_unique")
      .on(t.workspaceId, t.provider, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.userId)],
);

export const agentKeys = pgTable(
  "agent_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["read"]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.agentId), index().on(t.workspaceId)],
);

export const issueLabels = pgTable(
  "issue_labels",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [unique().on(t.issueId, t.labelId)],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id"),
    body: text("body").notNull(),
    // sync provenance: 'github' marks comments created by inbound sync so
    // the outbound mirror never echoes them back to GitHub (#60)
    via: text("via"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId, t.issueId)],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index().on(t.workspaceId, t.entityType, t.entityId),
    index().on(t.workspaceId, t.createdAt),
  ],
);

export const userTokens = pgTable(
  "user_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["read"]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.userId), index().on(t.workspaceId)],
);

// RFC 8628 device authorization: a CLI (or any headless client) shows a short
// code, a signed-in human approves it in the browser, and the client's next
// poll receives a personal access token. Only hashes of the device code are
// stored; the token itself is minted at the moment of the one successful poll,
// so no credential ever sits in this table.
export const deviceAuthorizations = pgTable(
  "device_authorizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    /** normalized (no dash, upper case) */
    userCode: text("user_code").notNull(),
    clientName: text("client_name").notNull(),
    /** where the request came from, shown to the approver */
    requestIp: text("request_ip"),
    /** pending | approved | denied | consumed */
    status: text("status").notNull().default("pending"),
    intervalS: integer("interval_s").notNull().default(5),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    // named so it is not mistaken for a tenant-owned row: it only records
    // which workspace the approver chose, and goes away with that workspace
    approvedWorkspaceId: uuid("approved_workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["read", "write"]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.userCode), index().on(t.expiresAt)],
);

// Idempotency-Key replay store for mutating issue and comment routes (offline
// clients retry writes after a dropped connection). Scoped to one principal in
// one workspace; holds the first successful response so a retry returns it
// instead of writing twice. Entries older than a day are swept.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** "<workspace id>|<principal>" so a key never crosses callers or tenants */
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    /** sha256 of method, path and body: a reused key with a different request is refused */
    fingerprint: text("fingerprint").notNull(),
    /** in_progress | done */
    state: text("state").notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex().on(t.scope, t.key), index().on(t.createdAt)],
);

// The workspace's AI provider: where agent actions send their model calls.
// One row per workspace. The API key (OpenRouter key, or whatever an
// OpenAI-compatible endpoint wants) is sealed with AUTH_SECRET_KEY and never
// returned, logged or put in an event.
export const aiProviders = pgTable(
  "ai_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** openrouter | openai_compatible */
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    apiKeyEnc: text("api_key_enc"),
    /** monthly spend ceiling in US cents; null = no ceiling */
    monthlyCapCents: integer("monthly_cap_cents"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex().on(t.workspaceId)],
);

// One row per model call made through the provider seam, so spend caps and the
// Settings -> AI usage view read the same numbers. Money is micro-dollars
// (1e-6 USD) to avoid float drift; zero when the endpoint doesn't report cost.
export const aiUsageLedger = pgTable(
  "ai_usage_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** what asked: test, summarize, triage... */
    action: text("action").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    /** ok | error */
    status: text("status").notNull().default("ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

export const views = pgTable(
  "views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
    shared: boolean("shared").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .unique(),
    accountLogin: text("account_login").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const githubRepos = pgTable(
  "github_repos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    installationId: bigint("installation_id", { mode: "number" }),
    repoId: bigint("repo_id", { mode: "number" }),
    fullName: text("full_name").notNull(),
    teamId: uuid("team_id").references(() => teams.id),
    // repo-to-project binding (U12): issues synced from this repo land here.
    // set null if the project is deleted so intake never dangles
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique().on(t.workspaceId, t.fullName), index().on(t.workspaceId)],
);

// durable delivery log — unique delivery_id is the dedupe/replay guard
export const githubWebhookEvents = pgTable(
  "github_webhook_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deliveryId: text("delivery_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    // null once the retention sweep cleared it (services/retention.ts); the
    // row stays so delivery_id dedupe keeps working
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index().on(t.eventType), index().on(t.receivedAt)],
);

// GitHub issue ↔ tallyline issue map — intake dedupe + bidirectional sync (#60)
export const githubIssueLinks = pgTable(
  "github_issue_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => githubRepos.id, { onDelete: "cascade" }),
    ghIssueId: bigint("gh_issue_id", { mode: "number" }).notNull(),
    ghIssueNumber: integer("gh_issue_number").notNull(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    // last-known GitHub issue state ('open' | 'closed'); null = unknown.
    // lets the outbound mirror skip no-op PATCHes (#60)
    ghState: text("gh_state"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique().on(t.repoId, t.ghIssueId),
    index().on(t.workspaceId),
    index().on(t.issueId),
  ],
);

export const dispatchTriggerEnum = pgEnum("dispatch_trigger", [
  "assign",
  "mention",
]);

export const dispatchStatusEnum = pgEnum("dispatch_status", [
  "queued",
  "claimed",
  "dispatch_failed",
  "completed",
  "canceled",
]);

// durable dispatch records — every intent lands here, never silent
export const dispatches = pgTable(
  "dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    trigger: dispatchTriggerEnum("trigger").notNull(),
    status: dispatchStatusEnum("status").notNull().default("queued"),
    adapter: text("adapter"),
    reason: text("reason"),
    commentBody: text("comment_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId, t.issueId)],
);

// append-only session log — an agent's structured progress events inside
// one dispatch (reading → implementing → testing → pr); replayable forever
export const dispatchEventKinds = [
  "reading",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "pr",
  "note",
  "error",
] as const;

export const dispatchEvents = pgTable(
  "dispatch_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dispatchId: uuid("dispatch_id")
      .notNull()
      .references(() => dispatches.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind", { enum: dispatchEventKinds }).notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.dispatchId), index().on(t.workspaceId)],
);

// ── Agent sessions (plan L1) ─────────────────────────────────────
// One session per dispatch. Status values mirror Linear's AgentSession so
// adapters written against either map one-to-one. A session is `pending`
// until the agent's first activity; the sweeper marks it `stale` when no
// activity arrives inside the ack window, or when an active session goes
// quiet past the idle window.
export const agentSessionStatuses = [
  "pending",
  "active",
  "awaitingInput",
  "complete",
  "error",
  "stale",
  "stopping",
] as const;
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    dispatchId: uuid("dispatch_id")
      .notNull()
      .references(() => dispatches.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: text("status", { enum: agentSessionStatuses })
      .notNull()
      .default("pending"),
    plan: jsonb("plan").$type<Record<string, unknown>>(),
    pullRequests: jsonb("pull_requests").$type<string[]>().default([]).notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique().on(t.dispatchId),
    index().on(t.workspaceId, t.issueId),
    index().on(t.workspaceId, t.status),
    // sweeper scans by status across workspaces
    index().on(t.status, t.createdAt),
    index().on(t.status, t.lastActivityAt),
  ],
);

// Typed activity log inside a session. `ephemeral` rows are replaced by the
// next ephemeral row (progress text that should not pile up). `signal`
// carries out-of-band control such as `stop`.
export const agentActivityTypes = [
  "thought",
  "action",
  "elicitation",
  "response",
  "error",
  "prompt",
] as const;
export type AgentActivityType = (typeof agentActivityTypes)[number];

export const agentActivities = pgTable(
  "agent_activities",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    type: text("type", { enum: agentActivityTypes }).notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    ephemeral: boolean("ephemeral").default(false).notNull(),
    signal: text("signal"),
    actorType: actorTypeEnum("actor_type").default("agent").notNull(),
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.sessionId), index().on(t.workspaceId)],
);

// One GlitchTip alert-webhook integration per workspace. The URL secret is
// only ever stored as a sha256 hash (plus its last four characters for the
// UI); projectMap keys are lowercased GlitchTip project names -> team keys.
export const glitchtipIntegrations = pgTable("glitchtip_integrations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  tokenLast4: text("token_last4").notNull(),
  glitchtipHost: text("glitchtip_host"),
  projectMap: jsonb("project_map")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  defaultTeamKey: text("default_team_key"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
});

// outbound webhook endpoints — consumers subscribe to issue.*/dispatch.* actions
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default(["*"]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    endpointId: uuid("endpoint_id").references(() => webhookEndpoints.id, {
      onDelete: "cascade",
    }),
    // agent-dispatch deliveries have no endpoint row — the agent's
    // endpointUrl/endpointSecret are resolved at each attempt
    dispatchId: uuid("dispatch_id").references(() => dispatches.id, {
      onDelete: "cascade",
    }),
    action: text("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.status, t.nextAttemptAt), index().on(t.endpointId)],
);

// inbox rows for humans — materialized at write time (assign, @mention,
// review-pending, dispatch failure); agents never get rows here
export const notificationKinds = [
  "assigned",
  "mention",
  "review_pending",
  "dispatch_failed",
] as const;

export const notifications = pgTable(
  "notifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: notificationKinds }).notNull(),
    issueId: uuid("issue_id").references(() => issues.id, {
      onDelete: "cascade",
    }),
    // link back to the causal activity row when one exists
    eventId: bigint("event_id", { mode: "number" }).references(
      () => events.id,
    ),
    actorType: actorTypeEnum("actor_type").notNull().default("system"),
    actorId: uuid("actor_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index().on(t.workspaceId, t.userId),
    index().on(t.userId, t.readAt),
  ],
);

// external system refs on issues — importer dedupe + provenance (linear, etc.)
export const issueExternalRefs = pgTable(
  "issue_external_refs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    system: text("system").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    // plan import: hash of the title and description it last wrote, so a
    // later run only overwrites text nobody has edited
    contentHash: text("content_hash"),
    // system data about the reference; for github_pr rows: repo, number,
    // title and state (draft, open, merged, closed)
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique().on(t.workspaceId, t.system, t.externalId),
    index().on(t.issueId),
  ],
);

// slack ↔ issue mirror bindings — one Slack thread per issue
export const slackLinks = pgTable(
  "slack_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    issueId: uuid("issue_id")
      .notNull()
      .unique()
      .references(() => issues.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    reporterSlackId: text("reporter_slack_id"),
    reporterName: text("reporter_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index().on(t.workspaceId),
    // one link per Slack thread — the claim that makes reaction intake
    // idempotent under concurrent/retried event delivery
    unique().on(t.channel, t.threadTs),
  ],
);

// ── identity & membership ────────────────────────────────────────────────────

export const memberRoleEnum = pgEnum("member_role", [
  "owner",
  "admin",
  "member",
]);

export const inviteRoleEnum = pgEnum("invite_role", ["member", "admin"]);

export const providerTypeEnum = pgEnum("provider_type", [
  "github",
  "google",
  "oidc",
]);

export const oauthPurposeEnum = pgEnum("oauth_purpose", [
  "login",
  "pending-bootstrap",
  "pending-link",
]);

// humans in a workspace — agents are never members (KTD6/R24)
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique().on(t.workspaceId, t.userId), index().on(t.userId)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique().on(t.teamId, t.userId)],
);

// pluggable auth providers — workspace_id NULL = instance-scoped (v1);
// column kept nullable for future per-workspace providers, no FK cascade
export const authProviders = pgTable("auth_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id"),
  key: text("key").notNull().unique(),
  type: providerTypeEnum("type").notNull(),
  label: text("label").notNull(),
  clientId: text("client_id").notNull(),
  clientSecretEnc: text("client_secret_enc"),
  issuer: text("issuer"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  claimMap: jsonb("claim_map").$type<Record<string, string>>(),
  endpoints: jsonb("endpoints").$type<Record<string, string>>(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique().on(t.providerKey, t.providerSubject),
    index().on(t.userId),
  ],
);

// link-based invites (no mailer) — token_hash at rest, email NULL = open link
export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email"),
  tokenHash: text("token_hash").notNull().unique(),
  role: inviteRoleEnum("role").notNull().default("member"),
  teamId: uuid("team_id").references(() => teams.id),
  createdBy: uuid("created_by").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: uuid("accepted_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// api→web one-time handoff codes (KTD5) — pending states may precede the
// user row, so subject/email ride in context instead
export const oauthCodes = pgTable("oauth_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  purpose: oauthPurposeEnum("purpose").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id"),
  context: jsonb("context").$type<Record<string, unknown>>(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ── MCP OAuth authorization server (PLAN-011) ────────────────────────────
// Clients are public (PKCE, no secret): either dynamically registered
// (RFC 7591, client_id = tly_cli_*) or a Client ID Metadata Document URL
// (https client_id, metadata cached here). redirect_uris is the exact-match
// allowlist for that client.
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: text("client_id").notNull().unique(),
  kind: text("kind").$type<"dcr" | "cimd">().notNull(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  clientUri: text("client_uri"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// pending authorization request, held between /oauth/authorize and the
// consent decision. The consent page only ever carries this row's id; every
// security-relevant parameter was validated at /oauth/authorize and is read
// back from here, never from the decision POST.
export const oauthRequests = pgTable("oauth_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  // minted when the consent page is viewed; the decision must come from the
  // same user and present the matching CSRF token
  csrfHash: text("csrf_hash"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// one grant = one user consenting one client into one workspace. The grant
// owns a connector agent row so writes carry agent provenance while the
// user stays accountable (user_id). Revoking the grant kills every token.
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    resource: text("resource").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.userId)],
);

// authorization codes, access tokens and refresh tokens — hashed at rest.
// kind='code' rows also carry the PKCE challenge + redirect_uri they were
// minted for. A refresh token is single-use (rotated): redeeming sets
// used_at; presenting a used one again revokes the whole grant.
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"code" | "access" | "refresh">().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge"),
    redirectUri: text("redirect_uri"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.grantId)],
);

// audit trail for the 0019 duplicate-email merge — snapshot keeps the full
// deleted row so a bad canonical pick is forensically reconstructible
export const userIdMap = pgTable("user_id_map", {
  oldUserId: uuid("old_user_id").primaryKey(),
  mergedIntoUserId: uuid("merged_into_user_id").notNull(),
  reason: text("reason").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// single-use, user-scoped account tokens (password reset, email verify).
// Only sha256(token) is stored; consuming sets used_at atomically.
export const accountTokenPurposeEnum = pgEnum("account_token_purpose", [
  "password_reset",
  "email_verify",
]);

export const accountTokens = pgTable(
  "account_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: accountTokenPurposeEnum("purpose").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    // the address the token was mailed to (verify binds to it)
    email: text("email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.userId, t.purpose)],
);

// security audit trail for account-level actions (reset, verify, export,
// deletion). user_id has no FK on purpose: the record of an account's
// deletion must outlive the account. Never stores email or names.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id"),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.userId, t.createdAt)],
);

export type IssueRow = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
export type EventRow = typeof events.$inferSelect;

// ── usage metering (PLAN-059) ─────────────────────────────────────────────
// One row per workspace per UTC day. seats/agents/storage are end-of-day
// snapshots written by rollupUsage(); agent_runs is the exact count of
// dispatches created that day; api_calls is added to by flushApiCalls()
// from cheap in-process counters. First-party aggregates only: no content,
// no per-person rows.
export const usageDaily = pgTable(
  "usage_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    seats: integer("seats").notNull().default(0),
    agents: integer("agents").notNull().default(0),
    agentRuns: integer("agent_runs").notNull().default(0),
    apiCalls: bigint("api_calls", { mode: "number" }).notNull().default(0),
    storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique().on(t.workspaceId, t.day)],
);
// ── Issue suggestions (plan L4) ──────────────────────────────────
export const issueSuggestionKinds = [
  "label",
  "project",
  "team",
  "assignee",
  "duplicate",
] as const;
export type IssueSuggestionKind = (typeof issueSuggestionKinds)[number];

export const issueSuggestionStates = [
  "pending",
  "accepted",
  "dismissed",
] as const;
export type IssueSuggestionState = (typeof issueSuggestionStates)[number];

export const issueSuggestions = pgTable(
  "issue_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: issueSuggestionKinds }).notNull(),
    suggestedValue: text("suggested_value").notNull(),
    reason: text("reason"),
    state: text("state", { enum: issueSuggestionStates })
      .notNull()
      .default("pending"),
    dismissedReason: text("dismissed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique().on(t.issueId, t.kind, t.suggestedValue),
    index().on(t.workspaceId, t.issueId),
  ],
);

// ── Issue relations (plan L5) ────────────────────────────────────
export const issueRelationTypes = [
  "blocks",
  "duplicate",
  "related",
  "similar",
] as const;
export type IssueRelationType = (typeof issueRelationTypes)[number];

export const issueRelations = pgTable(
  "issue_relations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    targetIssueId: uuid("target_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    relationType: text("relation_type", { enum: issueRelationTypes }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique().on(t.sourceIssueId, t.targetIssueId, t.relationType),
    index().on(t.workspaceId, t.sourceIssueId),
    index().on(t.workspaceId, t.targetIssueId),
  ],
);

// ── Loops / workflow definitions (plan L6) ───────────────────────
export const workflowTriggers = [
  "issue.transition",
  "schedule",
  "webhook",
  "pull_request",
] as const;
export type WorkflowTrigger = (typeof workflowTriggers)[number];

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    trigger: text("trigger", { enum: workflowTriggers }).notNull(),
    condition: jsonb("condition")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    action: jsonb("action")
      .$type<Record<string, unknown>>()
      .notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId, t.trigger)],
);


// A phone (or other native client) paired to one person in one workspace. The
// credential itself is an ordinary expiring PAT (user_tokens); this row is the
// device registry on top of it: a name to show, a platform, and a revoke handle.
// Deleting or letting the token lapse leaves the row as history (token_id NULL).
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform", { enum: ["ios", "android", "other"] }).notNull().default("other"),
    tokenId: uuid("token_id").references(() => userTokens.id, { onDelete: "set null" }),
    // the token just replaced by a rotation, kept alive for a short grace window
    // so a lost response can't lock the phone out; revoking kills both
    prevTokenId: uuid("prev_token_id").references(() => userTokens.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index().on(t.workspaceId, t.userId), index().on(t.tokenId)],
);

// One-time codes that turn a signed-in browser session into a paired device
// (scanned as a QR code). Only the hash is stored; a code is good for five
// minutes and exactly one redemption.
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index().on(t.userId), index().on(t.expiresAt)],
);
