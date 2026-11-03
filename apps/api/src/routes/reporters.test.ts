import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  comments,
  intakeCredentials,
  issues,
  reporterHandles,
  reporterReplyDeliveries,
} from "../db/schema.js";
import { settleBackground } from "../services/background.js";
import { hashIntakeKey } from "../services/intake-credentials.js";
import { clearDevInbox, devInbox } from "../services/mailer.js";
import {
  deliverReporterReply,
  issueReporterHandle,
  REPORT_TOKEN_PREFIX,
} from "../services/reporters.js";
import { mkComment, mkIssue, mkProject, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// U3 — reporter follow-up (plan 2026-11-03). A handle shows status and public
// comments, never internal discussion, and a public staff reply mails once.

let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  await runMigrations();
  A = await seedTenant("rep-a", "RPA");
  B = await seedTenant("rep-b", "RPB");
});

afterAll(async () => {
  await closeDb();
});

/** an intake key the test knows the plaintext of */
async function mint(t: Tenant): Promise<string> {
  const key = `tlintake_${randomBytes(24).toString("base64url")}`;
  const project = await mkProject(t);
  await db.insert(intakeCredentials).values({
    workspaceId: t.ws.id,
    projectId: project.id,
    teamId: t.team.id,
    label: `app ${t.sentinel}`,
    keyHash: hashIntakeKey(key),
    keyLast4: key.slice(-4),
    createdBy: t.people.owner.id,
  });
  return key;
}

const post = (key: string, body: unknown) =>
  app.fetch(
    new Request(`http://api.test/v1/intake/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const getReport = (token: string) =>
  app.fetch(new Request(`http://api.test/v1/report/${encodeURIComponent(token)}`));

const report = (over: Record<string, unknown> = {}) => ({
  kind: "bug",
  title: "Checkout button does nothing",
  body: "clicked twice, nothing happened",
  fingerprint: `fp-${randomBytes(4).toString("hex")}`,
  ...over,
});

async function fileReport(
  t: Tenant,
  over: Record<string, unknown> = {},
): Promise<{ token: string; issueKey: string; issueId: string; email: string }> {
  const key = await mint(t);
  const email = `reporter-${randomBytes(4).toString("hex")}@example.test`;
  const res = await post(key, report({ reporter: { email }, ...over }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { issueKey: string; reporterToken: string };
  expect(body.reporterToken.startsWith(REPORT_TOKEN_PREFIX)).toBe(true);
  const [issue] = await db.select().from(issues).where(eq(issues.key, body.issueKey));
  return { token: body.reporterToken, issueKey: body.issueKey, issueId: issue!.id, email };
}

const reply = (t: Tenant, issueKey: string, cookie: string, body: string, isPublic: boolean) =>
  app.fetch(
    new Request(
      `http://api.test/v1/workspaces/${t.ws.slug}/issues/${issueKey}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ body, public: isPublic }),
      },
    ),
  );

describe("reporter handle", () => {
  it("shows status and title with no session and no workspace identity", async () => {
    const filed = await fileReport(A, { title: "Login fails on iOS" });
    const res = await getReport(filed.token);
    expect(res.status).toBe(200);
    // a reporter never needs or receives a session
    expect(res.headers.get("set-cookie")).toBeNull();

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "triage", title: "Login fails on iOS" });
    expect(body.comments).toEqual([]);

    const text = JSON.stringify(body);
    expect(text).not.toContain(A.ws.id);
    expect(text).not.toContain(A.ws.slug);
    expect(text).not.toContain(A.sentinel);
    expect(text).not.toContain(A.team.id);
  });

  it("never shows internal or agent comments, only public ones", async () => {
    const filed = await fileReport(A);
    await db.insert(comments).values([
      {
        workspaceId: A.ws.id,
        issueId: filed.issueId,
        actorType: "human",
        actorId: A.people.owner.id,
        body: `internal triage note ${A.sentinel}`,
      },
      {
        workspaceId: A.ws.id,
        issueId: filed.issueId,
        actorType: "agent",
        actorId: A.agent.id,
        body: `agent plan ${A.sentinel}`,
      },
      {
        workspaceId: A.ws.id,
        issueId: filed.issueId,
        actorType: "human",
        actorId: A.people.admin.id,
        body: "We are deploying a fix today.",
        visibility: "public",
      },
    ]);

    const res = await getReport(filed.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comments: { author: string; body: string; createdAt: string }[];
    };
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]!.body).toBe("We are deploying a fix today.");
    // a display name, never an id or an email
    expect(body.comments[0]!.author.length).toBeGreaterThan(0);
    expect(body.comments[0]!.author).not.toBe(A.people.admin.id);

    const text = JSON.stringify(body);
    // the author is a display name; ids and workspace identity never ride along
    expect(text).not.toContain(A.ws.id);
    expect(text).not.toContain(A.ws.slug);
    expect(text).not.toContain("internal triage note");
    expect(text).not.toContain("agent plan");
  });

  it("answers one 404 for expired, unknown and malformed handles", async () => {
    const filed = await fileReport(A);
    await db
      .update(reporterHandles)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(reporterHandles.issueId, filed.issueId));

    const expired = await getReport(filed.token);
    const unknown = await getReport(
      `${REPORT_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`,
    );
    const malformed = await getReport("not-a-token");

    for (const res of [expired, unknown, malformed]) {
      expect(res.status).toBe(404);
    }
    const bodies = await Promise.all(
      [expired, unknown, malformed].map((r) => r.json()),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0]).toMatchObject({ error: { code: "REPORT_NOT_FOUND" } });
  });

  it("mails exactly one message per public reply and records the delivery", async () => {
    clearDevInbox();
    const filed = await fileReport(A, { title: "Export crashes" });
    const cookie = `tly_session=${await newSession(A, "owner")}`;

    // internal: never mailed, never shown
    const internal = await reply(A, filed.issueKey, cookie, `internal ${A.sentinel}`, false);
    expect(internal.status).toBe(201);
    await settleBackground();
    expect(devInbox().filter((m) => m.to === filed.email)).toHaveLength(0);

    const first = await reply(A, filed.issueKey, cookie, "We shipped a fix in 1.4.1.", true);
    expect(first.status).toBe(201);
    const firstComment = (await first.json()) as { id: string };
    await settleBackground();

    const mails = devInbox().filter(
      (m) => m.to === filed.email && m.kind === "reporter_reply",
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("We shipped a fix in 1.4.1.");

    // the delivery is recorded against this one reply
    const [sent] = await db
      .select()
      .from(reporterReplyDeliveries)
      .where(eq(reporterReplyDeliveries.commentId, firstComment.id));
    expect(sent).toBeDefined();
    expect(sent!.toEmail).toBe(filed.email);
    expect(sent!.issueId).toBe(filed.issueId);
    expect(sent!.sentAt).not.toBeNull();
    expect(sent!.error).toBeNull();

    // a retry of the same reply finds the claim and mails nothing more
    const retried = await deliverReporterReply({
      workspaceId: A.ws.id,
      issueId: filed.issueId,
      commentId: firstComment.id,
      body: "We shipped a fix in 1.4.1.",
    });
    expect(retried).toEqual({ status: "skipped", reason: "already_delivered" });
    await settleBackground();
    expect(
      devInbox().filter((m) => m.to === filed.email && m.kind === "reporter_reply"),
    ).toHaveLength(1);

    // the reporter sees it back through the handle
    const seen = (await (await getReport(filed.token)).json()) as {
      status: string;
      comments: { body: string }[];
    };
    expect(seen.status).toBe("triage");
    expect(seen.comments.map((c) => c.body)).toEqual(["We shipped a fix in 1.4.1."]);

    // the next public reply is its own message — one per reply, not a digest
    const second = await reply(A, filed.issueKey, cookie, "Does 1.4.1 work for you?", true);
    expect(second.status).toBe(201);
    await settleBackground();
    expect(
      devInbox().filter((m) => m.to === filed.email && m.kind === "reporter_reply"),
    ).toHaveLength(2);
  });

  it("sends nothing when the handle has no address, and stays in its tenant", async () => {
    clearDevInbox();
    // a handle requested without an address (followUp: true) has nowhere to mail
    const key = await mint(B);
    const res = await post(key, report({ reporter: { followUp: true } }));
    expect(res.status).toBe(201);
    const { reporterToken } = (await res.json()) as { reporterToken: string };

    const [handle] = await db
      .select()
      .from(reporterHandles)
      .where(eq(reporterHandles.workspaceId, B.ws.id));
    const issue = await mkIssue(B);
    const comment = await mkComment(B, issue.id);
    const result = await deliverReporterReply({
      workspaceId: B.ws.id,
      issueId: handle!.issueId,
      commentId: comment.id,
      body: "a reply with no address to send it to",
    });
    expect(result).toEqual({ status: "skipped", reason: "no_reporter_email" });
    expect(devInbox().filter((m) => m.kind === "reporter_reply")).toHaveLength(0);

    // A's handle for the same shape of issue reads A only
    const mine = await fileReport(A);
    expect((await getReport(reporterToken)).status).toBe(200);
    expect(JSON.stringify(await (await getReport(mine.token)).json())).not.toContain(
      B.sentinel,
    );
  });

  it("issues no handle when the reporter did not ask for one", async () => {
    const key = await mint(A);
    const res = await post(key, report());
    expect(res.status).toBe(201);
    expect(((await res.json()) as { reporterToken: unknown }).reporterToken).toBeNull();
  });

  it("unsubscribing stops reply mail but keeps the handle readable", async () => {
    clearDevInbox();
    const filed = await fileReport(A);
    const off = await app.fetch(
      new Request(
        `http://api.test/v1/report/${encodeURIComponent(filed.token)}/unsubscribe`,
      ),
    );
    expect(off.status).toBe(200);

    const cookie = `tly_session=${await newSession(A, "owner")}`;
    const posted = await reply(
      A,
      filed.issueKey,
      cookie,
      "public reply after opt-out",
      true,
    );
    expect(posted.status).toBe(201);
    await settleBackground();
    expect(devInbox().filter((m) => m.to === filed.email)).toHaveLength(0);
    expect((await getReport(filed.token)).status).toBe(200);
  });

  it("expires a handle 30 days after the report", async () => {
    const issue = await mkIssue(A);
    const before = Date.now();
    const handle = await issueReporterHandle({
      workspaceId: A.ws.id,
      issueId: issue.id,
      reporterEmail: null,
    });
    const days = (handle.expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });
});
