import type {
  IssueState,
  PlanImportDiff,
  PlanImportRequest,
  Priority,
} from "@tallyline/types";

// Minimal fetch contract — satisfied by globalThis.fetch and by Hono's
// app.fetch in tests (both accept a constructed Request; Hono may return
// a bare Response, so the union keeps both assignable).
export type FetchLike = (request: Request) => Response | Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** parsed error body, e.g. the fresh `diff` on a 409 STALE_DIFF */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Issue {
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
  teamId: string | null;
  cycleId: string | null;
  projectId: string | null;
  parentId: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueDetail extends Issue {
  children: { id: string; key: string; title: string }[];
  labels: { id: string; name: string; color: string }[];
}

export interface IssueList {
  issues: Issue[];
  nextCursor: string | null;
}

export interface Comment {
  id: string;
  workspaceId: string;
  issueId: string;
  actorType: string;
  actorId: string | null;
  body: string;
  createdAt: string;
}

export interface FeedEvent {
  id: string; // bigserial as string — never truncate to number in output
  entityType: string;
  entityId: string;
  action: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  issueKey: string | null;
  issueTitle: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface EventList {
  events: FeedEvent[];
  nextCursor: string | null;
}

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  harness: string;
  capabilities: string[];
  createdAt: string;
}

export interface Dispatch {
  id: string;
  status: string;
  trigger: string;
  adapter: string | null;
  reason: string | null;
  commentBody: string | null;
  agentId: string;
  agentName: string;
  issueId: string;
  issueKey: string;
  issueTitle: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEvent {
  id: number;
  dispatchId: string;
  kind: string;
  message: string;
  createdAt: string;
}

export interface Session {
  id: string;
  status: string;
  trigger: string;
  agentId: string;
  agentName: string;
  createdAt: string;
  events: SessionEvent[];
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

export interface Team {
  id: string;
  key: string;
  name: string;
}

export interface CreateIssueInput {
  title: string;
  teamKey?: string;
  description?: string;
  priority?: Priority;
  state?: "triage" | "backlog";
  assigneeType?: "human" | "agent";
  assigneeId?: string;
  parentId?: string;
}

export interface PatchIssueInput {
  title?: string;
  description?: string | null;
  state?: IssueState;
  priority?: Priority;
  assigneeType?: "human" | "agent" | null;
  assigneeId?: string | null;
}

interface ErrorPayload {
  error?: { code?: unknown; message?: unknown };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiClient {
  readonly apiUrl: string;
  readonly workspace: string;

  constructor(opts: {
    apiUrl: string;
    token: string;
    workspace: string;
    fetch: FetchLike;
  }) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.workspace = opts.workspace;
    this.token = opts.token;
    this.fetchImpl = opts.fetch;
  }

  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  private url(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(
      `${this.apiUrl}/v1/workspaces/${encodeURIComponent(this.workspace)}${path}`,
    );
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async req<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(
        new Request(this.url(path, opts.query), {
          method,
          headers,
          body: opts.body === undefined ? null : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(
        0,
        "NETWORK",
        `request to ${this.apiUrl} failed: ${msg}`,
      );
    }
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const payload = (data ?? {}) as ErrorPayload;
      const code =
        typeof payload.error?.code === "string"
          ? payload.error.code
          : "HTTP_ERROR";
      const base =
        typeof payload.error?.message === "string"
          ? payload.error.message
          : res.statusText || `HTTP ${res.status}`;
      const retryAfter =
        res.status === 429 ? res.headers.get("retry-after") : null;
      const message = retryAfter
        ? `${base} (retry after ${retryAfter}s)`
        : base;
      throw new ApiError(res.status, code, message, data);
    }
    return data as T;
  }

  listIssues(query: {
    state?: string;
    priority?: string;
    assignee?: string;
    team?: string;
    search?: string;
    source?: string;
    cursor?: string;
    limit?: number;
  }): Promise<IssueList> {
    return this.req("GET", "/issues", {
      query: {
        state: query.state,
        priority: query.priority,
        assignee: query.assignee,
        team: query.team,
        search: query.search,
        source: query.source,
        cursor: query.cursor,
        limit: query.limit,
      },
    });
  }

  listTeams(): Promise<{ teams: Team[] }> {
    return this.req("GET", "/teams");
  }

  createTeam(body: {
    key: string;
    name: string;
    rolloverBehavior?: "next_cycle" | "backlog";
  }): Promise<Team> {
    return this.req("POST", "/teams", { body });
  }

  getIssue(key: string): Promise<IssueDetail> {
    return this.req("GET", `/issues/${encodeURIComponent(key)}`);
  }

  createIssue(body: CreateIssueInput): Promise<Issue> {
    return this.req("POST", "/issues", { body });
  }

  patchIssue(key: string, body: PatchIssueInput): Promise<Issue> {
    return this.req("PATCH", `/issues/${encodeURIComponent(key)}`, { body });
  }

  addComment(key: string, body: string): Promise<Comment> {
    return this.req("POST", `/issues/${encodeURIComponent(key)}/comments`, {
      body: { body },
    });
  }

  listComments(key: string): Promise<{ comments: Comment[] }> {
    return this.req("GET", `/issues/${encodeURIComponent(key)}/comments`);
  }

  triage(key: string, action: "accept" | "decline"): Promise<Issue> {
    return this.req("POST", `/issues/${encodeURIComponent(key)}/triage`, {
      body: { action },
    });
  }

  listEvents(query: { cursor?: string; limit?: number }): Promise<EventList> {
    return this.req("GET", "/events", {
      query: { cursor: query.cursor, limit: query.limit },
    });
  }

  listAgents(): Promise<{ agents: Agent[] }> {
    return this.req("GET", "/agents");
  }

  listDispatches(query: {
    status?: string;
    agentId?: string;
  }): Promise<{ dispatches: Dispatch[] }> {
    return this.req("GET", "/dispatches", {
      query: { status: query.status, agentId: query.agentId },
    });
  }

  reportDispatch(
    id: string,
    body: { outcome: "completed" | "failed"; reason?: string; branch?: string; prUrl?: string },
  ): Promise<{ ok: boolean; status: string }> {
    return this.req("POST", `/dispatches/${encodeURIComponent(id)}/report`, {
      body,
    });
  }

  appendSessionEvents(
    dispatchId: string,
    events: { kind: string; message: string }[],
  ): Promise<{ events: { id: number }[] }> {
    return this.req("POST", `/dispatches/${encodeURIComponent(dispatchId)}/events`, {
      body: { events },
    });
  }

  listSessions(key: string): Promise<{ sessions: Session[] }> {
    return this.req("GET", `/issues/${encodeURIComponent(key)}/sessions`);
  }

  importPlan(body: PlanImportRequest): Promise<PlanImportDiff> {
    return this.req("POST", "/import/plan", { body });
  }

  getWorkspace(): Promise<Workspace> {
    // workspace root lives at /v1/:ws — no /issues suffix
    return this.req("GET", "", {});
  }

  // Raw streaming handle for `events --follow` — caller owns the body.
  async openEventStream(after?: string): Promise<Response> {
    const res = await this.fetchImpl(
      new Request(
        this.url("/events/stream", after ? { after } : undefined),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "text/event-stream",
          },
        },
      ),
    );
    if (!res.ok) {
      let payload: ErrorPayload = {};
      try {
        payload = (await res.json()) as ErrorPayload;
      } catch {
        payload = {};
      }
      const code =
        typeof payload.error?.code === "string"
          ? payload.error.code
          : "HTTP_ERROR";
      const message =
        typeof payload.error?.message === "string"
          ? payload.error.message
          : res.statusText || `HTTP ${res.status}`;
      throw new ApiError(res.status, code, message);
    }
    return res;
  }
}
