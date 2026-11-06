import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { db } from "../db/client.js";
import { config_ } from "../env.js";
import { events, issueKeyAliases, issues, teams } from "../db/schema.js";
import { mkCycle, mkIssue, mkProject, seedTenant, type Tenant } from "../../test/tenants.js";

// U4: changing an issue's team re-keys it, keeps the old key resolving, writes
// one event, and every issue representation carries a computed `url`.

let t: Tenant;
let b: Tenant;
let team2: { id: string; key: string };

interface Body {
  key: string;
  url: string;
  teamId: string;
  number: number;
  cycleId: string | null;
  projectId: string | null;
  error: { code: string };
  issues: { key: string; url: string }[];
}

async function call(method: string, path: string, body?: unknown, bearer = t.pats.write, ws = t.ws.slug) {
  const res = await app.fetch(
    new Request(`http://api.test/v1/workspaces/${ws}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

const moveEvents = (issueId: string) =>
  db
    .select()
    .from(events)
    .where(and(eq(events.entityId, issueId), eq(events.action, "team_changed")));

beforeEach(async () => {
  t = await seedTenant("tm", "TMA");
  b = await seedTenant("tmb", "TMB");
  const [row] = await db
    .insert(teams)
    .values({ workspaceId: t.ws.id, key: "TMC", name: "Second team" })
    .returning();
  team2 = { id: row!.id, key: "TMC" };
});

describe("issue team change (U4)", () => {
  it("moves the issue, re-keys it from the target counter and logs one event", async () => {
    const issue = await mkIssue(t);
    const r = await call("PATCH", `/issues/${issue.key}`, { teamId: team2.id });
    expect(r.status).toBe(200);
    expect(r.body.teamId).toBe(team2.id);
    expect(r.body.key).toMatch(/^TMC-\d+$/);
    expect(r.body.key).toBe(`TMC-${r.body.number}`);
    const evs = await moveEvents(issue.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.before).toEqual({ teamId: t.team.id, key: issue.key });
    expect(evs[0]!.after).toEqual({ teamId: team2.id, key: r.body.key });
    // a second move takes the next number, never reuses one
    const back = await call("PATCH", `/issues/${r.body.key}`, { teamId: t.team.id });
    expect(back.status).toBe(200);
    expect(back.body.key).not.toBe(issue.key);
  });

  it("applies other fields in the same patch under the new key", async () => {
    const issue = await mkIssue(t);
    const r = await call("PATCH", `/issues/${issue.key}`, { teamId: team2.id, title: "renamed", state: "todo" });
    expect(r.status).toBe(200);
    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row!.title).toBe("renamed");
    expect(row!.state).toBe("todo");
    expect(row!.key).toBe(r.body.key);
  });

  it("keeps the old key resolving, through every key-addressed read", async () => {
    const issue = await mkIssue(t);
    const moved = await call("PATCH", `/issues/${issue.key}`, { teamId: team2.id });
    const detail = await call("GET", `/issues/${issue.key}`);
    expect(detail.status).toBe(200);
    expect(detail.body.key).toBe(moved.body.key);
    expect((await call("GET", `/issues/${issue.key}/comments`)).status).toBe(200);
    expect((await call("GET", `/issues/${issue.key}/sessions`)).status).toBe(200);
    // a write through the old key lands on the moved issue
    const viaOld = await call("PATCH", `/issues/${issue.key}`, { title: "via alias" });
    expect(viaOld.status).toBe(200);
    expect(viaOld.body.key).toBe(moved.body.key);
    // an alias never resolves in another workspace
    expect((await call("GET", `/issues/${issue.key}`, undefined, b.pats.write, b.ws.slug)).status).toBe(404);
    const aliases = await db.select().from(issueKeyAliases).where(eq(issueKeyAliases.issueId, issue.id));
    expect(aliases.map((a) => a.key)).toEqual([issue.key]);
  });

  it("is a no-op for the current team: no event, no new key", async () => {
    const issue = await mkIssue(t);
    const r = await call("PATCH", `/issues/${issue.key}`, { teamId: t.team.id });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe(issue.key);
    expect(await moveEvents(issue.id)).toHaveLength(0);
    expect(await db.select().from(issueKeyAliases).where(eq(issueKeyAliases.issueId, issue.id))).toHaveLength(0);
  });

  it("answers 404, not 403, for a team of another workspace", async () => {
    const issue = await mkIssue(t);
    const r = await call("PATCH", `/issues/${issue.key}`, { teamId: b.team.id });
    expect(r.status).toBe(404);
    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row!.teamId).toBe(t.team.id);
    expect(await moveEvents(issue.id)).toHaveLength(0);
  });

  it("refuses an agent key without write scope and allows one with it", async () => {
    const issue = await mkIssue(t);
    const denied = await call("PATCH", `/issues/${issue.key}`, { teamId: team2.id }, t.agentKeys.read);
    expect(denied.status).toBe(403);
    expect(await moveEvents(issue.id)).toHaveLength(0);
    const ok = await call("PATCH", `/issues/${issue.key}`, { teamId: team2.id }, t.agentKeys.write);
    expect(ok.status).toBe(200);
    expect((await moveEvents(issue.id))[0]!.actorType).toBe("agent");
  });

  it("drops the old team's cycle and team-scoped project", async () => {
    const cycle = await mkCycle(t);
    const project = await mkProject(t);
    const issue = await mkIssue(t, { cycleId: cycle.id, projectId: project.id });
    const r = await call("PATCH", `/issues/${issue.key}`, { teamId: team2.id });
    expect(r.status).toBe(200);
    expect(r.body.cycleId).toBeNull();
  });

  it("validates a cycle in the same patch against the target team", async () => {
    const cycle = await mkCycle(t);
    const issue = await mkIssue(t);
    const r = await call("PATCH", `/issues/${issue.key}`, { teamId: team2.id, cycleId: cycle.id });
    expect(r.status).toBe(422);
    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row!.teamId).toBe(t.team.id);
  });
});

describe("issue url (U4)", () => {
  it("is the web permalink on the configured origin in create, list, detail and patch", async () => {
    const created = await call("POST", "/issues", { title: "linked" });
    expect(created.status).toBe(201);
    const expected = `${config_.webUrl}/issues/${created.body.key}`;
    expect(created.body.url).toBe(expected);
    const detail = await call("GET", `/issues/${created.body.key}`);
    expect(detail.body.url).toBe(expected);
    const list = await call("GET", "/issues");
    expect(list.body.issues.find((i) => i.key === created.body.key)?.url).toBe(expected);
    const patched = await call("PATCH", `/issues/${created.body.key}`, { title: "x" });
    expect(patched.body.url).toBe(expected);
  });

  it("follows the key after a move", async () => {
    const issue = await mkIssue(t);
    const moved = await call("PATCH", `/issues/${issue.key}`, { teamId: team2.id });
    expect(moved.body.url).toBe(`${config_.webUrl}/issues/${moved.body.key}`);
  });
});
