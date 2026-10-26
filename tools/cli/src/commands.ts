import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { colorOn, mut } from "./pretty.js";
import {
  ISSUE_KEY_PATTERN,
  ISSUE_STATES,
  PRIORITIES,
  isAgentToken,
  readEnv,
  type IssueState,
  type Priority,
} from "@tallyline/types";
import {
  ApiClient,
  ApiError,
  type FeedEvent,
  type FetchLike,
  type Issue,
  type IssueList,
} from "./client.js";
import type { CliConfig, EnvLike } from "./config.js";
import {
  compareForReady,
  eventLine,
  issueDetail,
  issueRow,
  slimIssue,
} from "./format.js";
import { importPlanCmd } from "./import-plan.js";
import { transitionTo } from "./transition.js";
import { branchName, buildWorkPrompt, harnessBin } from "./work.js";

// --- shared plumbing --------------------------------------------------------

export type FlagValues = Record<
  string,
  string | boolean | (string | boolean)[] | undefined
>;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: EnvLike;
  cwd: string;
  fetch: FetchLike;
  stdin?: () => Promise<string>;
  isTTY?: boolean | undefined;
}

// CLI-side failure carrying an exit code. API-side failures stay ApiError.
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const fail = (msg: string) => new CliError(1, msg);
export const usage = (msg: string) => new CliError(2, msg);

export interface CmdCtx {
  io: CliIo;
  cfg: CliConfig;
  client: ApiClient;
  json: boolean;
  flags: FlagValues;
  args: string[];
}

export interface Command {
  usage: string;
  summary: string;
  options: ParseArgsOptionsConfig;
  // false only for `init`, which may write config before any token exists
  needsApi: boolean;
  run: (ctx: CmdCtx) => Promise<void>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string) => UUID_RE.test(v);

function strFlag(flags: FlagValues, name: string): string | undefined {
  const v = flags[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const last = v.at(-1);
    return typeof last === "string" ? last : undefined;
  }
  return undefined;
}

function boolFlag(flags: FlagValues, name: string): boolean {
  return flags[name] === true;
}

function intFlag(
  flags: FlagValues,
  name: string,
  dflt: number,
  max = 1000,
): number {
  const raw = strFlag(flags, name);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw usage(`--${name} must be an integer between 1 and ${max}`);
  }
  return n;
}

function requireKey(arg: string | undefined): string {
  if (arg === undefined) throw usage("missing issue key (e.g. ENG-123)");
  const key = arg.toUpperCase();
  if (!ISSUE_KEY_PATTERN.test(key)) {
    throw usage(`invalid issue key '${arg}' — expected TEAM-123`);
  }
  return key;
}

function stateList(raw: string | undefined, dflt: string): IssueState[] {
  const states = (raw ?? dflt)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of states) {
    if (!(ISSUE_STATES as readonly string[]).includes(s)) {
      throw usage(
        `invalid state '${s}' — one of ${ISSUE_STATES.join(", ")}`,
      );
    }
  }
  return states as IssueState[];
}

function emit(ctx: CmdCtx, value: unknown): void {
  ctx.io.out(JSON.stringify(value));
}

function emitIssue(ctx: CmdCtx, issue: Issue): void {
  if (ctx.json) emit(ctx, slimIssue(issue));
  else ctx.io.out(issueRow(issue));
}

function emitIssueList(ctx: CmdCtx, res: IssueList): void {
  if (ctx.json) {
    emit(ctx, {
      issues: res.issues.map(slimIssue),
      nextCursor: res.nextCursor,
    });
    return;
  }
  if (res.issues.length === 0) {
    ctx.io.out(colorOn() ? mut("· no issues") : "no issues");
    return;
  }
  for (const i of res.issues) ctx.io.out(issueRow(i));
}

interface Identity {
  type: "agent" | "human";
  id: string;
}

async function agentIdByName(
  client: ApiClient,
  name: string,
): Promise<string> {
  const { agents } = await client.listAgents();
  const a = agents.find((x) => x.name === name);
  if (!a) {
    throw new ApiError(
      404,
      "NOT_FOUND",
      `agent '${name}' not found in workspace`,
    );
  }
  return a.id;
}

// Who is calling — for `claim`, `next`, and the "mine" half of `ready`.
// Agent keys carry no whoami endpoint, so identity comes from config:
// TALLYLINE_AGENT_ID / TALLYLINE_USER_ID (UUID or registered agent name).
async function resolveIdentity(
  ctx: CmdCtx,
  required: boolean,
): Promise<Identity | null> {
  const { agentId, userId } = ctx.cfg;
  if (agentId) {
    const id = isUuid(agentId)
      ? agentId
      : await agentIdByName(ctx.client, agentId);
    return { type: "agent", id };
  }
  if (userId) {
    if (!isUuid(userId)) {
      throw usage("TALLYLINE_USER_ID must be a UUID");
    }
    return { type: "human", id: userId };
  }
  if (required) {
    throw usage(
      "no identity configured — pass --as <agent-name|uuid> or set " +
        "TALLYLINE_AGENT_ID / TALLYLINE_USER_ID",
    );
  }
  return null;
}

// `--as`/`--assignee` may be a UUID (type from --type, defaulting by
// credential kind) or a registered agent name (always type agent).
async function resolveAssignee(
  ctx: CmdCtx,
  value: string,
  typeFlag: string | undefined,
): Promise<Identity> {
  if (typeFlag !== undefined && typeFlag !== "agent" && typeFlag !== "human") {
    throw usage("--type must be 'agent' or 'human'");
  }
  if (!isUuid(value)) {
    if (typeFlag === "human") {
      throw usage(
        "name lookup only resolves agents — pass a user UUID for humans",
      );
    }
    return { type: "agent", id: await agentIdByName(ctx.client, value) };
  }
  const type =
    typeFlag ??
    (ctx.cfg.agentId !== undefined || isAgentToken(ctx.cfg.token)
      ? "agent"
      : "human");
  return { type, id: value };
}

function parentIdFlag(
  flags: FlagValues,
  client: ApiClient,
): Promise<string | undefined> {
  const raw = strFlag(flags, "parent");
  if (raw === undefined) return Promise.resolve(undefined);
  if (isUuid(raw)) return Promise.resolve(raw);
  if (ISSUE_KEY_PATTERN.test(raw.toUpperCase())) {
    return client
      .getIssue(raw.toUpperCase())
      .then((i) => i.id);
  }
  throw usage("--parent must be an issue key or UUID");
}

// --- commands ---------------------------------------------------------------

const readyCmd: Command = {
  usage: "tallyline ready [--state todo[,…]] [--limit N] [--all]",
  summary:
    "issues ready to work — todo (by default), unassigned or mine, " +
    "priority-ordered",
  options: {
    state: { type: "string" },
    limit: { type: "string", short: "n" },
    all: { type: "boolean" },
  },
  needsApi: true,
  async run(ctx) {
    const states = stateList(strFlag(ctx.flags, "state"), "todo");
    const limit = intFlag(ctx.flags, "limit", 50);
    const all = boolFlag(ctx.flags, "all");
    const me = await resolveIdentity(ctx, false);
    const { issues } = await ctx.client.listIssues({
      state: states.join(","),
      limit: 200,
    });
    const rows = issues
      .filter(
        (i) =>
          all ||
          i.assigneeId === null ||
          (me !== null && i.assigneeId === me.id),
      )
      .sort(compareForReady)
      .slice(0, limit);
    if (ctx.json) {
      emit(ctx, { issues: rows.map(slimIssue) });
    } else if (rows.length === 0) {
      ctx.io.out("no issues ready");
    } else {
      for (const i of rows) ctx.io.out(issueRow(i));
    }
  },
};

const nextCmd: Command = {
  usage: "tallyline next",
  summary:
    "the one issue to work now — your in_progress issue, else the top " +
    "of ready",
  options: {},
  needsApi: true,
  async run(ctx) {
    const me = await resolveIdentity(ctx, false);
    let pick: Issue | undefined;
    if (me) {
      const { issues } = await ctx.client.listIssues({
        state: "in_progress",
        assignee: me.id,
        limit: 50,
      });
      pick = issues.sort(compareForReady)[0];
    }
    if (!pick) {
      const { issues } = await ctx.client.listIssues({
        state: "todo",
        limit: 200,
      });
      pick = issues
        .filter(
          (i) =>
            i.assigneeId === null ||
            (me !== null && i.assigneeId === me.id),
        )
        .sort(compareForReady)[0];
    }
    if (!pick) throw fail("no issues ready");
    if (ctx.json) emit(ctx, slimIssue(pick));
    else ctx.io.out(`${pick.key} ${pick.title}`);
  },
};

const claimCmd: Command = {
  usage: "tallyline claim <KEY> [--as <agent-name|uuid>] [--type agent|human]",
  summary:
    "assign an issue to yourself (TALLYLINE_AGENT_ID) or an explicit assignee",
  options: {
    as: { type: "string" },
    type: { type: "string" },
  },
  needsApi: true,
  async run(ctx) {
    const key = requireKey(ctx.args[0]);
    const as = strFlag(ctx.flags, "as");
    const me = as
      ? await resolveAssignee(ctx, as, strFlag(ctx.flags, "type"))
      : await resolveIdentity(ctx, true);
    const issue = await ctx.client.patchIssue(key, {
      assigneeType: me!.type,
      assigneeId: me!.id,
    });
    if (ctx.json) emit(ctx, slimIssue(issue));
    else ctx.io.out(`${issue.key} assigned to ${me!.type} ${me!.id}`);
  },
};

function transitionCmd(target: IssueState, verb: string): Command {
  return {
    usage: `tallyline ${verb} <KEY>`,
    summary: `move KEY toward '${target}' along legal transitions`,
    options: {},
    needsApi: true,
    async run(ctx) {
      const key = requireKey(ctx.args[0]);
      emitIssue(ctx, await transitionTo(ctx.client, key, target));
    },
  };
}

const stateCmd: Command = {
  usage: `tallyline state <KEY> <${ISSUE_STATES.join("|")}>`,
  summary:
    "move KEY to any state, stepping through legal transitions as needed",
  options: {},
  needsApi: true,
  async run(ctx) {
    const key = requireKey(ctx.args[0]);
    const target = ctx.args[1];
    if (
      target === undefined ||
      !(ISSUE_STATES as readonly string[]).includes(target)
    ) {
      throw usage(
        `state must be one of: ${ISSUE_STATES.join(", ")}`,
      );
    }
    emitIssue(
      ctx,
      await transitionTo(ctx.client, key, target as IssueState),
    );
  },
};

const commentCmd: Command = {
  usage: "tallyline comment <KEY> [body…] [--body text]",
  summary: "add a comment (body may also come from stdin)",
  options: {
    body: { type: "string", short: "m" },
  },
  needsApi: true,
  async run(ctx) {
    const key = requireKey(ctx.args[0]);
    let body = strFlag(ctx.flags, "body") ?? ctx.args.slice(1).join(" ");
    if (!body && ctx.io.stdin) body = (await ctx.io.stdin()).trim();
    if (!body.trim()) {
      throw usage(
        "comment body required — pass an argument, --body, or pipe stdin",
      );
    }
    const comment = await ctx.client.addComment(key, body.trim());
    if (ctx.json) emit(ctx, comment);
    else ctx.io.out(`comment ${comment.id.slice(0, 8)} added to ${key}`);
  },
};

const createCmd: Command = {
  usage:
    "tallyline create --title <t> [--team K] [--state backlog|triage] " +
    "[--priority p] [--description d] [--assignee a] [--parent KEY]",
  summary: "file a new issue",
  options: {
    title: { type: "string", short: "t" },
    team: { type: "string" },
    state: { type: "string" },
    priority: { type: "string", short: "p" },
    description: { type: "string", short: "d" },
    assignee: { type: "string" },
    "assignee-type": { type: "string" },
    parent: { type: "string" },
  },
  needsApi: true,
  async run(ctx) {
    const title = strFlag(ctx.flags, "title");
    if (!title) throw usage("create requires --title");
    const state = strFlag(ctx.flags, "state");
    if (state !== undefined && state !== "triage" && state !== "backlog") {
      throw usage("--state must be 'triage' or 'backlog' on create");
    }
    const priority = strFlag(ctx.flags, "priority");
    if (
      priority !== undefined &&
      !(PRIORITIES as readonly string[]).includes(priority)
    ) {
      throw usage(`invalid --priority '${priority}' — one of ${PRIORITIES.join(", ")}`);
    }
    let description = strFlag(ctx.flags, "description");
    if (description === undefined && ctx.io.stdin) {
      const piped = (await ctx.io.stdin()).trim();
      if (piped) description = piped;
    }
    const assignee = strFlag(ctx.flags, "assignee");
    const who = assignee
      ? await resolveAssignee(
          ctx,
          assignee,
          strFlag(ctx.flags, "assignee-type"),
        )
      : null;
    const parentId = await parentIdFlag(ctx.flags, ctx.client);
    const issue = await ctx.client.createIssue({
      title,
      ...(strFlag(ctx.flags, "team") !== undefined
        ? { teamKey: strFlag(ctx.flags, "team")!.toUpperCase() }
        : {}),
      ...(state !== undefined ? { state: state as "triage" | "backlog" } : {}),
      ...(priority !== undefined ? { priority: priority as Priority } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(who !== null
        ? { assigneeType: who.type, assigneeId: who.id }
        : {}),
      ...(parentId !== undefined ? { parentId } : {}),
    });
    emitIssue(ctx, issue);
  },
};

const listCmd: Command = {
  usage:
    "tallyline list [--state s[,…]] [--priority p[,…]] [--assignee me|none|" +
    "name|uuid] [--team K] [--search q] [--limit N] [--cursor c]",
  summary: "list issues with filters",
  options: {
    state: { type: "string" },
    priority: { type: "string", short: "p" },
    assignee: { type: "string", short: "a" },
    team: { type: "string" },
    search: { type: "string", short: "s" },
    limit: { type: "string", short: "n" },
    cursor: { type: "string" },
  },
  needsApi: true,
  async run(ctx) {
    const states = strFlag(ctx.flags, "state");
    if (states !== undefined) stateList(states, ""); // validates
    const priorities = strFlag(ctx.flags, "priority");
    if (priorities !== undefined) {
      for (const p of priorities.split(",")) {
        if (!(PRIORITIES as readonly string[]).includes(p.trim())) {
          throw usage(`invalid --priority '${p}'`);
        }
      }
    }
    const assignee = strFlag(ctx.flags, "assignee");
    let assigneeId: string | undefined;
    let unassignedOnly = false;
    if (assignee === "me") {
      const me = await resolveIdentity(ctx, true);
      assigneeId = me!.id;
    } else if (assignee === "none") {
      unassignedOnly = true;
    } else if (assignee !== undefined) {
      assigneeId = isUuid(assignee)
        ? assignee
        : await agentIdByName(ctx.client, assignee);
    }
    const res = await ctx.client.listIssues({
      ...(states !== undefined ? { state: states } : {}),
      ...(priorities !== undefined ? { priority: priorities } : {}),
      ...(assigneeId !== undefined ? { assignee: assigneeId } : {}),
      ...(strFlag(ctx.flags, "team") !== undefined
        ? { team: strFlag(ctx.flags, "team")!.toUpperCase() }
        : {}),
      ...(strFlag(ctx.flags, "search") !== undefined
        ? { search: strFlag(ctx.flags, "search")! }
        : {}),
      ...(strFlag(ctx.flags, "cursor") !== undefined
        ? { cursor: strFlag(ctx.flags, "cursor")! }
        : {}),
      limit: intFlag(ctx.flags, "limit", 50),
    });
    if (unassignedOnly) {
      res.issues = res.issues.filter((i) => i.assigneeId === null);
    }
    emitIssueList(ctx, res);
  },
};

const searchCmd: Command = {
  usage: "tallyline search <query> [--limit N] [--state s[,…]]",
  summary: "title search — shorthand for `list --search`",
  options: {
    limit: { type: "string", short: "n" },
    state: { type: "string" },
  },
  needsApi: true,
  async run(ctx) {
    const q = ctx.args.join(" ");
    if (!q) throw usage("search requires a query");
    const states = strFlag(ctx.flags, "state");
    if (states !== undefined) stateList(states, "");
    const res = await ctx.client.listIssues({
      search: q,
      ...(states !== undefined ? { state: states } : {}),
      limit: intFlag(ctx.flags, "limit", 50),
    });
    emitIssueList(ctx, res);
  },
};

const showCmd: Command = {
  usage: "tallyline show <KEY>",
  summary: "issue detail plus its comment thread",
  options: {},
  needsApi: true,
  async run(ctx) {
    const key = requireKey(ctx.args[0]);
    const [issue, { comments }] = await Promise.all([
      ctx.client.getIssue(key),
      ctx.client.listComments(key),
    ]);
    if (ctx.json) {
      emit(ctx, { issue, comments });
      return;
    }
    for (const line of issueDetail(issue, comments)) ctx.io.out(line);
  },
};

const triageCmd: Command = {
  usage: "tallyline triage <KEY> <accept|decline>",
  summary:
    "accept a triage item into the backlog, or decline it to canceled",
  options: {},
  needsApi: true,
  async run(ctx) {
    const key = requireKey(ctx.args[0]);
    const action = ctx.args[1];
    if (action !== "accept" && action !== "decline") {
      throw usage("triage action must be 'accept' or 'decline'");
    }
    emitIssue(ctx, await ctx.client.triage(key, action));
  },
};

const teamsCmd: Command = {
  usage: "tallyline teams [create --key K --name N [--rollover next_cycle|backlog]]",
  summary: "list teams, or create one (key 1-6 chars A-Z0-9)",
  options: {
    key: { type: "string" },
    name: { type: "string" },
    rollover: { type: "string" },
  },
  needsApi: true,
  async run(ctx) {
    const sub = ctx.args[0];
    if (sub === undefined || sub === "list") {
      const { teams } = await ctx.client.listTeams();
      if (ctx.json) emit(ctx, { teams });
      else for (const t of teams) ctx.io.out(`${t.key}\t${t.name}`);
      return;
    }
    if (sub !== "create") throw usage("teams subcommand must be 'list' or 'create'");
    const key = strFlag(ctx.flags, "key")?.toUpperCase();
    const name = strFlag(ctx.flags, "name");
    if (!key || !name) throw usage("teams create requires --key and --name");
    if (!/^[A-Z][A-Z0-9]{0,5}$/.test(key)) {
      throw usage("--key must be 1-6 chars, A-Z0-9, starting with a letter");
    }
    const rollover = strFlag(ctx.flags, "rollover");
    if (rollover !== undefined && rollover !== "next_cycle" && rollover !== "backlog") {
      throw usage("--rollover must be 'next_cycle' or 'backlog'");
    }
    const team = await ctx.client.createTeam({
      key,
      name,
      ...(rollover !== undefined ? { rolloverBehavior: rollover } : {}),
    });
    if (ctx.json) emit(ctx, team);
    else ctx.io.out(`${team.key}\t${team.name}`);
  },
};

function printEvent(ctx: CmdCtx, e: FeedEvent): void {
  ctx.io.out(ctx.json ? JSON.stringify(e) : eventLine(e));
}

async function pumpSse(
  res: Response,
  ctx: CmdCtx,
  lastId: string,
): Promise<string> {
  const body = res.body;
  if (!body) throw fail("event stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let last = lastId;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return last;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // heartbeat comment
        if (line.startsWith("id:")) last = line.slice(3).trim();
        else if (line.startsWith("data:"))
          dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      try {
        printEvent(ctx, JSON.parse(data) as FeedEvent);
      } catch {
        ctx.io.out(data);
      }
    }
  }
}

const eventsCmd: Command = {
  usage: "tallyline events [--limit N] [--after <event-id>] [--follow]",
  summary:
    "tail the workspace event feed; --follow streams via SSE with " +
    "last-id resume",
  options: {
    limit: { type: "string", short: "n" },
    after: { type: "string" },
    follow: { type: "boolean", short: "f" },
  },
  needsApi: true,
  async run(ctx) {
    const after = strFlag(ctx.flags, "after");
    if (after !== undefined) {
      const n = Number(after);
      if (!Number.isSafeInteger(n) || n < 0) {
        throw usage("--after must be a non-negative event id");
      }
    }
    const limit = intFlag(ctx.flags, "limit", 50);

    if (boolFlag(ctx.flags, "follow")) {
      // First connect surfaces errors; after that, retry forever with the
      // last-seen id (the stream's own resume contract).
      let lastId = after ?? "0";
      let res = await ctx.client.openEventStream(
        after !== undefined ? after : undefined,
      );
      for (;;) {
        try {
          lastId = await pumpSse(res, ctx, lastId);
        } catch {
          /* transient — reconnect below */
        }
        await new Promise((r) => setTimeout(r, 1_000));
        try {
          res = await ctx.client.openEventStream(lastId);
        } catch {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }

    const acc: FeedEvent[] = [];
    const afterN = after !== undefined ? Number(after) : null;
    let cursor: string | undefined;
    for (;;) {
      const page = await ctx.client.listEvents({
        ...(cursor !== undefined ? { cursor } : {}),
        limit: Math.min(200, Math.max(1, limit - acc.length)),
      });
      let hitAfter = false;
      for (const e of page.events) {
        // feed is newest-first — stop once we reach the resume point
        if (afterN !== null && Number(e.id) <= afterN) {
          hitAfter = true;
          break;
        }
        acc.push(e);
        if (acc.length >= limit) break;
      }
      if (hitAfter || acc.length >= limit || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    acc.sort((a, b) => Number(a.id) - Number(b.id)); // chronological out
    if (ctx.json) emit(ctx, { events: acc });
    else for (const e of acc) printEvent(ctx, e);
  },
};

const AGENT_MD = `# tallyline agent context

This project is tracked by a tallyline workspace. Use the \`tallyline\`
(alias \`tly\`) CLI — humans and agents share the same board.

## Auth

\`\`\`sh
export TALLYLINE_TOKEN=tly_agt_...   # scoped agent key (needs read+write to mutate)
export TALLYLINE_AGENT_ID=<uuid>     # your registered agent id — required for
                                    # claim / next / ready's "mine" filter
\`\`\`

Workspace + API URL come from .tallyline/config.json (flags and
TALLYLINE_API_URL / TALLYLINE_WORKSPACE override).

## Work loop

\`\`\`sh
tly ready --json          # unblocked todo issues, priority-ordered
tly next --json           # your in_progress issue, else the top of ready
tly claim ENG-123         # assign to yourself
tly start ENG-123         # -> in_progress
tly comment ENG-123 "wip: found root cause in dispatch loop"
tly done ENG-123          # -> done (steps through in_review automatically)
tly create --title "…" --priority high
tly events --after 41     # resume the workspace feed; --follow to stream
\`\`\`

## Output & exit codes

- \`--json\` (or \`--format json\`) emits machine-readable JSON on stdout.
- 0 ok · 1 error · 2 usage/config · 3 unauthorized/forbidden ·
  4 not found · 5 conflict (invalid transition, triage state, etc.)
- API failures print \`CODE: message\` on stderr.
`;

const workCmd: Command = {
  usage:
    "tallyline work [--once] [--interval N] [--cmd <binary>] [--dry-run] " +
    "[--follow]",
  summary:
    "run claimed dispatches — spawn the local harness in an isolated " +
    "worktree seeded with issue context",
  options: {
    once: { type: "boolean" },
    follow: { type: "boolean", short: "f" },
    interval: { type: "string" },
    cmd: { type: "string" },
    "dry-run": { type: "boolean" },
  },
  needsApi: true,
  async run(ctx) {
    const me = await resolveIdentity(ctx, true);
    if (me!.type !== "agent") {
      throw usage("work requires an agent identity (TALLYLINE_AGENT_ID)");
    }
    const { agents } = await ctx.client.listAgents();
    const agent = agents.find((a) => a.id === me!.id);
    if (!agent) throw fail("agent identity not found in workspace");

    const bin =
      strFlag(ctx.flags, "cmd") ??
      readEnv(ctx.io.env, "TALLYLINE_WORK_CMD") ??
      harnessBin(agent.harness);
    const dryRun = boolFlag(ctx.flags, "dry-run");
    if (!bin && !dryRun) {
      throw fail(
        `no harness binary for '${agent.harness}' — pass --cmd or set TALLYLINE_WORK_CMD`,
      );
    }
    const interval = intFlag(ctx.flags, "interval", 15, 3600);
    const follow = boolFlag(ctx.flags, "follow") && !boolFlag(ctx.flags, "once");

    const spawn = (await import("node:child_process")).spawn;
    const { execFile } = await import("node:child_process");
    const exec = (cmd: string, args: string[], cwd: string) =>
      new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        execFile(cmd, args, { cwd }, (err, stdout) => {
          if (err) reject(err);
          else resolve({ code: 0, stdout: stdout.toString() });
        });
      });

    for (;;) {
      const { dispatches } = await ctx.client.listDispatches({
        status: "claimed",
        agentId: me!.id,
      });
      for (const d of dispatches) {
        const [issue, { comments }] = await Promise.all([
          ctx.client.getIssue(d.issueKey),
          ctx.client.listComments(d.issueKey),
        ]);
        const branch = branchName(issue.key, issue.title);
        const prompt = buildWorkPrompt({
          issue,
          comments,
          agentName: agent.name,
          workspace: ctx.client.workspace,
        });

        if (dryRun) {
          ctx.io.out(
            `${issue.key} → ${branch} via ${bin ?? agent.harness}`,
          );
          if (ctx.json) emit(ctx, { issue: issue.key, branch, prompt });
          continue;
        }

        // session isolation: a git worktree when cwd is a repo, else cwd
        let workDir = ctx.io.cwd;
        let inWorktree = false;
        try {
          const root = (await exec("git", ["rev-parse", "--show-toplevel"], ctx.io.cwd)).stdout.trim();
          workDir = join(root, ".tallyline", issue.key);
          try {
            await exec("git", ["worktree", "add", workDir, "-b", branch], ctx.io.cwd);
          } catch {
            // branch may already exist — reuse it
            await exec("git", ["worktree", "add", workDir, branch], ctx.io.cwd);
          }
          inWorktree = true;
        } catch {
          // not a git repo — work in cwd, note it in the report
        }

        const ctxFile = join(workDir, ".tallyline-context.md");
        await writeFile(ctxFile, prompt);
        ctx.io.out(`${issue.key} → ${workDir} (${bin})`);

        let outcome: "completed" | "failed" = "completed";
        let reason: string | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(bin!, [ctxFile], {
              cwd: workDir,
              stdio: "inherit",
              env: {
                ...process.env,
                TALLYLINE_DISPATCH_ID: d.id,
                TALLYLINE_ISSUE_KEY: issue.key,
              },
            });
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`)),
            );
            child.on("error", reject);
          });
        } catch (err) {
          outcome = "failed";
          reason = err instanceof Error ? err.message : String(err);
        }
        await ctx.client.reportDispatch(d.id, {
          outcome,
          ...(reason !== undefined ? { reason } : {}),
          ...(inWorktree ? { branch } : {}),
        });
        ctx.io.out(
          `${issue.key} session ${outcome}${inWorktree ? ` — ${branch}` : ""}`,
        );
      }
      if (!follow) break;
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
  },
};

const SESSION_KINDS = [
  "reading",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "pr",
  "note",
  "error",
] as const;

const sessionCmd: Command = {
  usage:
    "tallyline session <kind> <message…> — kinds: " +
    SESSION_KINDS.join("|") +
    "  (dispatch from TALLYLINE_DISPATCH_ID or --dispatch)",
  summary: "post a progress event to your dispatched session timeline",
  options: {
    dispatch: { type: "string" },
  },
  needsApi: true,
  async run(ctx) {
    const kind = ctx.args[0];
    if (
      kind === undefined ||
      !(SESSION_KINDS as readonly string[]).includes(kind)
    ) {
      throw usage(`kind must be one of: ${SESSION_KINDS.join(", ")}`);
    }
    const message = ctx.args.slice(1).join(" ").trim();
    if (!message) throw usage("session requires a message");
    if (message.length > 500) throw usage("message too long (max 500)");
    const dispatchId =
      strFlag(ctx.flags, "dispatch") ?? readEnv(ctx.io.env, "TALLYLINE_DISPATCH_ID");
    if (!dispatchId || !isUuid(dispatchId)) {
      throw usage(
        "no dispatch — run inside `tallyline work`, set " +
          "TALLYLINE_DISPATCH_ID, or pass --dispatch <uuid>",
      );
    }
    await ctx.client.appendSessionEvents(dispatchId, [{ kind, message }]);
    if (ctx.json) emit(ctx, { kind, message });
    else ctx.io.out(`${kind}: ${message}`);
  },
};

const initCmd: Command = {
  usage:
    "tallyline init --workspace <slug> [--api-url url] [--agent-id id|name] " +
    "[--force]",
  summary:
    "write .tallyline/config.json + .tallyline/agent.md for this directory",
  options: {
    "agent-id": { type: "string" },
    force: { type: "boolean" },
  },
  needsApi: false,
  async run(ctx) {
    const workspace =
      strFlag(ctx.flags, "workspace") ?? ctx.cfg.workspace;
    if (!workspace) {
      throw usage("init requires --workspace <slug>");
    }
    const dir = join(ctx.io.cwd, ".tallyline");
    const configPath = join(dir, "config.json");
    if (existsSync(configPath) && !boolFlag(ctx.flags, "force")) {
      throw fail(`${configPath} already exists — pass --force to overwrite`);
    }

    let agentId = strFlag(ctx.flags, "agent-id") ?? ctx.cfg.agentId;
    if (agentId && !isUuid(agentId)) {
      if (!ctx.cfg.token) {
        throw usage(
          "resolving an agent name needs a token — pass the UUID or set " +
            "TALLYLINE_TOKEN",
        );
      }
      const client = new ApiClient({
        apiUrl: ctx.cfg.apiUrl,
        token: ctx.cfg.token,
        workspace,
        fetch: ctx.io.fetch,
      });
      agentId = await agentIdByName(client, agentId);
    }

    await mkdir(dir, { recursive: true });
    const config: Record<string, string> = {
      apiUrl: ctx.cfg.apiUrl,
      workspace,
    };
    if (agentId) config.agentId = agentId;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(join(dir, "agent.md"), AGENT_MD);

    ctx.io.out(`wrote ${configPath}`);
    ctx.io.out(`wrote ${join(dir, "agent.md")}`);

    if (ctx.cfg.token) {
      try {
        const client = new ApiClient({
          apiUrl: ctx.cfg.apiUrl,
          token: ctx.cfg.token,
          workspace,
          fetch: ctx.io.fetch,
        });
        const ws = await client.getWorkspace();
        ctx.io.out(`verified workspace '${ws.slug}' at ${ctx.cfg.apiUrl}`);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `${err.code}: ${err.message}`
            : String(err);
        ctx.io.err(`warning: could not verify workspace — ${msg}`);
      }
    } else {
      ctx.io.out(
        "set TALLYLINE_TOKEN (tly_agt_* / tly_pat_* / JWT) to authenticate",
      );
    }
  },
};

export const commands: Record<string, Command> = {
  ready: readyCmd,
  next: nextCmd,
  claim: claimCmd,
  start: transitionCmd("in_progress", "start"),
  done: transitionCmd("done", "done"),
  state: stateCmd,
  comment: commentCmd,
  create: createCmd,
  list: listCmd,
  search: searchCmd,
  show: showCmd,
  triage: triageCmd,
  teams: teamsCmd,
  events: eventsCmd,
  session: sessionCmd,
  work: workCmd,
  "import-plan": importPlanCmd,
  init: initCmd,
};
