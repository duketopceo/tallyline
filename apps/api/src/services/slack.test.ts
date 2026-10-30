import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  agentKeys,
  agents,
  comments,
  cycles,
  cycleVelocity,
  dispatches,
  dispatchEvents,
  events,
  githubInstallations,
  githubIssueLinks,
  githubRepos,
  githubWebhookEvents,
  issues,
  labels,
  projects,
  sessions,
  slackLinks,
  teams,
  users,
  userTokens,
  views,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
} from "../db/schema.js";
import { verifySlackSignature } from "../lib/slack.js";
import { createSlack } from "./slack.js";
import type { FetchLike } from "./llm.js";
import { NOW, useFrozenClock } from "../../test/clock.js";

useFrozenClock();

const SLUG = "slack-test";
const SECRET = "test-slack-secret";
let cookie = "";

const ALL_TABLES = [
  comments,
  events,
  githubIssueLinks,
  webhookDeliveries,
  webhookEndpoints,
  dispatchEvents,
  dispatches,
  slackLinks,
  issues,
  labels,
  agentKeys,
  agents,
  userTokens,
  views,
  cycleVelocity,
  cycles,
  projects,
  sessions,
  githubWebhookEvents,
  githubRepos,
  githubInstallations,
  users,
  teams,
] as const;

// records every Slack Web API call a flow makes
const calls: { method: string; body: Record<string, unknown> }[] = [];
const fakeSlack: FetchLike = async (url, init) => {
  const method = url.split("/").pop()!;
  const body = JSON.parse((init?.body as string | undefined) ?? "{}") as Record<
    string,
    unknown
  >;
  calls.push({ method, body });
  const payload: Record<string, unknown> = { ok: true };
  if (method === "conversations.replies") {
    payload.messages = [
      { user: "U1", text: "the export CSV crashes on empty columns" },
      { user: "U2", text: "repro: export with no rows selected" },
    ];
  }
  if (method === "chat.postMessage") payload.ts = "1700.0001";
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

function slackReq(body: string, contentType: string) {
  const ts = `${Math.floor(NOW / 1000)}`;
  const sig =
    "v0=" +
    createHmac("sha256", SECRET)
      .update(`v0:${ts}:${body}`)
      .digest("hex");
  return app.fetch(
    new Request("http://t/webhooks/slack", {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sig,
      },
      body,
    }),
  );
}

beforeAll(async () => {
  await runMigrations();
  for (const t of ALL_TABLES) await db.delete(t);
  await db.delete(workspaces);

  const res = await app.fetch(
    new Request("http://t/v1/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceSlug: SLUG,
        workspaceName: "Slack Test",
        teamKey: "SL",
        email: "s@t.dev",
        name: "Slacker",
        password: "pw-long-enough",
      }),
    }),
  );
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  for (const t of ALL_TABLES) await db.delete(t);
  await db.delete(workspaces);
  await closeDb();
});

describe("verifySlackSignature", () => {
  it("accepts a fresh valid signature, rejects stale/tampered", () => {
    const body = "type=event_callback";
    const ts = `${Math.floor(NOW / 1000)}`;
    const good =
      "v0=" +
      createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
    expect(verifySlackSignature(body, ts, good, SECRET)).toBe(true);
    expect(verifySlackSignature(body, ts, "v0=deadbeef", SECRET)).toBe(false);
    expect(verifySlackSignature(body, "1", good, SECRET)).toBe(false);
  });
});

describe("slack receiver", () => {
  it("answers url_verification and rejects bad signatures", async () => {
    const ok = await slackReq(
      JSON.stringify({ type: "url_verification", challenge: "abc123" }),
      "application/json",
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { challenge: string }).challenge).toBe("abc123");

    const res = await app.fetch(
      new Request("http://t/webhooks/slack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("/docket <title> creates a triage issue with slack link", async () => {
    const form = new URLSearchParams({
      command: "/docket",
      text: "CSV export crashes on empty cols",
      channel_id: "C123",
      user_id: "U9",
      user_name: "ada",
      trigger_id: "t1",
    });
    const res = await slackReq(form.toString(), "application/x-www-form-urlencoded");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text?: string };
    expect(body.text).toContain("SL-1");

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.key, "SL-1"));
    expect(issue!.state).toBe("triage");
    expect(issue!.source).toBe("slack");
    const [link] = await db
      .select()
      .from(slackLinks)
      .where(eq(slackLinks.issueId, issue!.id));
    expect(link!.channel).toBe("C123");
    expect(link!.reporterSlackId).toBe("U9");
  });

  it("emoji intake drafts an issue from the thread", async () => {
    const s = createSlack(fakeSlack);
    await s.handleReactionAdded({
      reaction: "ticket",
      item: { type: "message", channel: "C555", ts: "1700.5" },
      item_user: "U1",
    });
    const [link] = await db
      .select()
      .from(slackLinks)
      .where(eq(slackLinks.threadTs, "1700.5"));
    const [newest] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, link!.issueId));
    expect(newest!.title).toContain("export CSV crashes");
    expect(newest!.description).toContain("repro: export");
    expect(calls.some((c) => c.method === "conversations.replies")).toBe(true);
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(true);
  });

  it("emoji intake is idempotent — a retried event doesn't double-create", async () => {
    const s = createSlack(fakeSlack);
    const before = await db
      .select()
      .from(issues)
      .where(eq(issues.source, "slack"));
    // same reaction on the same message, delivered again (Slack retry)
    await s.handleReactionAdded({
      reaction: "ticket",
      item: { type: "message", channel: "C555", ts: "1700.5" },
      item_user: "U2",
    });
    const after = await db
      .select()
      .from(issues)
      .where(eq(issues.source, "slack"));
    expect(after.length).toBe(before.length);
  });

  it("emoji intake is atomic — concurrent deliveries on one thread create one issue", async () => {
    const s = createSlack(fakeSlack);
    const before = await db
      .select()
      .from(issues)
      .where(eq(issues.source, "slack"));
    // two deliveries racing past the existence check — the unique
    // (channel, thread_ts) claim decides the winner
    await Promise.all([
      s.handleReactionAdded({
        reaction: "ticket",
        item: { type: "message", channel: "C777", ts: "1700.9" },
        item_user: "U1",
      }),
      s.handleReactionAdded({
        reaction: "ticket",
        item: { type: "message", channel: "C777", ts: "1700.9" },
        item_user: "U2",
      }),
    ]);
    const after = await db
      .select()
      .from(issues)
      .where(eq(issues.source, "slack"));
    expect(after.length).toBe(before.length + 1);
    const links = await db
      .select()
      .from(slackLinks)
      .where(eq(slackLinks.channel, "C777"));
    expect(links.length).toBe(1);
  });

  it("mirrors thread replies into comments — and ignores bot posts", async () => {
    const s = createSlack(fakeSlack);
    calls.length = 0;
    const [link] = await db
      .select()
      .from(slackLinks)
      .where(eq(slackLinks.channel, "C555"));
    const [issue] = await db.select().from(issues).where(eq(issues.id, link!.issueId));

    await s.handleMessage({
      channel: "C555",
      thread_ts: "1700.5",
      ts: "1700.6",
      text: "also fails on Firefox",
      user: "U7",
    });
    const cs = await db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue!.id));
    expect(cs.at(-1)!.body).toContain("via Slack:");
    expect(cs.at(-1)!.body).toContain("Firefox");

    const before = cs.length;
    await s.handleMessage({
      channel: "C555",
      thread_ts: "1700.5",
      ts: "1700.7",
      text: "our own bot reply",
      bot_id: "B1",
    });
    const after = await db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue!.id));
    expect(after.length).toBe(before);
  });

  it("outbound: comments mirror to slack, slack-originated ones don't echo", async () => {
    const s = createSlack(fakeSlack);
    calls.length = 0;
    const [link] = await db.select().from(slackLinks).limit(1);
    await s.mirrorComment(link!.issueId, "human comment from tallyline");
    expect(
      calls.some(
        (c) => c.method === "chat.postMessage" && c.body.text === "human comment from tallyline",
      ),
    ).toBe(true);
    calls.length = 0;
    await s.mirrorComment(link!.issueId, "**<@U7> via Slack:** echoed");
    expect(calls.length).toBe(0);
  });

  it("resolution posts to the thread; unlink stops mirroring", async () => {
    const s = createSlack(fakeSlack);
    calls.length = 0;
    const [link] = await db.select().from(slackLinks).limit(1);
    await s.notifyResolution(link!.issueId, "done", {
      type: "system",
      id: null,
    });
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(true);

    // unlink via the authed API → mirror stops cleanly
    const [issue] = await db.select().from(issues).where(eq(issues.id, link!.issueId));
    const res = await app.fetch(
      new Request(`http://t/v1/workspaces/${SLUG}/issues/${issue!.key}/slack-link`, {
        method: "DELETE",
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    calls.length = 0;
    await s.mirrorComment(issue!.id, "post-unlink comment");
    expect(calls.length).toBe(0);
  });
});
