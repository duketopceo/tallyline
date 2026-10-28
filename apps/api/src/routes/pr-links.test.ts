import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { githubRepos, issueExternalRefs, issues } from "../db/schema.js";
import { app } from "../index.js";
import { processGithubEvent } from "../services/github-automation.js";
import { mkIssue, mkProject, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// U17 (R16): PRs link to the issues they name and close them only under the
// rules in services/pr-links.ts.

let A: Tenant;
let B: Tenant;
let boundProject: { id: string };
let otherProject: { id: string };
let cookie: string;
const REPO = `duketopceo/u17-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  A = await seedTenant("pr-a", "PRA");
  B = await seedTenant("pr-b", "PRB");
  boundProject = await mkProject(A);
  otherProject = await mkProject(A);
  await db.insert(githubRepos).values({
    workspaceId: A.ws.id,
    fullName: REPO,
    enabled: true,
    projectId: boundProject.id,
  });
  cookie = `tly_session=${await newSession(A, "member")}`;
});

const pr = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "a change",
  body: "",
  merged: false,
  draft: false,
  html_url: `https://github.com/${REPO}/pull/7`,
  head: { ref: "random-branch" },
  base: { ref: "main" },
  ...over,
});

const send = (action: string, p: object) =>
  processGithubEvent("pull_request", {
    action,
    pull_request: p,
    repository: { full_name: REPO, default_branch: "main" },
  });

const stateOf = async (id: string) =>
  (await db.select().from(issues).where(eq(issues.id, id)))[0]!.state;
const refsOf = (issueId: string) =>
  db
    .select()
    .from(issueExternalRefs)
    .where(and(eq(issueExternalRefs.issueId, issueId), eq(issueExternalRefs.system, "github_pr")));

describe("PR to issue mapping (real postgres)", () => {
  it("links a branch named with a lower-case key and keeps the lifecycle automation", async () => {
    const i = await mkIssue(A, { projectId: boundProject.id, state: "todo" });
    await send("opened", pr({ head: { ref: `${i.key.toLowerCase()}-fix` } }));
    expect(await stateOf(i.id)).toBe("in_progress");
    const refs = await refsOf(i.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.meta).toMatchObject({ repo: REPO, number: 7, state: "open" });
  });

  it("`Closes KEY` merged into the default branch of the bound repo marks the issue done", async () => {
    const i = await mkIssue(A, { projectId: boundProject.id, state: "in_progress" });
    await send("closed", pr({ merged: true, body: `Closes ${i.key}` }));
    expect(await stateOf(i.id)).toBe("done");
    expect((await refsOf(i.id))[0]!.meta).toMatchObject({ state: "merged" });
  });

  it("`Refs KEY` links without moving the issue", async () => {
    const i = await mkIssue(A, { projectId: boundProject.id, state: "in_progress" });
    await send("closed", pr({ merged: true, body: `Refs ${i.key}` }));
    expect(await stateOf(i.id)).toBe("in_progress");
    expect(await refsOf(i.id)).toHaveLength(1);
  });

  it("closes from a repo bound to a different project links but does not move", async () => {
    const i = await mkIssue(A, { projectId: otherProject.id, state: "in_progress" });
    await send("closed", pr({ merged: true, body: `Fixes ${i.key}` }));
    expect(await stateOf(i.id)).toBe("in_progress");
    expect(await refsOf(i.id)).toHaveLength(1);
  });

  it("a merge into a non-default branch links without moving", async () => {
    const i = await mkIssue(A, { projectId: boundProject.id, state: "in_progress" });
    await send("closed", pr({ merged: true, base: { ref: "release" }, body: `Closes ${i.key}` }));
    expect(await stateOf(i.id)).toBe("in_progress");
    expect(await refsOf(i.id)).toHaveLength(1);
  });

  it("a closed-unmerged PR links, records state closed, and does not move", async () => {
    const i = await mkIssue(A, { projectId: boundProject.id, state: "in_progress" });
    await send("closed", pr({ merged: false, body: `Closes ${i.key}` }));
    expect(await stateOf(i.id)).toBe("in_progress");
    expect((await refsOf(i.id))[0]!.meta).toMatchObject({ state: "closed" });
  });

  it("one PR naming two issues gets one ref row per issue", async () => {
    const a = await mkIssue(A, { projectId: boundProject.id, state: "in_progress" });
    const b = await mkIssue(A, { projectId: boundProject.id, state: "in_progress" });
    await send("closed", pr({ number: 8, merged: true, body: `Closes ${a.key}, ${b.key}` }));
    expect(await stateOf(a.id)).toBe("done");
    expect(await stateOf(b.id)).toBe("done");
    expect(await refsOf(a.id)).toHaveLength(1);
    expect(await refsOf(b.id)).toHaveLength(1);
  });

  it("ignores keys from another workspace", async () => {
    const foreign = await mkIssue(B, { state: "in_progress" });
    await send("closed", pr({ number: 9, merged: true, body: `Closes ${foreign.key}` }));
    expect(await stateOf(foreign.id)).toBe("in_progress");
    expect(await refsOf(foreign.id)).toHaveLength(0);
  });

  it("redelivery and state changes update one row", async () => {
    const i = await mkIssue(A, { projectId: boundProject.id, state: "in_progress" });
    const body = { number: 10, body: `Refs ${i.key}` };
    await send("opened", pr(body));
    await send("opened", pr(body));
    await send("closed", pr({ ...body, merged: true }));
    const refs = await refsOf(i.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.meta).toMatchObject({ number: 10, state: "merged" });
  });

  it("the issue detail lists its pull requests", async () => {
    const i = await mkIssue(A, { projectId: boundProject.id, state: "in_progress" });
    await send("opened", pr({ number: 11, title: "shows on the issue", body: `Refs ${i.key}` }));
    const res = await app.fetch(
      new Request(`http://api.test/v1/workspaces/${A.ws.slug}/issues/${i.key}`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pullRequests: { repo: string; number: number; state: string; url: string; title: string }[] };
    expect(body.pullRequests).toEqual([
      { repo: REPO, number: 11, state: "open", title: "shows on the issue", url: `https://github.com/${REPO}/pull/7` },
    ]);
  });
});
