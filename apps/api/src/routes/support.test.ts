import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { intakeCredentials, issues } from "../db/schema.js";
import { hashIntakeKey } from "../services/intake-credentials.js";
import { REPORT_TOKEN_PREFIX } from "../services/reporters.js";
import {
  mkIssue,
  mkProject,
  newSession,
  seedTenant,
  type Tenant,
} from "../../test/tenants.js";

// U6 — web helpdesk (plan 2026-11-03). The list is scoped to intake-origin
// issues, names each report's kind and source app, and the shareable reporter
// link resolves through the public follow-up route.

let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  await runMigrations();
  A = await seedTenant("sup-a", "SUA");
  B = await seedTenant("sup-b", "SUB");
});

afterAll(async () => {
  await closeDb();
});

async function mintKey(t: Tenant): Promise<string> {
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

const postReport = (key: string, body: Record<string, unknown>) =>
  app.fetch(
    new Request(`http://api.test/v1/intake/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function fileReport(
  t: Tenant,
  over: Record<string, unknown> = {},
): Promise<{ issueKey: string; reporterToken: string | null; issueId: string }> {
  const key = await mintKey(t);
  const res = await postReport(key, {
    kind: "error",
    title: `Report ${t.sentinel} ${randomBytes(3).toString("hex")}`,
    body: "stack goes here",
    fingerprint: `fp-${randomBytes(4).toString("hex")}`,
    reporter: { email: `reporter-${randomBytes(4).toString("hex")}@example.test` },
    ...over,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { issueKey: string; reporterToken: string | null };
  const [issue] = await db.select().from(issues).where(eq(issues.key, body.issueKey));
  return { issueKey: body.issueKey, reporterToken: body.reporterToken, issueId: issue!.id };
}

interface SupportRow {
  key: string;
  kind: string;
  provider: string;
  reporter: { name: string | null; email: string | null } | null;
  publicReplies: number;
  projectId: string | null;
  title: string;
}

const list = async (t: Tenant, qs = "") => {
  const cookie = `tly_session=${await newSession(t, "owner")}`;
  const res = await app.fetch(
    new Request(`http://api.test/v1/workspaces/${t.ws.slug}/support${qs}`, {
      headers: { cookie },
    }),
  );
  return { status: res.status, body: (await res.json()) as { issues: SupportRow[]; truncated: boolean } };
};

describe("helpdesk list", () => {
  it("lists intake issues with kind, source app and reporter, and nothing else", async () => {
    const filed = await fileReport(A, { kind: "bug", provider: "acme-web" });
    // a hand-filed issue is not a report and must not appear
    await mkIssue(A, { source: "web", title: `hand filed ${A.sentinel}` });

    const { status, body } = await list(A);
    expect(status).toBe(200);
    const row = body.issues.find((i) => i.key === filed.issueKey);
    expect(row).toMatchObject({
      kind: "bug",
      provider: "acme-web",
      publicReplies: 0,
    });
    // the reporter's address comes from the handle minted at report time
    expect(row?.reporter?.email).toContain("@example.test");
    expect(body.issues.some((i) => i.title.includes("hand filed"))).toBe(false);
  });

  it("never lists another workspace's reports", async () => {
    const theirs = await fileReport(B);
    const { body } = await list(A);
    expect(body.issues.some((i) => i.key === theirs.issueKey)).toBe(false);
  });

  it("filters by kind and by project", async () => {
    const bug = await fileReport(A, { kind: "bug" });
    const help = await fileReport(A, { kind: "help" });

    const byKind = await list(A, "?kind=help");
    expect(byKind.body.issues.some((i) => i.key === help.issueKey)).toBe(true);
    expect(byKind.body.issues.some((i) => i.key === bug.issueKey)).toBe(false);

    const project = (await list(A)).body.issues.find(
      (i) => i.key === bug.issueKey,
    )?.projectId;
    expect(project).toBeTruthy();
    const byProject = await list(A, `?project=${project}`);
    expect(byProject.body.issues.every((i) => i.projectId === project)).toBe(true);
  });

  it("counts only public replies", async () => {
    const filed = await fileReport(A);
    const cookie = `tly_session=${await newSession(A, "owner")}`;
    for (const [body, isPublic] of [
      ["internal note", false],
      ["We are on it.", true],
    ] as const) {
      const res = await app.fetch(
        new Request(
          `http://api.test/v1/workspaces/${A.ws.slug}/issues/${filed.issueKey}/comments`,
          {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ body, public: isPublic }),
          },
        ),
      );
      expect(res.status).toBe(201);
    }
    const { body } = await list(A);
    expect(body.issues.find((i) => i.key === filed.issueKey)?.publicReplies).toBe(1);
  });
});

describe("reporter link", () => {
  it("mints a link a reporter can open, for intake issues only", async () => {
    const filed = await fileReport(A, { title: "Card declined at checkout" });
    const cookie = `tly_session=${await newSession(A, "member")}`;
    const minted = await app.fetch(
      new Request(
        `http://api.test/v1/workspaces/${A.ws.slug}/support/${filed.issueKey}/handle`,
        { method: "POST", headers: { cookie } },
      ),
    );
    expect(minted.status).toBe(200);
    const { url } = (await minted.json()) as { url: string };
    const token = url.split("/report/")[1]!;
    expect(token.startsWith(REPORT_TOKEN_PREFIX)).toBe(true);

    const read = await app.fetch(
      new Request(`http://api.test/v1/report/${encodeURIComponent(token)}`),
    );
    expect(read.status).toBe(200);
    expect((await read.json()) as Record<string, unknown>).toMatchObject({
      title: "Card declined at checkout",
    });

    const hand = await mkIssue(A, { source: "web" });
    const refused = await app.fetch(
      new Request(
        `http://api.test/v1/workspaces/${A.ws.slug}/support/${hand.key}/handle`,
        { method: "POST", headers: { cookie } },
      ),
    );
    expect(refused.status).toBe(404);
  });
});
