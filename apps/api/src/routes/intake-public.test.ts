import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { intakeCredentials, issues, teams } from "../db/schema.js";
import { config_ } from "../env.js";
import { hashIntakeKey } from "../services/intake-credentials.js";
import { intakeReportLimiter } from "./intake-public.js";
import { mkProject, seedTenant, type Tenant } from "../../test/tenants.js";

// U2 — public ingest (plan 2026-11-03). A tlintake_… key files a report with
// no session, and the response never names the workspace behind it.

let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  await runMigrations();
  A = await seedTenant("pub-a", "PBA");
  B = await seedTenant("pub-b", "PBB");
  // sorts before the credential's team, so a missing teamKey would land here
  await db
    .insert(teams)
    .values({ workspaceId: A.ws.id, key: "AAA", name: `Decoy ${A.sentinel}` });
});

afterAll(async () => {
  await closeDb();
});

/** a credential whose plaintext key the test knows (mkIntakeCredential drops it) */
async function mint(
  t: Tenant,
  opts: { teamId?: string | null } = {},
): Promise<{ key: string; id: string }> {
  const key = `tlintake_${randomBytes(24).toString("base64url")}`;
  const project = await mkProject(t);
  const [row] = await db
    .insert(intakeCredentials)
    .values({
      workspaceId: t.ws.id,
      projectId: project.id,
      teamId: opts.teamId === undefined ? t.team.id : opts.teamId,
      label: `app ${t.sentinel}`,
      keyHash: hashIntakeKey(key),
      keyLast4: key.slice(-4),
      createdBy: t.people.owner.id,
    })
    .returning();
  return { key, id: row!.id };
}

const post = (key: string, body: unknown) =>
  app.fetch(
    new Request(`http://api.test/v1/intake/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const report = (over: Record<string, unknown> = {}) => ({
  kind: "error",
  title: "TypeError: cannot read properties of undefined",
  body: "at checkout (cart.ts:88)",
  fingerprint: `fp-${randomBytes(4).toString("hex")}`,
  ...over,
});

async function issuesOf(t: Tenant) {
  return db.select().from(issues).where(eq(issues.workspaceId, t.ws.id));
}

describe("public intake", () => {
  it("files one issue with no session, on the key's team, and sets no cookie", async () => {
    const { key, id } = await mint(A);
    const res = await post(
      key,
      report({ title: "Boom on checkout", fingerprint: "fp-main" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.deduped).toBe(false);
    expect(body.reporterToken).toBeNull();
    const issueKey = body.issueKey as string;
    expect(issueKey).toMatch(/^PBA-\d+$/);

    // no session is required and none is minted
    expect(res.headers.get("set-cookie")).toBeNull();

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.key, issueKey));
    expect(issue).toMatchObject({
      workspaceId: A.ws.id,
      teamId: A.team.id,
      state: "triage",
      source: "intake",
      intakeFingerprint: `${id}:fp-main`,
    });

    // the credential records its use
    const [cred] = await db
      .select()
      .from(intakeCredentials)
      .where(eq(intakeCredentials.id, id));
    expect(cred!.lastUsedAt).not.toBeNull();

    // the response names the issue and nothing else in the workspace
    const text = JSON.stringify(body);
    expect(text).not.toContain(A.ws.id);
    expect(text).not.toContain(A.ws.slug);
    expect(text).not.toContain(A.sentinel);
    expect(text).not.toContain(A.team.id);
    expect(text).not.toContain("AAA");
    expect(Object.keys(body).sort()).toEqual([
      "deduped",
      "issueKey",
      "reporterToken",
    ]);
  });

  it("dedupes on credential + fingerprint, and keeps other keys apart", async () => {
    const first = await mint(A);
    const one = await post(first.key, report({ fingerprint: "fp-repeat" }));
    expect(one.status).toBe(201);
    const oneKey = ((await one.json()) as { issueKey: string }).issueKey;

    const two = await post(first.key, report({ fingerprint: "fp-repeat" }));
    expect(two.status).toBe(200);
    const deduped = (await two.json()) as Record<string, unknown>;
    expect(deduped).toMatchObject({ issueKey: oneKey, deduped: true });

    const [row] = await db.select().from(issues).where(eq(issues.key, oneKey));
    expect(row!.occurrenceCount).toBe(2);

    // a second credential in the same workspace has its own identity: the
    // same fingerprint is a different source and opens its own issue
    const second = await mint(A);
    const three = await post(second.key, report({ fingerprint: "fp-repeat" }));
    expect(three.status).toBe(201);
    const other = (await three.json()) as { issueKey: string; deduped: boolean };
    expect(other.deduped).toBe(false);
    expect(other.issueKey).not.toBe(oneKey);

    const held = await db
      .select()
      .from(issues)
      .where(eq(issues.intakeFingerprint, `${first.id}:fp-repeat`));
    expect(held).toHaveLength(1);
  });

  it("refuses a revoked key with 410 and files nothing", async () => {
    const { key, id } = await mint(A);
    await db
      .update(intakeCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(intakeCredentials.id, id));
    const before = (await issuesOf(A)).length;

    const res = await post(key, report({ title: "after revoke" }));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({
      error: { code: "INTAKE_KEY_REVOKED" },
    });
    expect((await issuesOf(A)).length).toBe(before);
  });

  it("refuses an unknown key with 401 and reveals no workspace", async () => {
    const unknown = `tlintake_${randomBytes(24).toString("base64url")}`;
    const res = await post(unknown, report());
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "INTAKE_KEY_INVALID" },
    });
    expect(text).not.toContain(A.ws.id);

    // a key without the prefix is refused without a database lookup
    expect((await post("nope", report())).status).toBe(401);

    // another tenant's key is not a key for this one either — it is still
    // valid on its own workspace, never a cross-workspace handle
    const b = await mint(B);
    const ok = await post(b.key, report({ title: "tenant B report" }));
    expect(ok.status).toBe(201);
    const filed = (await ok.json()) as { issueKey: string };
    expect(filed.issueKey).toMatch(/^PBB-\d+$/);
  });

  it("rejects a 200 KB body with 413", async () => {
    const { key } = await mint(A);
    const big = JSON.stringify(report({ body: "x".repeat(200 * 1024) }));
    const res = await post(key, big);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("rate limits per credential with Retry-After", async () => {
    const { key, id } = await mint(A);
    const now = Date.now();
    for (let i = 0; i < config_.intakeRatePerMin; i += 1) {
      await intakeReportLimiter.store.hit(`intake:${id}`, 60_000, now);
    }
    const before = (await issuesOf(A)).length;

    const res = await post(key, report({ title: "over budget" }));
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(await res.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect((await issuesOf(A)).length).toBe(before);

    // the budget is the credential's, not the workspace's: a fresh key on the
    // same workspace still reports
    const other = await mint(A);
    expect(
      (await post(other.key, report({ title: "other app" }))).status,
    ).toBe(201);
  });
});
