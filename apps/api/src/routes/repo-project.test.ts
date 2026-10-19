import { createHmac } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  comments,
  cycleVelocity,
  cycles,
  events,
  githubInstallations,
  githubIssueLinks,
  githubRepos,
  githubWebhookEvents,
  issueLabels,
  issues,
  labels,
  projects,
  teams,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { createIssue } from "../services/issues.js";
import { useFrozenClock } from "../../test/clock.js";

useFrozenClock();

const SECRET = "test-webhook-secret";
const SLUG = "rp";
const OTHER_SLUG = "rp-other";
const KATE = "duketopceo/kate";
const KATE_IOS = "duketopceo/kate-ios";
const LOOSE = "duketopceo/unmapped";

interface RepoRow { fullName: string; assign: number }
interface Body {
  id: string;
  projectId: string | null;
  applied: boolean;
  updated: number;
  repos: RepoRow[];
  unmapped: { fullName: string }[];
  totals: { assign: number };
}

let cookie = "";
let wsId = "";
let otherWsId = "";
let teamId = "";
let kateProject = "";
let otherProject = "";
let otherWsIssue = "";
const repoRows: Record<string, string> = {};

async function req(path: string, init?: RequestInit, c = cookie) {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: { "content-type": "application/json", cookie: c, ...(init?.headers as Record<string, string>) },
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}
const post = (path: string, body: unknown, c = cookie) =>
  req(`/v1/workspaces/${SLUG}${path}`, { method: "POST", body: JSON.stringify(body) }, c);

let delivery = 0;
async function deliver(repo: string, ghId: number, title: string) {
  const body = JSON.stringify({
    action: "opened",
    issue: { id: ghId, number: ghId, title, body: "b", html_url: `https://github.com/${repo}/issues/${ghId}`, user: { login: "r" } },
    repository: { full_name: repo },
  });
  const sig = `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
  const res = await app.fetch(
    new Request("http://api.test/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig, "x-github-event": "issues", "x-github-delivery": `rp-${++delivery}` },
      body,
    }),
  );
  expect(res.status).toBe(200);
  const [link] = await db.select().from(githubIssueLinks).where(eq(githubIssueLinks.ghIssueId, ghId));
  const [issue] = await db.select().from(issues).where(eq(issues.id, link!.issueId));
  return issue!;
}

// an already-synced issue (what the 125 backfill targets look like): linked, no project
async function legacyIssue(repo: string, ghId: number, projectId: string | null = null) {
  const issue = await createIssue({ workspaceId: wsId, teamId, title: `legacy ${ghId}`, source: "github", creator: { type: "system" } as never, state: "backlog" });
  if (projectId) await db.update(issues).set({ projectId }).where(eq(issues.id, issue.id));
  await db.insert(githubIssueLinks).values({ workspaceId: wsId, repoId: repoRows[repo]!, ghIssueId: ghId, ghIssueNumber: ghId, issueId: issue.id, ghState: "open" });
  return issue.id;
}
const projectOf = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!.projectId;

async function wipe() {
  for (const slug of [SLUG, OTHER_SLUG]) {
    const [w] = await db.select().from(workspaces).where(eq(workspaces.slug, slug));
    if (!w) continue;
    await db.delete(users).where(sql`${users.id} in (select ${workspaceMembers.userId} from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${w.id})`).catch(() => {});
  }
}

beforeAll(async () => {
  await runMigrations();
  const boot = async (slug: string, key: string) => {
    const res = await app.fetch(
      new Request("http://api.test/v1/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug: slug, workspaceName: slug, teamKey: key, email: `${slug}@test.dev`, name: slug, password: "pw-long-enough" }),
      }),
    );
    expect(res.status).toBe(201);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  cookie = await boot(SLUG, "RP");
  wsId = (await db.select().from(workspaces).where(eq(workspaces.slug, SLUG)))[0]!.id;
  // bootstrap only works once per instance: the foreign tenant is a direct insert
  otherWsId = (await db.insert(workspaces).values({ slug: OTHER_SLUG, name: OTHER_SLUG }).returning())[0]!.id;
  await db.insert(teams).values({ workspaceId: otherWsId, key: "RO", name: "Other" });
  teamId = (await db.select().from(teams).where(eq(teams.workspaceId, wsId)))[0]!.id;
  const otherTeam = (await db.select().from(teams).where(eq(teams.workspaceId, otherWsId)))[0]!.id;

  kateProject = (await db.insert(projects).values({ workspaceId: wsId, name: "Kate" }).returning())[0]!.id;
  otherProject = (await db.insert(projects).values({ workspaceId: otherWsId, name: "Foreign" }).returning())[0]!.id;
  otherWsIssue = (await createIssue({ workspaceId: otherWsId, teamId: otherTeam, title: "foreign", creator: { type: "system" } as never, state: "backlog" })).id;

  await db.insert(githubInstallations).values({ workspaceId: wsId, installationId: 7001, accountLogin: "duketopceo" });
  for (const full of [KATE, KATE_IOS, LOOSE]) {
    const r = await post("/github/repos/connect", { fullName: full, teamKey: "RP" });
    expect(r.status).toBe(200);
    repoRows[full] = r.body.id;
  }
});

afterAll(async () => {
  for (const id of [wsId, otherWsId]) {
    for (const t of [comments, events, issueLabels, githubIssueLinks, issues, labels, cycleVelocity, cycles, githubRepos, githubInstallations, projects] as const) {
      await db.delete(t as never).where(eq((t as unknown as { workspaceId: AnyPgColumn }).workspaceId, id)).catch(() => {});
    }
  }
  await db.delete(githubWebhookEvents);
  await wipe();
  await closeDb();
});

describe("repo-to-project binding", () => {
  it("binds a repo to a project in the workspace and can unbind", async () => {
    const r = await post("/github/repos/project", { fullName: KATE, projectId: kateProject });
    expect(r.status).toBe(200);
    expect(r.body.projectId).toBe(kateProject);
    const un = await post("/github/repos/project", { fullName: KATE, projectId: null });
    expect(un.body.projectId).toBeNull();
    await post("/github/repos/project", { fullName: KATE, projectId: kateProject });
  });

  it("refuses another workspace's project and unknown repos", async () => {
    expect((await post("/github/repos/project", { fullName: KATE, projectId: otherProject })).status).toBe(422);
    expect((await post("/github/repos/project", { fullName: "x/none", projectId: kateProject })).status).toBe(404);
  });

  it("a synced issue from a mapped repo lands in the project; an unmapped repo's stays unassigned", async () => {
    const mapped = await deliver(KATE, 9001, "mapped");
    expect(mapped.projectId).toBe(kateProject);
    const loose = await deliver(LOOSE, 9002, "loose");
    expect(loose.projectId).toBeNull();
  });

  it("the project is deleted: repo binding clears, intake still works", async () => {
    const tmp = (await db.insert(projects).values({ workspaceId: wsId, name: "Tmp" }).returning())[0]!.id;
    await post("/github/repos/project", { fullName: KATE_IOS, projectId: tmp });
    await db.delete(projects).where(eq(projects.id, tmp));
    const [row] = await db.select().from(githubRepos).where(eq(githubRepos.id, repoRows[KATE_IOS]!));
    expect(row!.projectId).toBeNull();
  });
});

describe("backfill", () => {
  it("dry run changes nothing; apply assigns only unassigned issues; rerun is a no-op", async () => {
    const a = await legacyIssue(KATE, 8001);
    const b = await legacyIssue(KATE_IOS, 8002);
    const looseId = await legacyIssue(LOOSE, 8003);
    const sticky = await legacyIssue(KATE, 8004, (await db.insert(projects).values({ workspaceId: wsId, name: "Other" }).returning())[0]!.id);
    const stickyBefore = await projectOf(sticky);
    const map = { [KATE]: kateProject, [KATE_IOS]: kateProject };

    const dry = await post("/github/repos/backfill", { map });
    expect(dry.status).toBe(200);
    expect(dry.body.applied).toBe(false);
    expect(await projectOf(a)).toBeNull();
    expect(await projectOf(b)).toBeNull();
    const byRepo = Object.fromEntries(dry.body.repos.map((r) => [r.fullName, r]));
    expect(byRepo[KATE]!.assign).toBe(1); // 8001 only: 8004 already has a project, 9001 intake was mapped
    expect(byRepo[KATE_IOS]!.assign).toBe(1);
    expect(dry.body.unmapped.map((r) => r.fullName)).toContain(LOOSE);
    const [repoRow] = await db.select().from(githubRepos).where(eq(githubRepos.id, repoRows[KATE_IOS]!));
    expect(repoRow!.projectId).toBeNull(); // dry run did not bind the repo either

    const applied = await post("/github/repos/backfill", { map, apply: true });
    expect(applied.body.applied).toBe(true);
    expect(await projectOf(a)).toBe(kateProject);
    expect(await projectOf(b)).toBe(kateProject);
    expect(await projectOf(looseId)).toBeNull();
    expect(await projectOf(sticky)).toBe(stickyBefore);
    const [bound] = await db.select().from(githubRepos).where(eq(githubRepos.id, repoRows[KATE_IOS]!));
    expect(bound!.projectId).toBe(kateProject);

    const again = await post("/github/repos/backfill", { map, apply: true });
    expect(again.body.totals.assign).toBe(0);
  });

  it("rejects a map naming another workspace's project or an unlinked repo", async () => {
    expect((await post("/github/repos/backfill", { map: { [KATE]: otherProject } })).status).toBe(422);
    expect((await post("/github/repos/backfill", { map: { "x/none": kateProject } })).status).toBe(404);
  });
});

describe("bulk issue update", () => {
  const bulk = (body: unknown) => post("/issues/bulk", body);

  it("sets the project and adds labels for up to 200 ids", async () => {
    const id = await legacyIssue(LOOSE, 7001);
    const label = (await db.insert(labels).values({ workspaceId: wsId, name: "bulk-l", color: "#000000" }).returning())[0]!.id;
    const r = await bulk({ ids: [id], projectId: kateProject, addLabelIds: [label] });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(1);
    expect(await projectOf(id)).toBe(kateProject);
    expect((await db.select().from(issueLabels).where(eq(issueLabels.issueId, id))).length).toBe(1);
  });

  it("refuses more than 200 ids", async () => {
    const ids = Array.from({ length: 201 }, () => crypto.randomUUID());
    expect((await bulk({ ids, projectId: kateProject })).status).toBeGreaterThanOrEqual(400);
  });

  it("refuses another workspace's issues and project, changing nothing", async () => {
    const mine = await legacyIssue(LOOSE, 7002);
    const r = await bulk({ ids: [mine, otherWsIssue], projectId: kateProject });
    expect(r.status).toBe(404);
    expect(await projectOf(mine)).toBeNull();
    expect((await bulk({ ids: [mine], projectId: otherProject })).status).toBe(422);
    expect((await db.select().from(issues).where(inArray(issues.id, [otherWsIssue])))[0]!.projectId).toBeNull();
  });
});
