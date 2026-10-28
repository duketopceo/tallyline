import { z } from "zod";
import {
  agentActivityContentSchema,
  agentSignals,
  ISSUE_SOURCES,
  ISSUE_STATES,
  PRIORITIES,
  type AgentActivityContent,
  type IssueState,
  type Priority,
} from "@tallyline/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, TallylineClient } from "./client.js";

// ── API row shapes (only the fields tools read) ──────────────────────

interface IssueRow {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string | null;
  state: IssueState;
  priority: Priority;
  estimate: number | null;
  dueDate: string | null;
  assigneeType: "human" | "agent" | null;
  assigneeId: string | null;
  creatorType: string;
  creatorId: string | null;
  projectId: string | null;
  milestoneId?: string | null;
  cycleId: string | null;
  parentId: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  children?: { id: string; key: string; title: string }[];
  labels?: { id: string; name: string; color: string }[];
}

interface CommentRow {
  id: string;
  actorType: string;
  actorId: string | null;
  body: string;
  createdAt: string;
}

interface AgentRow {
  id: string;
  name: string;
  harness: string;
  capabilities: string[];
  skills?: string[];
}

interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
}

interface TeamRow {
  id: string;
  key: string;
  name: string;
  nextIssueNumber: number;
}

interface LabelRow {
  id: string;
  name: string;
  color: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  teamId: string | null;
}

interface ProjectFull extends ProjectRow {
  startDate: string | null;
  targetDate: string | null;
}

interface CycleRow {
  id: string;
  name: string | null;
  number: number;
  teamId: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

interface FeedEvent {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  issueKey: string | null;
  issueTitle: string | null;
  after: unknown;
  createdAt: string;
}

interface AgentSessionRow {
  id: string;
  workspaceId: string;
  dispatchId: string;
  issueId: string;
  agentId: string;
  status: string;
  plan: Record<string, unknown> | null;
  pullRequests: string[];
  lastActivityAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentActivityRow {
  id: number;
  sessionId: string;
  workspaceId: string;
  type: AgentActivityContent["type"];
  content: Record<string, unknown>;
  ephemeral: boolean;
  signal: string | null;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

// ── Slim views — tool outputs stay agent-token-friendly ──────────────

function slimIssue(i: IssueRow) {
  return {
    key: i.key,
    title: i.title,
    state: i.state,
    priority: i.priority,
    assigneeType: i.assigneeType,
    assigneeId: i.assigneeId,
    dueDate: i.dueDate,
    milestoneId: i.milestoneId ?? null,
    updatedAt: i.updatedAt,
  };
}

function fullIssue(i: IssueRow) {
  return {
    ...slimIssue(i),
    number: i.number,
    description: i.description,
    estimate: i.estimate,
    creatorType: i.creatorType,
    source: i.source,
    projectId: i.projectId,
    cycleId: i.cycleId,
    parentId: i.parentId,
    labels: (i.labels ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
    })),
    children: (i.children ?? []).map((ch) => ({ key: ch.key, title: ch.title })),
    createdAt: i.createdAt,
  };
}

function slimComment(c: CommentRow) {
  return {
    id: c.id,
    actorType: c.actorType,
    actorId: c.actorId,
    body: c.body,
    createdAt: c.createdAt,
  };
}

const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "started",
  "paused",
  "completed",
  "canceled",
] as const;

function slimProject(p: ProjectFull) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    teamId: p.teamId,
    startDate: p.startDate,
    targetDate: p.targetDate,
  };
}

// Import resolves its project by exact name, so two projects with one name
// make an import ambiguous. The API doesn't enforce it; the tools do.
async function assertProjectNameFree(
  client: TallylineClient,
  name: string,
  exceptId?: string,
): Promise<void> {
  const { projects } = await client.apiGet<{ projects: ProjectRow[] }>(
    "/projects",
  );
  const want = name.trim().toLowerCase();
  const clash = projects.find(
    (p) => p.id !== exceptId && p.name.trim().toLowerCase() === want,
  );
  if (clash) {
    throw new ToolError(
      "DUPLICATE_NAME",
      `a project named '${clash.name}' already exists (id ${clash.id})`,
    );
  }
}

// ── Errors ───────────────────────────────────────────────────────────

/** A client-side tool failure that maps onto the API's error envelope. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

function errorResult(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code, message }, ...extra }),
      },
    ],
  };
}

function okResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

// ── Tool definition plumbing ─────────────────────────────────────────

type ZodShape = Record<string, z.ZodType>;

type ArgsOf<S extends ZodShape> = { [K in keyof S]: z.infer<S[K]> };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ZodShape;
  readOnly?: boolean;
  /** Validates raw args against inputSchema, then invokes the handler. */
  call: (
    rawArgs: unknown,
    client: TallylineClient,
  ) => Promise<Record<string, unknown>>;
}

function defineTool<S extends ZodShape>(def: {
  name: string;
  description: string;
  inputSchema: S;
  readOnly?: boolean;
  handler: (args: ArgsOf<S>, client: TallylineClient) => Promise<Record<string, unknown>>;
}): ToolDef {
  const schema = z.object(def.inputSchema);
  return {
    ...def,
    call: (rawArgs, client) =>
      def.handler(schema.parse(rawArgs) as ArgsOf<S>, client),
  };
}

/**
 * Runs one tool handler: parses args against the input schema (same as the
 * SDK does at the protocol layer), maps API/local errors onto the
 * `{error:{code,message}}` envelope. Never throws — a tool error is a
 * result, not a server crash.
 */
export async function executeTool(
  def: ToolDef,
  args: unknown,
  client: TallylineClient,
): Promise<CallToolResult> {
  try {
    return okResult(await def.call(args, client));
  } catch (err) {
    if (err instanceof ApiError) {
      // a stale import carries the fresh diff to review before applying again
      const diff =
        err.code === "STALE_DIFF"
          ? (err.details as { diff?: unknown } | undefined)?.diff
          : undefined;
      return errorResult(
        err.code,
        err.message,
        diff === undefined ? undefined : { diff },
      );
    }
    if (err instanceof ToolError) {
      return errorResult(err.code, err.message);
    }
    if (err instanceof z.ZodError) {
      return errorResult("BAD_INPUT", z.prettifyError(err));
    }
    return errorResult(
      "INTERNAL",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Tools ────────────────────────────────────────────────────────────

const uuid = z.uuid();

const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export const toolDefs: ToolDef[] = [
  defineTool({
    name: "whoami",
    description:
      "Resolve the configured credential to an identity — type (agent|human), id, name, scopes. Agents use this to find their assignee id.",
    inputSchema: {},
    readOnly: true,
    handler: async (_args, client) => ({ ...(await client.whoami()) }),
  }),

  defineTool({
    name: "list_issues",
    description:
      "List issues in the workspace. Filters: state/priority (arrays), team key, assignee id, cycle id, milestone id, label id (the `hitl` label marks work only Luke can do; find its id with list_labels), source, text search over title, description, key and comments. Cursor-paginated.",
    inputSchema: {
      state: z.array(z.enum(ISSUE_STATES)).optional(),
      priority: z.array(z.enum(PRIORITIES)).optional(),
      team: z.string().optional(),
      assignee: uuid.optional(),
      cycle: uuid.optional(),
      milestone: uuid.optional(),
      label: uuid.optional(),
      source: z.enum(ISSUE_SOURCES).optional(),
      search: z.string().max(200).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    readOnly: true,
    handler: async (args, client) => {
      const res = await client.apiGet<{
        issues: IssueRow[];
        nextCursor: string | null;
      }>("/issues", {
        state: args.state?.join(","),
        priority: args.priority?.join(","),
        team: args.team,
        assignee: args.assignee,
        cycle: args.cycle,
        milestone: args.milestone,
        label: args.label,
        source: args.source,
        search: args.search,
        cursor: args.cursor,
        limit: args.limit,
      });
      return {
        issues: res.issues.map(slimIssue),
        nextCursor: res.nextCursor,
      };
    },
  }),

  defineTool({
    name: "ready",
    description:
      "List issues ready to work — state 'todo', ordered by priority (urgent first, then oldest). `mine` restricts to issues assigned to you.",
    inputSchema: {
      mine: z.boolean().optional(),
      team: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    readOnly: true,
    handler: async (args, client) => {
      const assignee = args.mine ? (await client.whoami()).id : undefined;
      const res = await client.apiGet<{
        issues: IssueRow[];
        nextCursor: string | null;
      }>("/issues", {
        state: "todo",
        team: args.team,
        assignee,
        limit: 200,
      });
      const ordered = res.issues
        .slice()
        .sort(
          (a, b) =>
            PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
            Date.parse(a.createdAt) - Date.parse(b.createdAt),
        )
        .slice(0, args.limit ?? 20);
      return { issues: ordered.map(slimIssue) };
    },
  }),

  defineTool({
    name: "get_issue",
    description:
      "Fetch one issue by key (e.g. ENG-1) — full view including labels and child keys. Set includeComments to append the comment thread.",
    inputSchema: {
      key: z.string(),
      includeComments: z.boolean().optional(),
    },
    readOnly: true,
    handler: async (args, client) => {
      const issue = await client.apiGet<IssueRow>(
        `/issues/${encodeURIComponent(args.key)}`,
      );
      const out: Record<string, unknown> = fullIssue(issue);
      if (args.includeComments) {
        const res = await client.apiGet<{ comments: CommentRow[] }>(
          `/issues/${encodeURIComponent(args.key)}/comments`,
        );
        out.comments = res.comments.map(slimComment);
      }
      return out;
    },
  }),

  defineTool({
    name: "create_issue",
    description:
      "Create an issue. State may be 'triage' or 'backlog' (default backlog). teamKey picks the team (defaults to the workspace's first). To assign, pass assigneeType AND assigneeId together.",
    inputSchema: {
      title: z.string().min(1).max(500),
      description: z.string().max(50_000).optional(),
      state: z.enum(["triage", "backlog"]).optional(),
      priority: z.enum(PRIORITIES).optional(),
      teamKey: z.string().min(1).max(6).optional(),
      assigneeType: z.enum(["human", "agent"]).optional(),
      assigneeId: uuid.optional(),
      labelIds: z.array(uuid).max(10).optional(),
      projectId: uuid.optional(),
      milestoneId: uuid.optional(),
      cycleId: uuid.optional(),
      parentId: uuid.optional(),
    },
    handler: async (args, client) => {
      if (args.assigneeId !== undefined && args.assigneeType === undefined) {
        throw new ToolError(
          "BAD_INPUT",
          "assigneeType is required when assigneeId is set",
        );
      }
      const issue = await client.apiPost<IssueRow>("/issues", {
        title: args.title,
        description: args.description,
        state: args.state,
        priority: args.priority,
        teamKey: args.teamKey,
        assigneeType: args.assigneeType,
        assigneeId: args.assigneeId,
        labelIds: args.labelIds,
        projectId: args.projectId,
        milestoneId: args.milestoneId,
        cycleId: args.cycleId,
        parentId: args.parentId,
        // agent-authored issues are marked with provenance source 'api'
        source: "api",
      });
      return slimIssue(issue);
    },
  }),

  defineTool({
    name: "update_issue",
    description:
      "Patch an issue by key — title, description, state (state machine enforced), priority, estimate, dueDate, assignee, cycle, project, milestone (must belong to the issue's project), parent. Pass null to clear nullable fields.",
    inputSchema: {
      key: z.string(),
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(50_000).nullable().optional(),
      state: z.enum(ISSUE_STATES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      estimate: z.number().int().nonnegative().nullable().optional(),
      dueDate: z.iso.datetime().nullable().optional(),
      assigneeType: z.enum(["human", "agent"]).nullable().optional(),
      assigneeId: uuid.nullable().optional(),
      cycleId: uuid.nullable().optional(),
      projectId: uuid.nullable().optional(),
      milestoneId: uuid.nullable().optional(),
      parentId: uuid.nullable().optional(),
    },
    handler: async (args, client) => {
      const { key, ...fields } = args;
      if (args.assigneeId && args.assigneeType === undefined) {
        throw new ToolError(
          "BAD_INPUT",
          "assigneeType is required when assigning (assigneeId set)",
        );
      }
      const issue = await client.apiPatch<IssueRow>(
        `/issues/${encodeURIComponent(key)}`,
        fields,
      );
      return slimIssue(issue);
    },
  }),

  defineTool({
    name: "triage_issue",
    description:
      "Accept (→ backlog) or decline (→ canceled) an issue sitting in 'triage'. Only valid while the issue is in triage.",
    inputSchema: {
      key: z.string(),
      action: z.enum(["accept", "decline"]),
    },
    handler: async (args, client) => {
      const issue = await client.apiPost<IssueRow>(
        `/issues/${encodeURIComponent(args.key)}/triage`,
        { action: args.action },
      );
      return slimIssue(issue);
    },
  }),

  defineTool({
    name: "comment",
    description:
      "Add a comment to an issue by key. Authored as the credential's identity — agent keys post as the agent.",
    inputSchema: {
      key: z.string(),
      body: z.string().min(1).max(50_000),
    },
    handler: async (args, client) => {
      const comment = await client.apiPost<CommentRow>(
        `/issues/${encodeURIComponent(args.key)}/comments`,
        { body: args.body },
      );
      return { issueKey: args.key, ...slimComment(comment) };
    },
  }),

  defineTool({
    name: "claim",
    description:
      "Claim an issue for yourself — assigns it to the credential's identity and moves it to 'in_progress' (hops via 'todo' from 'backlog'). Issues in 'triage' must be accepted via triage_issue first; terminal issues cannot be claimed.",
    inputSchema: { key: z.string() },
    handler: async (args, client) => {
      const key = encodeURIComponent(args.key);
      const [issue, me] = await Promise.all([
        client.apiGet<IssueRow>(`/issues/${key}`),
        client.whoami(),
      ]);

      const hops: Partial<Record<IssueState, IssueState[]>> = {
        backlog: ["todo", "in_progress"],
        todo: ["in_progress"],
        in_progress: [],
        // sending a review item back is a human decision (PLAN-056); the API
        // refuses it for agent credentials, so do not offer the hop to them
        ...(me.type === "agent" ? {} : { in_review: ["in_progress"] as IssueState[] }),
      };
      const path = hops[issue.state];
      if (path === undefined) {
        throw new ToolError(
          "INVALID_STATE",
          issue.state === "triage"
            ? `${issue.key} is in triage — accept it with triage_issue before claiming`
            : `cannot claim ${issue.key} from state '${issue.state}'`,
        );
      }

      const assignee = { assigneeType: me.type, assigneeId: me.id };
      let updated: IssueRow;
      if (path.length === 0) {
        updated = await client.apiPatch<IssueRow>(`/issues/${key}`, assignee);
      } else {
        updated = await client.apiPatch<IssueRow>(`/issues/${key}`, {
          ...assignee,
          state: path[0]!,
        });
        for (const state of path.slice(1)) {
          updated = await client.apiPatch<IssueRow>(`/issues/${key}`, {
            state,
          });
        }
      }
      return { ...slimIssue(updated), claimedBy: me.name };
    },
  }),

  defineTool({
    name: "list_agents",
    description: "List registered agent identities in the workspace.",
    inputSchema: {
      skill: z.string().optional(),
    },
    readOnly: true,
    handler: async (args, client) => {
      const res = await client.apiGet<{ agents: AgentRow[] }>(
        "/agents",
        args.skill ? { skill: args.skill } : undefined,
      );
      return {
        agents: res.agents.map((a) => ({
          id: a.id,
          name: a.name,
          harness: a.harness,
          capabilities: a.capabilities,
          skills: a.skills ?? [],
        })),
      };
    },
  }),

  defineTool({
    name: "list_teams",
    description: "List teams in the workspace (key, name).",
    inputSchema: {},
    readOnly: true,
    handler: async (_args, client) => {
      const res = await client.apiGet<{ teams: TeamRow[] }>("/teams");
      return {
        teams: res.teams.map((t) => ({
          id: t.id,
          key: t.key,
          name: t.name,
        })),
      };
    },
  }),

  defineTool({
    name: "list_members",
    description:
      "List human members of the workspace (name, email, role) — assignee resolution for issues.",
    inputSchema: {},
    readOnly: true,
    handler: async (_args, client) => {
      const res = await client.apiGet<{ members: MemberRow[] }>("/members");
      return {
        members: res.members.map((m) => ({
          id: m.id,
          userId: m.userId,
          name: m.name,
          email: m.email,
          role: m.role,
        })),
      };
    },
  }),

  defineTool({
    name: "list_labels",
    description: "List issue labels in the workspace (id, name, color).",
    inputSchema: {},
    readOnly: true,
    handler: async (_args, client) => {
      const res = await client.apiGet<{ labels: LabelRow[] }>("/labels");
      return {
        labels: res.labels.map((l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
        })),
      };
    },
  }),

  defineTool({
    name: "list_projects",
    description: "List projects in the workspace (id, name, status).",
    inputSchema: {},
    readOnly: true,
    handler: async (_args, client) => {
      const res = await client.apiGet<{ projects: ProjectRow[] }>("/projects");
      return {
        projects: res.projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          teamId: p.teamId,
        })),
      };
    },
  }),

  defineTool({
    name: "create_project",
    description:
      "Create a project. Names are unique (case-insensitive) because plan import finds its project by name; a duplicate is refused with DUPLICATE_NAME. teamKey ties it to a team.",
    inputSchema: {
      name: z.string().min(1).max(200),
      description: z.string().max(10_000).optional(),
      status: z.enum(PROJECT_STATUSES).optional(),
      teamKey: z.string().min(1).max(6).optional(),
      startDate: z.iso.datetime().optional(),
      targetDate: z.iso.datetime().optional(),
    },
    handler: async (args, client) => {
      await assertProjectNameFree(client, args.name);
      return slimProject(await client.apiPost<ProjectFull>("/projects", args));
    },
  }),

  defineTool({
    name: "update_project",
    description:
      "Patch a project by id: name (must stay unique), description, status, startDate, targetDate. Pass null to clear description or dates.",
    inputSchema: {
      id: uuid,
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(10_000).nullable().optional(),
      status: z.enum(PROJECT_STATUSES).optional(),
      startDate: z.iso.datetime().nullable().optional(),
      targetDate: z.iso.datetime().nullable().optional(),
    },
    handler: async (args, client) => {
      const { id, ...fields } = args;
      if (fields.name !== undefined) {
        await assertProjectNameFree(client, fields.name, id);
      }
      return slimProject(
        await client.apiPatch<ProjectFull>(
          `/projects/${encodeURIComponent(id)}`,
          fields,
        ),
      );
    },
  }),

  defineTool({
    name: "import_plan",
    description:
      "Import a ce-plan markdown file as issues in a project. mode defaults to 'dry_run': nothing is written and the result is a diff (counts, per-unit create/update/unchanged/ambiguous/invalid, warnings) plus a diffHash. Show the diff to the human. To write, call again with the same inputs, mode 'apply' and that diffHash; a diff that changed since returns STALE_DIFF with the new diff (review it, then apply with its hash). Fix 'ambiguous' units by passing resolutions {\"KP-U12\": \"TLY-34\"}. Needs write scope. Agents cannot write historical done/in-progress state, so there is no evidence input here.",
    inputSchema: {
      project: z.string().min(1).max(200),
      scope: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/),
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      path: z.string().min(1).max(300),
      sha: z.string().regex(/^[0-9a-f]{7,40}$/i),
      url: z.url().max(500).optional(),
      markdown: z.string().min(1).max(1_000_000),
      teamKey: z.string().min(1).max(8).optional(),
      resolutions: z.record(z.string(), z.string()).optional(),
      mode: z.enum(["dry_run", "apply"]).default("dry_run"),
      diffHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    },
    handler: (args, client) =>
      client.apiPost<Record<string, unknown>>("/import/plan", {
        project: args.project,
        teamKey: args.teamKey,
        plan: {
          scope: args.scope,
          source: {
            repo: args.repo,
            path: args.path,
            sha: args.sha,
            url: args.url,
          },
          markdown: args.markdown,
        },
        resolutions: args.resolutions,
        mode: args.mode,
        diffHash: args.diffHash,
      }),
  }),

  defineTool({
    name: "list_cycles",
    description:
      "List cycles in the workspace. Filter by team key, or `active` for the team's flagged current cycle.",
    inputSchema: {
      team: z.string().optional(),
      active: z.boolean().optional(),
    },
    readOnly: true,
    handler: async (args, client) => {
      const res = await client.apiGet<{ cycles: CycleRow[] }>("/cycles", {
        team: args.team,
        active: args.active,
      });
      return {
        cycles: res.cycles.map((c) => ({
          id: c.id,
          name: c.name,
          number: c.number,
          teamId: c.teamId,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          isActive: c.isActive,
        })),
      };
    },
  }),

  defineTool({
    name: "create_cycle",
    description:
      "Create a cycle for a team (a dated work window). Teams with the weekly auto-schedule on get cycles created for them; use this for a one-off or custom window. The new cycle is inactive unless isActive is true.",
    inputSchema: {
      teamKey: z.string().min(1).max(6),
      name: z.string().max(120).optional(),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      isActive: z.boolean().optional(),
    },
    handler: async (args, client) => {
      const c = await client.apiPost<CycleRow>("/cycles", args);
      return {
        id: c.id,
        name: c.name,
        number: c.number,
        teamId: c.teamId,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        isActive: c.isActive,
      };
    },
  }),

  defineTool({
    name: "assign_cycle",
    description:
      "Assign issues (by key) to a cycle, or pass cycleId null to take them out of their cycle. The cycle must belong to the issue's own team and workspace. Stops at the first refusal; keys before it stay assigned.",
    inputSchema: {
      keys: z.array(z.string()).min(1).max(50),
      cycleId: uuid.nullable(),
    },
    handler: async (args, client) => {
      const assigned: string[] = [];
      for (const key of args.keys) {
        await client.apiPatch<IssueRow>(`/issues/${encodeURIComponent(key)}`, {
          cycleId: args.cycleId,
        });
        assigned.push(key);
      }
      return { assigned, cycleId: args.cycleId };
    },
  }),

  defineTool({
    name: "list_events",
    description:
      "Workspace activity feed — newest first, cursor-paginated. Each event carries action, actor name, and the issue key/title it touched.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
    readOnly: true,
    handler: async (args, client) => {
      const res = await client.apiGet<{
        events: FeedEvent[];
        nextCursor: string | null;
      }>("/events", { limit: args.limit, cursor: args.cursor });
      return {
        events: res.events.map((e) => ({
          id: e.id,
          action: e.action,
          actorType: e.actorType,
          actorName: e.actorName,
          issueKey: e.issueKey,
          issueTitle: e.issueTitle,
          after: e.after,
          createdAt: e.createdAt,
        })),
        nextCursor: res.nextCursor,
      };
    },
  }),

  defineTool({
    name: "session_get",
    description:
      "Fetch an agent session by id along with its typed activity log.",
    inputSchema: {
      id: uuid,
    },
    readOnly: true,
    handler: async (args, client) => {
      const res = await client.apiGet<{
        session: AgentSessionRow;
        activities: AgentActivityRow[];
      }>(`/agent-sessions/${encodeURIComponent(args.id)}`);
      return {
        session: res.session,
        activities: res.activities,
      };
    },
  }),

  defineTool({
    name: "session_post_activity",
    description:
      "Post a typed activity (thought, action, elicitation, response, error, prompt) to an agent session. Agents use thought to acknowledge within 10s, elicitation to ask for input, and response with final=true to complete.",
    inputSchema: {
      id: uuid,
      content: agentActivityContentSchema,
      ephemeral: z.boolean().optional(),
      signal: z.enum(agentSignals).optional(),
    },
    handler: async (args, client) => {
      const res = await client.apiPost<{
        session: AgentSessionRow;
        activity: AgentActivityRow;
      }>(`/agent-sessions/${encodeURIComponent(args.id)}/activities`, {
        content: args.content,
        ...(args.ephemeral !== undefined ? { ephemeral: args.ephemeral } : {}),
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
      return {
        session: res.session,
        activity: res.activity,
      };
    },
  }),

  defineTool({
    name: "session_elicit",
    description:
      "Ask a human for input on an agent session — posts an 'elicitation' activity, transitions the session to 'awaitingInput', and mirrors the question onto the issue comment thread.",
    inputSchema: {
      id: uuid,
      body: z.string().min(1).max(4000),
    },
    handler: async (args, client) => {
      const res = await client.apiPost<{
        session: AgentSessionRow;
        activity: AgentActivityRow;
      }>(`/agent-sessions/${encodeURIComponent(args.id)}/activities`, {
        content: { type: "elicitation", body: args.body },
      });
      return {
        session: res.session,
        activity: res.activity,
      };
    },
  }),

  defineTool({
    name: "session_reply",
    description:
      "Reply to an agent session awaiting input — posts a 'prompt' activity and resumes the session to 'active'.",
    inputSchema: {
      id: uuid,
      body: z.string().min(1).max(4000),
    },
    handler: async (args, client) => {
      const res = await client.apiPost<{
        session: AgentSessionRow;
        activity: AgentActivityRow;
      }>(`/agent-sessions/${encodeURIComponent(args.id)}/activities`, {
        content: { type: "prompt", body: args.body },
      });
      return {
        session: res.session,
        activity: res.activity,
      };
    },
  }),
];

export const toolsByName = new Map(toolDefs.map((d) => [d.name, d]));

/** Invoke a tool by name — used by tests and the in-process path. */
export function runTool(
  name: string,
  args: Record<string, unknown>,
  client: TallylineClient,
): Promise<CallToolResult> {
  const def = toolsByName.get(name);
  if (!def) return Promise.resolve(errorResult("UNKNOWN_TOOL", `unknown tool '${name}'`));
  return executeTool(def, args, client);
}
