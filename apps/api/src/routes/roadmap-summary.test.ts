import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { events, githubRepos, issues } from "../db/schema.js";
import { app } from "../index.js";
import { processGithubEvent } from "../services/github-automation.js";
import { mergedPrKeys } from "../services/pr-merge-events.js";
import { resolveSince, type RoadmapSummary } from "../services/roadmap-summary.js";
import { mkIssue, mkMilestone, mkProject, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// Roadmap summary: exact counts with no row cap, done-since, and the merge
// ticker that folds GitHub PR merges with done moves. Real Postgres.

let A: Tenant;
let B: Tenant;
let cookieA: string;
const REPO = `duketopceo/rm-${Math.random().toString(36).slice(2, 8)}`;
const HOUR = 3_600_000;

async function summary(t: Tenant, cookie: string, sinceMs = Date.now() - HOUR): Promise<RoadmapSummary> {
  const res = await app.fetch(
    new Request(
      `http://rm.test/v1/workspaces/${t.ws.slug}/roadmap/summary?since=${encodeURIComponent(new Date(sinceMs).toISOString())}`,
      { headers: { cookie } },
    ),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as RoadmapSummary;
}

beforeAll(async () => {
  A = await seedTenant("rm-a", "RMA");
  B = await seedTenant("rm-b", "RMB");
  cookieA = `tly_session=${await newSession(A, "member")}`;
  await db.insert(githubRepos).values({ workspaceId: A.ws.id, fullName: REPO, enabled: true });
});

const doneEvent = (t: Tenant, issueId: string, over: Partial<typeof events.$inferInsert> = {}) =>
  db.insert(events).values({
    workspaceId: t.ws.id,
    entityType: "issue",
    entityId: issueId,
    action: "state_changed",
    actorType: "human",
    actorId: t.people.owner.id,
    before: { state: "in_review" },
    after: { state: "done" },
    ...over,
  });

describe("GET /roadmap/summary", () => {
  it("counts every issue — no 200-row cap — and samples open work first", async () => {
    const p = await mkProject(A);
    await mkIssue(A, { projectId: p.id, state: "done" });
    const rows = Array.from({ length: 219 }, (_, i) => ({
      workspaceId: A.ws.id,
      teamId: A.team.id,
      key: `${A.team.key}-${900_000 + i}`,
      number: 900_000 + i,
      title: `bulk ${i}`,
      state: (i % 3 === 0 ? "in_progress" : i % 3 === 1 ? "todo" : "done") as "in_progress" | "todo" | "done",
      projectId: p.id,
    }));
    await db.insert(issues).values(rows);
    const s = await summary(A, cookieA);
    const ps = s.projects.find((x) => x.projectId === p.id)!;
    expect(ps.total).toBe(220);
    expect(ps.done).toBe(1 + 73);
    expect(ps.inProgress).toBe(73);
    expect(ps.byState.todo).toBe(73);
    expect(ps.recent).toHaveLength(15);
    expect(ps.recent.every((r) => r.state !== "done")).toBe(true);
    expect(s.totals.issues).toBeGreaterThanOrEqual(220);
  });

  it("counts done-since only for issues that are done now and moved inside the window", async () => {
    const p = await mkProject(A);
    const fresh = await mkIssue(A, { projectId: p.id, state: "done" });
    const old = await mkIssue(A, { projectId: p.id, state: "done" });
    const reopened = await mkIssue(A, { projectId: p.id, state: "in_progress" });
    await doneEvent(A, fresh.id);
    await doneEvent(A, fresh.id); // moved twice: still one issue
    await doneEvent(A, old.id, { createdAt: new Date(Date.now() - 5 * HOUR) });
    await doneEvent(A, reopened.id); // done event, but no longer done
    const s = await summary(A, cookieA);
    const ps = s.projects.find((x) => x.projectId === p.id)!;
    expect(ps.total).toBe(3);
    expect(ps.doneSince).toBe(1);
    expect(s.totals.doneSince).toBeGreaterThanOrEqual(1);
    // a wider window picks the older move up
    const wide = await summary(A, cookieA, Date.now() - 10 * HOUR);
    expect(wide.projects.find((x) => x.projectId === p.id)!.doneSince).toBe(2);
  });

  it("counts milestone progress", async () => {
    const p = await mkProject(A);
    const m = await mkMilestone(A, p.id);
    await mkIssue(A, { projectId: p.id, milestoneId: m.id, state: "done" });
    await mkIssue(A, { projectId: p.id, milestoneId: m.id, state: "todo" });
    const s = await summary(A, cookieA);
    expect(s.milestones.find((x) => x.milestoneId === m.id)).toEqual({ milestoneId: m.id, total: 2, done: 1 });
  });

  it("folds a PR merge and the done move into one ticker item", async () => {
    const p = await mkProject(A);
    const i = await mkIssue(A, { projectId: p.id, state: "done", title: "ship the ring" });
    await db.insert(events).values({
      workspaceId: A.ws.id,
      entityType: "issue",
      entityId: i.id,
      action: "pr_merged",
      actorType: "system",
      actorId: null,
      after: { pr: 42, url: "https://github.com/x/y/pull/42", title: `ring (${i.key})`, author: "duketopceo", repo: "x/y" },
    });
    await doneEvent(A, i.id);
    const s = await summary(A, cookieA);
    const items = s.merges.filter((m) => m.issueKey === i.key);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      issueTitle: "ship the ring",
      projectId: p.id,
      actorType: "human",
      pr: { number: 42, url: "https://github.com/x/y/pull/42", repo: "x/y" },
    });
    expect(items[0]!.actorName).toContain("owner");
  });

  it("falls back to the PR author when only the webhook spoke", async () => {
    const i = await mkIssue(A, { state: "in_review" });
    await db.insert(events).values({
      workspaceId: A.ws.id,
      entityType: "issue",
      entityId: i.id,
      action: "pr_merged",
      actorType: "system",
      after: { pr: 9, url: "https://github.com/x/y/pull/9", author: "octocat" },
    });
    const s = await summary(A, cookieA);
    const it = s.merges.find((m) => m.issueKey === i.key)!;
    expect(it.actorName).toBe("octocat");
    expect(it.pr?.number).toBe(9);
  });

  it("never leaks another workspace", async () => {
    const pb = await mkProject(B);
    const ib = await mkIssue(B, { projectId: pb.id, state: "done" });
    await doneEvent(B, ib.id);
    const s = await summary(A, cookieA);
    expect(s.projects.find((x) => x.projectId === pb.id)).toBeUndefined();
    expect(s.merges.find((m) => m.issueKey === ib.key)).toBeUndefined();
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await app.fetch(new Request(`http://rm.test/v1/workspaces/${A.ws.slug}/roadmap/summary`));
    expect(res.status).toBe(401);
  });
});

describe("merged PR → pr_merged event", () => {
  const merged = (over: Record<string, unknown>) => ({
    action: "closed",
    pull_request: {
      number: 77,
      merged: true,
      title: "a change",
      html_url: `https://github.com/${REPO}/pull/77`,
      head: { ref: "random-branch" },
      user: { login: "duketopceo" },
      ...over,
    },
    repository: { full_name: REPO, default_branch: "main" },
  });
  const countFor = async (issueId: string) =>
    (await db.select().from(events).where(eq(events.entityId, issueId))).filter((e) => e.action === "pr_merged");

  it("links a merge to the ticket named as (KEY-n) in the title, once, even on redelivery", async () => {
    const i = await mkIssue(A, { state: "in_progress" });
    await processGithubEvent("pull_request", merged({ title: `speed budget (${i.key})` }));
    await processGithubEvent("pull_request", merged({ title: `speed budget (${i.key})` }));
    const rows = await countFor(i.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ pr: 77, author: "duketopceo", repo: REPO, title: `speed budget (${i.key})` });
    const s = await summary(A, cookieA);
    expect(s.merges.find((m) => m.issueKey === i.key)?.pr?.url).toBe(`https://github.com/${REPO}/pull/77`);
  });

  it("links by branch key too, and ignores unmerged closes and unknown keys", async () => {
    const i = await mkIssue(A, { state: "in_progress" });
    await processGithubEvent("pull_request", merged({ head: { ref: `${i.key.toLowerCase()}-fix` }, html_url: `https://github.com/${REPO}/pull/78` }));
    expect(await countFor(i.id)).toHaveLength(1);

    const j = await mkIssue(A, { state: "in_progress" });
    await processGithubEvent("pull_request", merged({ merged: false, title: `nope (${j.key})` }));
    await processGithubEvent("pull_request", merged({ title: "no such (ZZZ-99999999)" }));
    expect(await countFor(j.id)).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("mergedPrKeys reads the branch and every (KEY-n) in the title", () => {
    expect(mergedPrKeys("tly-12-fix", "feat (TLY-12) and (WSP-3)")).toEqual(["TLY-12", "WSP-3"]);
    expect(mergedPrKeys("main", "no keys, TLY-5 bare")).toEqual([]);
  });

  it("resolveSince defaults to 24h and clamps to 31 days", () => {
    const now = Date.UTC(2026, 9, 28, 12);
    expect(resolveSince(undefined, now).getTime()).toBe(now - 24 * HOUR);
    expect(resolveSince("garbage", now).getTime()).toBe(now - 24 * HOUR);
    expect(resolveSince(new Date(now - 90 * 24 * HOUR).toISOString(), now).getTime()).toBe(now - 31 * 24 * HOUR);
    expect(resolveSince(new Date(now + HOUR).toISOString(), now).getTime()).toBe(now);
  });
});
