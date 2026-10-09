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
]);

export const rolloverEnum = pgEnum("rollover_behavior", [
  "next_cycle",
  "backlog",
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique().on(t.workspaceId, t.email), index().on(t.workspaceId)],
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index().on(t.workspaceId)],
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
    creatorType: actorTypeEnum("creator_type").notNull().default("human"),
    creatorId: uuid("creator_id"),
    projectId: uuid("project_id").references(() => projects.id),
    cycleId: uuid("cycle_id").references(() => cycles.id),
    parentId: uuid("parent_id"),
    source: issueSourceEnum("source").notNull().default("web"),
    externalRef: jsonb("external_ref").$type<Record<string, unknown>>(),
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
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index().on(t.eventType)],
);

// GitHub issue ↔ docketry issue map — intake dedupe + bidirectional sync (#60)
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique().on(t.workspaceId, t.system, t.externalId),
    index().on(t.issueId),
  ],
);

export type IssueRow = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;
export type EventRow = typeof events.$inferSelect;
