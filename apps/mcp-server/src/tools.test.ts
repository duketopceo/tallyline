import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../../api/src/index.js";
import { closeDb, db } from "../../api/src/db/client.js";
import { runMigrations } from "../../api/src/db/migrate.js";
import {
  agentActivities,
  agentKeys,
  agents,
  agentSessions,
  authIdentities,
  authProviders,
  comments,
  cycles,
  dispatches,
  events,
  invites,
  issueLabels,
  issueRelations,
  issueSuggestions,
  issues,
  labels,
  oauthCodes,
  projectMilestones,
  projects,
  sessions,
  teamMembers,
  teams,
  userIdMap,
  users,
  userTokens,
  views,
  workflowDefinitions,
  workspaceMembers,
  workspaces,
} from "../../api/src/db/schema.js";
import { hashKey } from "../../api/src/services/agents.js";
import { hashToken } from "../../api/src/services/tokens.js";
import { TallylineClient } from "./client.js";
import { MissingEnvError, loadConfig } from "./env.js";
import { createMcpServer } from "./server.js";
import { runTool, toolsByName } from "./tools.js";

vi.hoisted(() => {
  // keep the api app from binding a port / running migrations on import
  process.env.NODE_ENV ??= "test";
});

const SLUG = `mcp-${Date.now()}`;

const WIPE_ORDER = [
  agentActivities,
  agentSessions,
  dispatches,
  comments,
  events,
  issueRelations,
  issueSuggestions,
  workflowDefinitions,
  issueLabels,
  issues,
  labels,
  agentKeys,
  agents,
  userTokens,
  views,
  cycles,
  projectMilestones,
  projects,
  sessions,
  invites,
  oauthCodes,
  authIdentities,
  authProviders,
  userIdMap,
  teamMembers,
  workspaceMembers,
  users,
  teams,
] as const;

type Json = Record<string, unknown> & { error?: { code: string } };

let wsId = "";
const teamKey = "MCP";
let agentId = "";
let rwClient: TallylineClient;
let roClient: TallylineClient;
let patClient: TallylineClient;

function clientFor(token: string): TallylineClient {
  return new TallylineClient({
    apiUrl: "http://mcp.test",
    token,
    workspace: SLUG,
    fetchImpl: async (input, init) => app.fetch(new Request(input, init)),
  });
}

async function call(
  name: string,
  args: Record<string, unknown>,
  client: TallylineClient = rwClient,
): Promise<{ res: CallToolResult; data: Json }> {
  const res = await runTool(name, args, client);
  const first = res.content[0];
  const data = (first && first.type === "text"
    ? JSON.parse(first.text)
    : {}) as Json;
  return { res, data };
}

beforeAll(async () => {
  await runMigrations();
  for (const t of WIPE_ORDER) await db.delete(t);
  await db.delete(workspaces);

  const [ws] = await db
    .insert(workspaces)
    .values({ slug: SLUG, name: "MCP Test" })
    .returning();
  wsId = ws!.id;
  await db
    .insert(teams)
    .values({ workspaceId: wsId, key: teamKey, name: "MCP Team" });

  const [user] = await db
    .insert(users)
    .values({ email: "mcp@t.co", name: "MCP Human" })
    .returning();
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: wsId, userId: user!.id, role: "owner" });
  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: wsId,
      name: "mcp-agent",
      harness: "vitest",
      capabilities: ["code"],
    })
    .returning();
  agentId = agent!.id;

  const rwToken = `tly_agt_${randomBytes(24).toString("base64url")}`;
  const roToken = `tly_agt_${randomBytes(24).toString("base64url")}`;
  await db.insert(agentKeys).values([
    {
      agentId,
      workspaceId: wsId,
      name: "rw",
      tokenHash: hashKey(rwToken),
      scopes: ["read", "write"],
    },
    {
      agentId,
      workspaceId: wsId,
      name: "ro",
      tokenHash: hashKey(roToken),
      scopes: ["read"],
    },
  ]);
  const pat = `tly_pat_${randomBytes(24).toString("base64url")}`;
  await db.insert(userTokens).values({
    userId: user!.id,
    workspaceId: wsId,
    name: "pat",
    tokenHash: hashToken(pat),
    scopes: ["read", "write"],
  });

  rwClient = clientFor(rwToken);
  roClient = clientFor(roToken);
  patClient = clientFor(pat);
});

afterAll(async () => {
  for (const t of WIPE_ORDER) await db.delete(t);
  await db.delete(workspaces);
  await closeDb();
});

describe("config", () => {
  it("fails fast on missing env, defaults API URL", () => {
    expect(() => loadConfig({})).toThrow(MissingEnvError);
    try {
      loadConfig({ TALLYLINE_TOKEN: "tly_agt_x" });
    } catch (e) {
      expect((e as MissingEnvError).missing).toEqual(["TALLYLINE_WORKSPACE"]);
    }
    const cfg = loadConfig({
      TALLYLINE_TOKEN: "tly_agt_x",
      TALLYLINE_WORKSPACE: "acme",
    });
    expect(cfg.apiUrl).toBe("http://localhost:4000");
    expect(cfg.workspace).toBe("acme");
  });
});

describe("tool surface over the real API", () => {
  it("whoami resolves the agent key to its agent identity + scopes", async () => {
    const { data } = await call("whoami", {});
    expect(data.type).toBe("agent");
    expect(data.id).toBe(agentId);
    expect(data.name).toBe("mcp-agent");
    expect(data.scopes).toContain("write");
    expect(data.workspaceSlug).toBe(SLUG);

    const pat = await call("whoami", {}, patClient);
    expect(pat.data.type).toBe("human");
    expect(pat.data.name).toBe("MCP Human");
  });

  it("create_issue → list_issues → get_issue roundtrip", async () => {
    const created = await call("create_issue", {
      title: "Wire MCP tools",
      priority: "high",
      description: "end to end",
    });
    expect(created.res.isError).toBeFalsy();
    expect(created.data.key).toBe(`${teamKey}-1`);
    expect(created.data.state).toBe("backlog");

    const listed = await call("list_issues", {});
    const keys = (listed.data.issues as { key: string }[]).map((i) => i.key);
    expect(keys).toContain(`${teamKey}-1`);

    const filtered = await call("list_issues", { state: ["triage"] });
    expect(
      (filtered.data.issues as { state: string }[]).every(
        (i) => i.state === "triage",
      ),
    ).toBe(true);

    const got = await call("get_issue", {
      key: `${teamKey}-1`,
      includeComments: true,
    });
    expect(got.data.title).toBe("Wire MCP tools");
    expect(got.data.description).toBe("end to end");
    expect(got.data.comments).toEqual([]);
  });

  it("links issues to a milestone and filters list_issues by milestone and label (U16)", async () => {
    const [project] = await db
      .insert(projects)
      .values({ workspaceId: wsId, name: "ms project" })
      .returning();
    const [ms] = await db
      .insert(projectMilestones)
      .values({ workspaceId: wsId, projectId: project!.id, title: "Launch" })
      .returning();
    const [hitl] = await db
      .insert(labels)
      .values({ workspaceId: wsId, name: "hitl-mcp", color: "#f59e0b" })
      .returning();
    const linked = await call("create_issue", {
      title: "in milestone",
      projectId: project!.id,
      milestoneId: ms!.id,
      labelIds: [hitl!.id],
    });
    expect(linked.res.isError).toBeFalsy();
    expect(linked.data.milestoneId ?? null).toBe(ms!.id);
    const plain = await call("create_issue", { title: "outside", projectId: project!.id });
    const byMilestone = await call("list_issues", { milestone: ms!.id });
    expect((byMilestone.data.issues as { key: string }[]).map((i) => i.key)).toEqual([linked.data.key]);
    const byLabel = await call("list_issues", { label: hitl!.id });
    expect((byLabel.data.issues as { key: string }[]).map((i) => i.key)).toEqual([linked.data.key]);
    const moved = await call("update_issue", { key: plain.data.key as string, milestoneId: ms!.id });
    expect(moved.res.isError).toBeFalsy();
    const both = await call("list_issues", { milestone: ms!.id });
    expect(both.data.issues as unknown[]).toHaveLength(2);
  });

  it("update_issue mutates fields and enforces the state machine", async () => {
    const ok = await call("update_issue", {
      key: `${teamKey}-1`,
      priority: "urgent",
      state: "todo",
    });
    expect(ok.res.isError).toBeFalsy();
    expect(ok.data.state).toBe("todo");
    expect(ok.data.priority).toBe("urgent");

    const illegal = await call("update_issue", {
      key: `${teamKey}-1`,
      state: "done",
    });
    expect(illegal.res.isError).toBe(true);
    expect(illegal.data.error!.code).toBe("INVALID_TRANSITION");
  });

  it("triage_issue accepts and declines, rejects non-triage issues", async () => {
    const t = await call("create_issue", {
      title: "triage me",
      state: "triage",
    });
    const tKey = t.data.key as string;
    const accepted = await call("triage_issue", { key: tKey, action: "accept" });
    expect(accepted.data.state).toBe("backlog");

    const again = await call("triage_issue", { key: tKey, action: "accept" });
    expect(again.res.isError).toBe(true);
    expect(again.data.error!.code).toBe("NOT_IN_TRIAGE");
  });

  it("claim assigns the caller and walks backlog→todo→in_progress", async () => {
    const created = await call("create_issue", { title: "claim me" });
    const res = await call("claim", { key: created.data.key });
    expect(res.res.isError).toBeFalsy();
    expect(res.data.state).toBe("in_progress");
    expect(res.data.assigneeType).toBe("agent");
    expect(res.data.assigneeId).toBe(agentId);

    const detail = await call("get_issue", { key: created.data.key });
    expect(detail.data.assigneeId).toBe(agentId);
    expect(detail.data.state).toBe("in_progress");
  });

  it("claim on a triage issue fails with guidance", async () => {
    const created = await call("create_issue", {
      title: "still triage",
      state: "triage",
    });
    const res = await call("claim", { key: created.data.key });
    expect(res.res.isError).toBe(true);
    expect(res.data.error!.code).toBe("INVALID_STATE");
    expect(JSON.stringify(res.data)).toContain("triage_issue");
  });

  it("comment posts as the agent identity and shows in get_issue", async () => {
    const c = await call("comment", {
      key: `${teamKey}-1`,
      body: "picked this up",
    });
    expect(c.res.isError).toBeFalsy();
    expect(c.data.actorType).toBe("agent");
    expect(c.data.actorId).toBe(agentId);

    const got = await call("get_issue", {
      key: `${teamKey}-1`,
      includeComments: true,
    });
    const bodies = (got.data.comments as { body: string }[]).map((x) => x.body);
    expect(bodies).toContain("picked this up");
  });

  it("ready returns todo issues ordered by priority", async () => {
    await call("create_issue", { title: "low todo", priority: "low" });
    await call("create_issue", { title: "urgent todo", priority: "urgent" });
    // move both to todo (backlog→todo is a legal transition); assign the
    // low-priority one to this agent so `mine` has something to find
    const l = await call("list_issues", { search: "low todo" });
    const u = await call("list_issues", { search: "urgent todo" });
    const lowKey = (l.data.issues as { key: string }[])[0]!.key;
    const urgentKey = (u.data.issues as { key: string }[])[0]!.key;
    await call("update_issue", {
      key: lowKey,
      state: "todo",
      assigneeType: "agent",
      assigneeId: agentId,
    });
    await call("update_issue", { key: urgentKey, state: "todo" });

    const res = await call("ready", {});
    const priorities = (res.data.issues as { priority: string }[]).map(
      (i) => i.priority,
    );
    expect(
      (res.data.issues as { state: string }[]).every(
        (i) => i.state === "todo",
      ),
    ).toBe(true);
    expect(priorities.indexOf("urgent")).toBeLessThan(
      priorities.lastIndexOf("low"),
    );

    const mine = await call("ready", { mine: true });
    const mineKeys = (mine.data.issues as { key: string }[]).map(
      (i) => i.key,
    );
    expect(mineKeys).toEqual([lowKey]);
  });

  it("create_cycle and assign_cycle schedule work; a foreign-workspace cycle is refused", async () => {
    const day = 86_400_000;
    const created = await call("create_cycle", {
      teamKey,
      name: "planned",
      startsAt: new Date(Date.now() + 30 * day).toISOString(),
      endsAt: new Date(Date.now() + 37 * day).toISOString(),
    });
    expect(created.res.isError).toBeFalsy();
    const cycleId = created.data.id as string;
    expect(created.data.isActive).toBe(false);

    const a = await call("create_issue", { title: "plan me a" });
    const b = await call("create_issue", { title: "plan me b" });
    const keys = [a.data.key as string, b.data.key as string];
    const assigned = await call("assign_cycle", { keys, cycleId });
    expect(assigned.res.isError).toBeFalsy();
    expect(assigned.data.assigned).toEqual(keys);
    const got = await call("get_issue", { key: keys[0]! });
    expect(got.data.cycleId).toBe(cycleId);

    const cleared = await call("assign_cycle", { keys: [keys[0]!], cycleId: null });
    expect(cleared.res.isError).toBeFalsy();

    // another workspace's cycle
    const [other] = await db
      .insert(workspaces)
      .values({ slug: `${SLUG}-other`, name: "Other" })
      .returning();
    const [otherTeam] = await db
      .insert(teams)
      .values({ workspaceId: other!.id, key: "OTH", name: "Other team" })
      .returning();
    const [foreign] = await db
      .insert(cycles)
      .values({
        workspaceId: other!.id,
        teamId: otherTeam!.id,
        number: 1,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + day),
      })
      .returning();
    const refused = await call("assign_cycle", {
      keys: [keys[1]!],
      cycleId: foreign!.id,
    });
    expect(refused.res.isError).toBe(true);
    expect(refused.data.error!.code).toBe("INVALID_CYCLE");

    const denied = await call(
      "create_cycle",
      {
        teamKey,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + day).toISOString(),
      },
      roClient,
    );
    expect(denied.data.error!.code).toBe("FORBIDDEN_SCOPE");
  });

  it("lists agents, teams, labels, projects, cycles, and the event feed", async () => {
    await db.insert(labels).values({
      workspaceId: wsId,
      name: "mcp-label",
      color: "#3ea1f7",
    });
    await db.insert(projects).values({
      workspaceId: wsId,
      name: "Agent surface",
      status: "started",
    });
    await db.insert(cycles).values({
      workspaceId: wsId,
      teamId: (
        await db.query.teams.findFirst({
          where: (t, { eq }) => eq(t.workspaceId, wsId),
        })
      )!.id,
      number: 1,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      isActive: true,
    });

    const agentsRes = await call("list_agents", {});
    expect(
      (agentsRes.data.agents as { name: string }[]).map((a) => a.name),
    ).toContain("mcp-agent");

    const teamsRes = await call("list_teams", {});
    expect(
      (teamsRes.data.teams as { key: string }[]).map((t) => t.key),
    ).toContain(teamKey);

    const membersRes = await call("list_members", {});
    expect(
      (membersRes.data.members as { role: string }[]).map((m) => m.role),
    ).toContain("owner");

    const labelsRes = await call("list_labels", {});
    expect(
      (labelsRes.data.labels as { name: string }[]).map((l) => l.name),
    ).toContain("mcp-label");

    const projectsRes = await call("list_projects", {});
    expect(
      (projectsRes.data.projects as { name: string }[]).map((p) => p.name),
    ).toContain("Agent surface");

    const cyclesRes = await call("list_cycles", { active: true });
    expect(cyclesRes.data.cycles).toHaveLength(1);
    expect((cyclesRes.data.cycles as { number: number }[])[0]!.number).toBe(1);

    const feed = await call("list_events", { limit: 50 });
    const actions = (feed.data.events as { action: string }[]).map(
      (e) => e.action,
    );
    expect(actions).toContain("created");
    expect(actions).toContain("state_changed");
    expect(
      (feed.data.events as { actorName: string | null }[]).some(
        (e) => e.actorName === "mcp-agent",
      ),
    ).toBe(true);
  });

  it("surfaces API errors as tool errors — 404, 401, and FORBIDDEN_SCOPE", async () => {
    const missing = await call("get_issue", { key: "NOPE-999" });
    expect(missing.res.isError).toBe(true);
    expect(missing.data.error!.code).toBe("NOT_FOUND");

    const badAuth = await call(
      "list_issues",
      {},
      clientFor("tly_agt_bogus"),
    );
    expect(badAuth.res.isError).toBe(true);
    expect(badAuth.data.error!.code).toBe("UNAUTHENTICATED");

    // read-scoped agent key: reads pass, mutations surface 403
    const readOk = await call("list_issues", {}, roClient);
    expect(readOk.res.isError).toBeFalsy();

    const denied = await call(
      "create_issue",
      { title: "ro write attempt" },
      roClient,
    );
    expect(denied.res.isError).toBe(true);
    expect(denied.data.error!.code).toBe("FORBIDDEN_SCOPE");
    expect(JSON.stringify(denied.data)).toContain("write");

    const deniedComment = await call(
      "comment",
      { key: `${teamKey}-1`, body: "nope" },
      roClient,
    );
    expect(deniedComment.res.isError).toBe(true);
    expect(deniedComment.data.error!.code).toBe("FORBIDDEN_SCOPE");
  });

  it("session_get and session_post_activity drive an agent session over MCP", async () => {
    const issue = await db.query.issues.findFirst({
      where: (i, { eq }) => eq(i.workspaceId, wsId),
    });
    const [disp] = await db
      .insert(dispatches)
      .values({
        workspaceId: wsId,
        issueId: issue!.id,
        agentId,
        trigger: "assign",
      })
      .returning();
    const [sess] = await db
      .insert(agentSessions)
      .values({
        workspaceId: wsId,
        dispatchId: disp!.id,
        issueId: issue!.id,
        agentId,
      })
      .returning();

    const got = await call("session_get", { id: sess!.id });
    expect(got.res.isError).toBeFalsy();
    expect((got.data.session as { status: string }).status).toBe("pending");
    expect(got.data.activities).toEqual([]);

    const ack = await call("session_post_activity", {
      id: sess!.id,
      content: { type: "thought", body: "inspecting repository" },
      ephemeral: true,
    });
    expect(ack.res.isError).toBeFalsy();
    expect((ack.data.session as { status: string }).status).toBe("active");
    expect((ack.data.activity as { type: string; ephemeral: boolean }).type).toBe("thought");
    expect((ack.data.activity as { ephemeral: boolean }).ephemeral).toBe(true);

    const elicited = await call("session_elicit", {
      id: sess!.id,
      body: "Should we use approach A or B?",
    });
    expect(elicited.res.isError).toBeFalsy();
    expect((elicited.data.session as { status: string }).status).toBe("awaitingInput");
    expect((elicited.data.activity as { type: string }).type).toBe("elicitation");

    const replied = await call(
      "session_reply",
      {
        id: sess!.id,
        body: "Use approach A.",
      },
      patClient,
    );
    expect(replied.res.isError).toBeFalsy();
    expect((replied.data.session as { status: string }).status).toBe("active");
    expect((replied.data.activity as { type: string }).type).toBe("prompt");

    const done = await call("session_post_activity", {
      id: sess!.id,
      content: { type: "response", body: "all tests green", final: true },
    });
    expect(done.res.isError).toBeFalsy();
    expect((done.data.session as { status: string }).status).toBe("complete");

    const after = await call("session_get", { id: sess!.id });
    expect((after.data.session as { status: string }).status).toBe("complete");
    expect((after.data.activities as unknown[]).length).toBe(4);
  });
});

describe("projects and plan import", () => {
  const plan = (titles: string[]) =>
    [
      "# MCP plan",
      "",
      "## Implementation Units",
      "",
      ...titles.flatMap((t, i) => [
        `### U${i + 1}. ${t}`,
        "",
        `**Goal:** Goal of U${i + 1}.`,
        "",
        "**Dependencies:** none.",
        "",
        `**Verification:** check U${i + 1}.`,
        "",
      ]),
    ].join("\n");
  const SOURCE = { repo: "duketopceo/kate", path: "docs/plans/mcp.md", sha: "abc1234" };
  const markdown = plan(["Mint session tokens", "Drain the retry queue", "Index the audit log"]);
  const args = (project: string, extra: Record<string, unknown> = {}) => ({
    project,
    scope: "MP",
    ...SOURCE,
    markdown,
    ...extra,
  });
  type Diff = {
    mode: string;
    diffHash: string;
    counts: Record<string, number>;
    units: { scopedId: string; action: string }[];
    diff?: { diffHash: string };
  };
  let projectName = "";

  it("create_project rejects a duplicate name, case-insensitively", async () => {
    projectName = `Plan target ${Date.now()}`;
    const made = await call("create_project", { name: projectName, teamKey });
    expect(made.res.isError).toBeFalsy();
    expect(made.data.name).toBe(projectName);
    expect(made.data.status).toBe("planned");

    const dup = await call("create_project", { name: projectName.toUpperCase() });
    expect(dup.res.isError).toBe(true);
    expect(dup.data.error!.code).toBe("DUPLICATE_NAME");
    const listed = await call("list_projects", {});
    const same = (listed.data.projects as { name: string }[]).filter(
      (p) => p.name.toLowerCase() === projectName.toLowerCase(),
    );
    expect(same).toHaveLength(1);
  });

  it("update_project patches fields and refuses a rename onto another project", async () => {
    const a = await call("create_project", { name: `Rename A ${Date.now()}` });
    const b = await call("create_project", { name: `Rename B ${Date.now()}` });
    const upd = await call("update_project", {
      id: a.data.id,
      status: "started",
      description: "now running",
    });
    expect(upd.res.isError).toBeFalsy();
    expect(upd.data.status).toBe("started");
    expect(upd.data.description).toBe("now running");

    const clash = await call("update_project", { id: a.data.id, name: b.data.name });
    expect(clash.data.error!.code).toBe("DUPLICATE_NAME");
    // renaming a project to its own name is not a clash
    const same = await call("update_project", { id: a.data.id, name: a.data.name });
    expect(same.res.isError).toBeFalsy();
  });

  it("a read-only key cannot create or update a project or import", async () => {
    const c = await call("create_project", { name: "nope" }, roClient);
    expect(c.data.error!.code).toBe("FORBIDDEN_SCOPE");
    const i = await call("import_plan", args(projectName), roClient);
    expect(i.res.isError).toBe(true);
    expect(i.data.error!.code).toBe("FORBIDDEN_SCOPE");
  });

  it("import_plan defaults to a dry run with the API's diff shape and writes nothing", async () => {
    const r = await call("import_plan", args(projectName));
    expect(r.res.isError).toBeFalsy();
    const d = r.data as unknown as Diff;
    expect(d.mode).toBe("dry_run");
    expect(d.counts.create).toBe(3);
    expect(d.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.units.map((u) => u.scopedId)).toEqual(["MP-U1", "MP-U2", "MP-U3"]);
    const listed = await call("list_issues", { search: "[MP-U" });
    expect(listed.data.issues).toEqual([]);
  });

  it("apply needs the reviewed hash: none is refused, a stale one returns the new diff", async () => {
    const none = await call("import_plan", args(projectName, { mode: "apply" }));
    expect(none.data.error!.code).toBe("DIFF_HASH_REQUIRED");

    const stale = await call(
      "import_plan",
      args(projectName, { mode: "apply", diffHash: "0".repeat(64) }),
    );
    expect(stale.res.isError).toBe(true);
    expect(stale.data.error!.code).toBe("STALE_DIFF");
    expect((stale.data as unknown as Diff).diff!.diffHash).toMatch(/^[0-9a-f]{64}$/);
    const listed = await call("list_issues", { search: "[MP-U" });
    expect(listed.data.issues).toEqual([]);
  });

  it("applies with the reviewed hash as an agent, then re-runs as unchanged", async () => {
    const dry = (await call("import_plan", args(projectName))).data as unknown as Diff;
    const applied = await call(
      "import_plan",
      args(projectName, { mode: "apply", diffHash: dry.diffHash }),
    );
    expect(applied.res.isError).toBeFalsy();
    expect((applied.data as unknown as Diff).mode).toBe("apply");
    const listed = await call("list_issues", { search: "[MP-U" });
    expect((listed.data.issues as unknown[]).length).toBe(3);

    const again = (await call("import_plan", args(projectName))).data as unknown as Diff;
    expect(again.counts.unchanged).toBe(3);
    expect(again.counts.create).toBe(0);
  });

  it("exposes no way to write historical state: evidence and historical are not tool inputs", () => {
    const def = toolsByName.get("import_plan")!;
    expect(Object.keys(def.inputSchema)).not.toContain("evidence");
    expect(Object.keys(def.inputSchema)).not.toContain("historical");
  });
});

describe("MCP protocol end-to-end (InMemoryTransport)", () => {
  it("lists tools and calls list_issues through a real MCP client", async () => {
    const server = createMcpServer(rwClient);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "vitest", version: "0.0.0" });
    await mcp.connect(clientTransport);

    const listed = await mcp.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const t of [
      "list_issues",
      "get_issue",
      "create_issue",
      "update_issue",
      "triage_issue",
      "comment",
      "claim",
      "ready",
      "list_agents",
      "list_members",
      "list_projects",
      "list_cycles",
      "create_cycle",
      "assign_cycle",
      "list_teams",
      "list_labels",
      "list_events",
      "session_get",
      "session_post_activity",
      "session_elicit",
      "session_reply",
      "whoami",
      "create_project",
      "update_project",
      "import_plan",
    ]) {
      expect(names).toContain(t);
    }

    const res = await mcp.callTool({
      name: "list_issues",
      arguments: { limit: 5 },
    });
    const content = res.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as {
      issues: { key: string }[];
    };
    expect(parsed.issues.length).toBeGreaterThan(0);

    // error path over the wire: unknown key → isError + API code
    const err = await mcp.callTool({
      name: "get_issue",
      arguments: { key: "NOPE-999" },
    });
    expect(err.isError).toBe(true);
    const errContent = err.content as { type: string; text: string }[];
    expect(JSON.parse(errContent[0]!.text).error.code).toBe("NOT_FOUND");

    await mcp.close();
    await server.close();
  });
});
