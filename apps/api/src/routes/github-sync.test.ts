import { createHmac, generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  comments,
  cycleVelocity,
  cycles,
  events,
  githubIssueLinks,
  githubInstallations,
  githubRepos,
  githubWebhookEvents,
  issueLabels,
  issues,
  labels,
  projects,
  sessions,
  teams,
  users,
  workspaces,
} from "../db/schema.js";
import {
  configureGithubApp,
  mirrorIssueLabels,
  resetGithubSync,
  setGithubApiFetcher,
} from "../services/github-sync.js";

const SECRET = "test-webhook-secret";
const SLUG = `gs-${Date.now()}`;
const REPO = { full_name: "duketopceo/docketry" };
const INSTALLATION_ID = 4242;
const APP_ID = "99999";
const APP_BOT = "docketry-test[bot]"; // vitest.config GITHUB_APP_SLUG + [bot]

let sessionCookie = "";
let workspaceId = "";

// real RSA keypair — the App JWT is genuinely signed; the mock transport
// never leaves the process
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

interface GhCall {
  url: string;
  method: string;
  body?: Record<string, unknown> | undefined;
  auth?: string | undefined;
}
let ghCalls: GhCall[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// injected GitHub API transport — records every call; token exchange gets a
// canned token, repo-label creates return 422 (already exists), the rest 200
const mockGhFetcher = async (
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  ghCalls.push({
    url,
    method: init?.method ?? "GET",
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
    auth: headers.authorization,
  });
  if (url.includes("/access_tokens")) {
    return json(
      { token: "test-installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      201,
    );
  }
  if (url.endsWith("/labels") && init?.method === "POST") {
    return json({ message: "Validation Failed" }, 422);
  }
  return json({ id: 1, number: 1 });
};

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

let deliveryCounter = 0;
async function deliver(event: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ ...payload, repository: REPO });
  const res = await app.fetch(
    new Request("http://api.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
        "x-github-event": event,
        "x-github-delivery": `gs-${++deliveryCounter}`,
      },
      body,
    }),
  );
  expect(res.status).toBe(200);
}

async function req(path: string, init?: RequestInit) {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
        ...(init?.headers as Record<string, string>),
      },
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const apiCalls = () => ghCalls.filter((c) => !c.url.includes("access_tokens"));
const tokenCalls = () => ghCalls.filter((c) => c.url.includes("access_tokens"));

// deliver issues.opened → returns the linked docketry issue row
async function intakeIssue(ghIssueId: number, ghNumber: number, title: string) {
  await deliver("issues", {
    action: "opened",
    issue: {
      id: ghIssueId,
      number: ghNumber,
      title,
      body: `gh body ${ghNumber}`,
      html_url: `https://github.com/${REPO.full_name}/issues/${ghNumber}`,
      user: { login: "reporter" },
    },
  });
  const [link] = await db
    .select()
    .from(githubIssueLinks)
    .where(eq(githubIssueLinks.ghIssueId, ghIssueId))
    .limit(1);
  expect(link).toBeDefined();
  const [issue] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, link!.issueId))
    .limit(1);
  return { link: link!, issue: issue! };
}

async function getIssue(id: string) {
  const [row] = await db.select().from(issues).where(eq(issues.id, id));
  return row!;
}

const ghIssue = (id: number, number: number, extra: Record<string, unknown> = {}) => ({
  id,
  number,
  title: `gh issue ${number}`,
  body: `gh body ${number}`,
  html_url: `https://github.com/${REPO.full_name}/issues/${number}`,
  ...extra,
});

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    comments,
    events,
    issueLabels,
    githubIssueLinks,
    issues,
    labels,
    cycleVelocity,
    cycles,
    projects,
    sessions,
    githubWebhookEvents,
    githubRepos,
    githubInstallations,
    users,
    teams,
  ] as const) {
    await db.delete(t);
  }
  await db.delete(workspaces);

  const res = await app.fetch(
    new Request("http://api.test/v1/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceSlug: SLUG,
        workspaceName: "GH Sync",
        teamKey: "GS",
        email: "gs@test.dev",
        name: "GS User",
        password: "pw-long-enough",
      }),
    }),
  );
  expect(res.status).toBe(201);
  sessionCookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, SLUG));
  workspaceId = ws!.id;

  // bind an installation + enable the repo (installationId needed for
  // outbound auth — manually-connected repos can't call the GH API)
  await db.insert(githubInstallations).values({
    workspaceId,
    installationId: INSTALLATION_ID,
    accountLogin: "duketopceo",
  });
  await req(`/v1/workspaces/${SLUG}/github/repos/connect`, {
    method: "POST",
    body: JSON.stringify({ fullName: REPO.full_name, teamKey: "GS" }),
  });
  await db
    .update(githubRepos)
    .set({ installationId: INSTALLATION_ID })
    .where(
      and(
        eq(githubRepos.workspaceId, workspaceId),
        eq(githubRepos.fullName, REPO.full_name),
      ),
    );
});

beforeEach(() => {
  resetGithubSync();
  ghCalls = [];
  setGithubApiFetcher(mockGhFetcher);
  configureGithubApp({ appId: APP_ID, privateKey: APP_PRIVATE_KEY });
});

afterAll(async () => {
  resetGithubSync();
  // issue_labels cascades via issues; github_webhook_events has no
  // workspace scoping — wiped globally below
  for (const t of [
    comments,
    events,
    githubIssueLinks,
    issues,
    labels,
    sessions,
    githubRepos,
    githubInstallations,
    users,
    teams,
  ] as const) {
    await db.delete(t).where(eq(t.workspaceId, workspaceId));
  }
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(githubWebhookEvents);
  await closeDb();
});

describe("inbound: issues events on linked issues", () => {
  it("closed with state_reason=completed walks to done — and does NOT echo back", async () => {
    const { issue, link } = await intakeIssue(5001, 101, "close me done");
    expect(issue.state).toBe("triage");

    await deliver("issues", {
      action: "closed",
      issue: ghIssue(5001, 101, { state: "closed", state_reason: "completed" }),
      sender: { login: "octocat", type: "User" },
    });

    expect((await getIssue(issue.id)).state).toBe("done");
    const [l] = await db
      .select()
      .from(githubIssueLinks)
      .where(eq(githubIssueLinks.id, link.id));
    expect(l!.ghState).toBe("closed");

    const evs = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, issue.id), eq(events.action, "state_changed")));
    const last = evs.at(-1)!.after as { state: string; via?: string };
    expect(last.state).toBe("done");
    expect(last.via).toBe("github");

    // loop prevention: the inbound close must not fire a GH API call
    await sleep(150);
    expect(apiCalls()).toHaveLength(0);
  });

  it("closed without a reason maps to canceled", async () => {
    const { issue } = await intakeIssue(5002, 102, "close me canceled");
    await deliver("issues", {
      action: "closed",
      issue: ghIssue(5002, 102, { state: "closed", state_reason: "not_planned" }),
      sender: { login: "octocat" },
    });
    expect((await getIssue(issue.id)).state).toBe("canceled");
    await sleep(150);
    expect(apiCalls()).toHaveLength(0);
  });

  it("reopened on a terminal issue logs sync_conflict and does not move it", async () => {
    const { issue } = await intakeIssue(5003, 103, "reopen me");
    await deliver("issues", {
      action: "closed",
      issue: ghIssue(5003, 103, { state: "closed", state_reason: "completed" }),
      sender: { login: "octocat" },
    });
    expect((await getIssue(issue.id)).state).toBe("done");

    await deliver("issues", {
      action: "reopened",
      issue: ghIssue(5003, 103, { state: "open" }),
      sender: { login: "octocat" },
    });
    // terminal states have no exits — drift is surfaced, never forced
    expect((await getIssue(issue.id)).state).toBe("done");
    const conflicts = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, issue.id), eq(events.action, "sync_conflict")));
    expect(conflicts).toHaveLength(1);
    const after = conflicts[0]!.after as { kind: string; local: string; remote: string };
    expect(after).toMatchObject({ kind: "state", local: "done", remote: "open" });
  });

  it("edited mirrors title + body (with provenance footer kept single)", async () => {
    const { issue } = await intakeIssue(5004, 104, "old title");
    await deliver("issues", {
      action: "edited",
      issue: ghIssue(5004, 104, { title: "new title", body: "revised body" }),
      changes: { title: { from: "old title" }, body: { from: "gh body 104" } },
      sender: { login: "octocat" },
    });
    const updated = await getIssue(issue.id);
    expect(updated.title).toBe("new title");
    expect(updated.description).toBe(
      `revised body\n\n---\nGitHub: https://github.com/${REPO.full_name}/issues/104`,
    );
    const evs = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, issue.id), eq(events.action, "edited")));
    expect(evs).toHaveLength(1);
    expect((evs[0]!.after as { via?: string }).via).toBe("github");
  });

  it("edited on a locally-diverged field applies remote + logs sync_conflict", async () => {
    const { issue } = await intakeIssue(5005, 105, "original title");
    // local rename diverges from what GH thinks the title was
    const patch = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "local rename" }),
    });
    expect(patch.status).toBe(200);

    await deliver("issues", {
      action: "edited",
      issue: ghIssue(5005, 105, { title: "remote rename" }),
      changes: { title: { from: "original title" } },
      sender: { login: "octocat" },
    });
    expect((await getIssue(issue.id)).title).toBe("remote rename");
    const conflicts = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, issue.id), eq(events.action, "sync_conflict")));
    expect(conflicts).toHaveLength(1);
    const fields = (conflicts[0]!.after as { fields: { field: string; local: string; remote: string }[] }).fields;
    expect(fields[0]).toMatchObject({
      field: "title",
      local: "local rename",
      remote: "remote rename",
    });
  });

  it("labeled creates + attaches a missing docketry label; unlabeled detaches", async () => {
    const { issue } = await intakeIssue(5006, 106, "label me");
    await deliver("issues", {
      action: "labeled",
      issue: ghIssue(5006, 106),
      label: { name: "bug", color: "d73a4a" },
      sender: { login: "octocat" },
    });
    const [label] = await db
      .select()
      .from(labels)
      .where(and(eq(labels.workspaceId, workspaceId), eq(labels.name, "bug")));
    expect(label!.color).toBe("#d73a4a");
    const attached = await db
      .select()
      .from(issueLabels)
      .where(eq(issueLabels.issueId, issue.id));
    expect(attached.map((r) => r.labelId)).toContain(label!.id);

    await deliver("issues", {
      action: "unlabeled",
      issue: ghIssue(5006, 106),
      label: { name: "bug" },
      sender: { login: "octocat" },
    });
    const after = await db
      .select()
      .from(issueLabels)
      .where(eq(issueLabels.issueId, issue.id));
    expect(after).toHaveLength(0);
    const evs = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, issue.id), eq(events.action, "label_removed")));
    expect(evs).toHaveLength(1);
  });

  it("events for unlinked GH issues are ignored", async () => {
    await deliver("issues", {
      action: "closed",
      issue: ghIssue(5999, 999, { state: "closed" }),
      sender: { login: "octocat" },
    });
    const links = await db
      .select()
      .from(githubIssueLinks)
      .where(eq(githubIssueLinks.ghIssueId, 5999));
    expect(links).toHaveLength(0);
    const created = await db
      .select()
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.title, "gh issue 999")));
    expect(created).toHaveLength(0);
  });
});

describe("inbound: issue_comment events", () => {
  it("created mirrors the comment with GH author provenance + via=github", async () => {
    const { issue } = await intakeIssue(5101, 111, "comment target");
    await deliver("issue_comment", {
      action: "created",
      issue: ghIssue(5101, 111),
      comment: {
        id: 777001,
        body: "looking into this",
        html_url: "https://github.com/x",
        user: { login: "octocat" },
      },
      sender: { login: "octocat" },
    });
    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("**@octocat** via GitHub:\n\nlooking into this");
    expect(rows[0]!.via).toBe("github");
    // inbound comments never echo back out
    await sleep(150);
    expect(apiCalls()).toHaveLength(0);
  });

  it("drops our own mirrored comments (docketry marker)", async () => {
    const { issue } = await intakeIssue(5102, 112, "echo target");
    await deliver("issue_comment", {
      action: "created",
      issue: ghIssue(5102, 112),
      comment: {
        id: 777002,
        body: "**[docketry]**\n\nthis came from us",
        html_url: "https://github.com/x",
        user: { login: "someone" },
      },
      sender: { login: "someone" },
    });
    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue.id));
    expect(rows).toHaveLength(0);
  });

  it("drops deliveries sent by the app bot", async () => {
    const { issue } = await intakeIssue(5103, 113, "bot echo");
    await deliver("issues", {
      action: "closed",
      issue: ghIssue(5103, 113, { state: "closed" }),
      sender: { login: APP_BOT, type: "Bot" },
    });
    expect((await getIssue(issue.id)).state).toBe("triage");
    await deliver("issue_comment", {
      action: "created",
      issue: ghIssue(5103, 113),
      comment: { id: 777003, body: "bot comment", html_url: "x" },
      sender: { login: APP_BOT, type: "Bot" },
    });
    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue.id));
    expect(rows).toHaveLength(0);
  });

  it("ignores comments on PR threads", async () => {
    const { issue } = await intakeIssue(5104, 114, "pr thread");
    await deliver("issue_comment", {
      action: "created",
      issue: { ...ghIssue(5104, 114), pull_request: { url: "x" } },
      comment: { id: 777004, body: "pr comment", html_url: "x", user: { login: "octocat" } },
      sender: { login: "octocat" },
    });
    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue.id));
    expect(rows).toHaveLength(0);
  });
});

describe("outbound: docketry → github mirror", () => {
  it("terminal transition PATCHes the GH issue closed with reason", async () => {
    const { issue, link } = await intakeIssue(5201, 121, "mirror close");
    const move = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "canceled" }),
    });
    expect(move.status).toBe(200);

    await vi.waitFor(() => expect(apiCalls().length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const patch = apiCalls().find(
      (c) => c.method === "PATCH" && c.url.endsWith(`/repos/${REPO.full_name}/issues/121`),
    );
    expect(patch).toBeDefined();
    expect(patch!.body).toEqual({ state: "closed", state_reason: "not_planned" });
    expect(patch!.auth).toBe("Bearer test-installation-token");

    // token exchange happened once, JWT-signed
    expect(tokenCalls()).toHaveLength(1);
    const jwt = tokenCalls()[0]!.auth!.replace("Bearer ", "");
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1]!, "base64url").toString(),
    ) as { iss: string };
    expect(payload.iss).toBe(APP_ID);

    const [l] = await db
      .select()
      .from(githubIssueLinks)
      .where(eq(githubIssueLinks.id, link.id));
    expect(l!.ghState).toBe("closed");
  });

  it("non-terminal transitions on an open GH issue skip the API entirely", async () => {
    const { issue } = await intakeIssue(5202, 122, "no-op mirror");
    const move = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "backlog" }),
    });
    expect(move.status).toBe(200);
    await sleep(200);
    expect(ghCalls).toHaveLength(0);
  });

  it("reopens a GH issue when local leaves a stale closed link state", async () => {
    const { issue, link } = await intakeIssue(5203, 123, "reopen mirror");
    // simulate drift: GH side closed while local stayed open
    await db
      .update(githubIssueLinks)
      .set({ ghState: "closed" })
      .where(eq(githubIssueLinks.id, link.id));
    const move = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "backlog" }),
    });
    expect(move.status).toBe(200);
    await vi.waitFor(() => expect(apiCalls().length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const patch = apiCalls().find((c) => c.method === "PATCH");
    expect(patch!.body).toEqual({ state: "open" });
  });

  it("comments POST to the linked GH issue with the docketry marker", async () => {
    const { issue } = await intakeIssue(5204, 124, "comment mirror");
    const res = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "shipping this tomorrow" }),
    });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(apiCalls().length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const post = apiCalls().find((c) => c.url.endsWith("/issues/124/comments"));
    expect(post).toBeDefined();
    expect((post!.body as { body: string }).body).toBe(
      "**[docketry]**\n\nshipping this tomorrow",
    );
  });

  it("comments on unlinked issues make no GH calls", async () => {
    const created = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "plain local issue" }),
    });
    expect(created.status).toBe(201);
    const res = await req(
      `/v1/workspaces/${SLUG}/issues/${(created.body as { key: string }).key}/comments`,
      { method: "POST", body: JSON.stringify({ body: "internal note" }) },
    );
    expect(res.status).toBe(201);
    await sleep(200);
    expect(ghCalls).toHaveLength(0);
  });

  it("label mirror ensures + adds labels on the GH issue", async () => {
    const { issue } = await intakeIssue(5205, 125, "label mirror");
    const [label] = await db
      .insert(labels)
      .values({ workspaceId, name: "gh-synced", color: "#a1b2c3" })
      .returning();
    await db
      .insert(issueLabels)
      .values({ issueId: issue.id, labelId: label!.id });

    await mirrorIssueLabels(issue.id);
    const create = apiCalls().find((c) =>
      c.url.endsWith(`/repos/${REPO.full_name}/labels`),
    );
    expect(create).toBeDefined();
    expect(create!.body).toMatchObject({ name: "gh-synced", color: "a1b2c3" });
    const add = apiCalls().find((c) => c.url.endsWith("/issues/125/labels"));
    expect(add).toBeDefined();
    expect((add!.body as { labels: string[] }).labels).toContain("gh-synced");
  });

  it("a failed GH call lands on the timeline as github_sync_failed", async () => {
    const { issue } = await intakeIssue(5206, 126, "failure path");
    setGithubApiFetcher(async () => json({ message: "boom" }, 500));
    await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "canceled" }),
    });
    await vi.waitFor(async () => {
      const evs = await db
        .select()
        .from(events)
        .where(and(eq(events.entityId, issue.id), eq(events.action, "github_sync_failed")));
      expect(evs.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it("does nothing without app credentials configured", async () => {
    const { issue } = await intakeIssue(5207, 127, "no creds");
    configureGithubApp({ appId: "", privateKey: "" });
    await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "canceled" }),
    });
    await sleep(200);
    expect(ghCalls).toHaveLength(0);
  });
});
