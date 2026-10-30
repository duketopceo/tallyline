import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { comments, events, glitchtipIntegrations, intakeEvents, issues, teams, workspaces } from "../db/schema.js";
import { config_ } from "../env.js";
import { MemoryRateStore } from "../lib/rate-limit.js";
import { glitchtipDeliveryLimiter, glitchtipIssueLimiter } from "./glitchtip-webhook.js";
import { hashToken } from "../services/tokens.js";
import { resetClock, setClock } from "../services/clock.js";
import { ingestIntake } from "../services/intake.js";

// ranking is switched on so the test proves the receiver bypasses it
const suggestTriage = vi.hoisted(() => vi.fn());
vi.mock("../services/ai-seam.js", async (orig) => ({
  ...(await orig<typeof import("../services/ai-seam.js")>()),
  aiEnabledFor: async () => true,
}));
vi.mock("../services/assist.js", async (orig) => ({
  ...(await orig<typeof import("../services/assist.js")>()),
  createAssist: () => ({ suggestTriage }),
}));

const SLUG = "gt-test";
const T0 = Date.parse("2026-10-25T12:00:30.000Z");

let sessionCookie = "";

const fx = (name: string): string =>
  readFileSync(
    new URL(`../../test/fixtures/glitchtip/${name}.json`, import.meta.url),
    "utf8",
  );

async function req(
  path: string,
  init?: RequestInit & { cookie?: boolean },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.cookie === false || !sessionCookie ? {} : { cookie: sessionCookie }),
        ...(init?.headers as Record<string, string>),
      },
    }),
  );
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("tly_session=")) sessionCookie = setCookie.split(";")[0]!;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const hook = (token: string, raw: string) =>
  req(`/webhooks/glitchtip/${token}`, { method: "POST", body: raw, cookie: false });

const admin = (path: string, init?: RequestInit) =>
  req(`/v1/workspaces/${SLUG}/glitchtip${path}`, init);

let token = "";
let webhookUrl = "";

beforeAll(async () => {
  await runMigrations();
  setClock(() => T0);
});

afterEach(() => setClock(() => T0));

afterAll(async () => {
  resetClock();
  await closeDb();
});

describe("glitchtip native integration", () => {
  it("boots a workspace with teams for the mapped services", async () => {
    const boot = await req("/v1/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        workspaceSlug: SLUG,
        workspaceName: "GT Test",
        teamKey: "OPS",
        email: "owner@gt.test",
        name: "Owner",
        password: "test-password-123",
      }),
    });
    expect(boot.status).toBe(201);
    for (const [key, name] of [["PACE", "Pace"], ["WISP", "Wisp"]] as const) {
      const r = await req(`/v1/workspaces/${SLUG}/teams`, {
        method: "POST",
        body: JSON.stringify({ key, name }),
      });
      expect(r.status).toBe(201);
    }
  });

  it("starts unconfigured; anonymous callers cannot read it", async () => {
    const got = await admin("");
    expect(got.status).toBe(200);
    expect(got.body.integration).toBeNull();
    const anon = await req(`/v1/workspaces/${SLUG}/glitchtip`, { cookie: false });
    expect(anon.status).toBe(401);
  });

  it("rejects a map that names an unknown team", async () => {
    const r = await admin("", {
      method: "PUT",
      body: JSON.stringify({ projectMap: { "portal-ui": "NOPE" } }),
    });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: "UNKNOWN_TEAM" } });
  });

  it("creates the integration once, showing the URL a single time and storing only a hash", async () => {
    const r = await admin("", {
      method: "PUT",
      body: JSON.stringify({
        projectMap: { "Portal-UI": "pace", Strut: "PACE", Relay: "PACE", Sidecar: "PACE", Wisp: "WISP" },
      }),
    });
    expect(r.status).toBe(201);
    token = r.body.token as string;
    webhookUrl = r.body.webhookUrl as string;
    expect(token).toMatch(/^tly_gt_[A-Za-z0-9_-]{32}$/);
    expect(webhookUrl.endsWith(`/webhooks/glitchtip/${token}`)).toBe(true);
    const integration = r.body.integration as Record<string, unknown>;
    expect(integration.projectMap).toEqual({
      "portal-ui": "PACE", strut: "PACE", relay: "PACE", sidecar: "PACE", wisp: "WISP",
    });
    expect(integration.tokenLast4).toBe(token.slice(-4));
    expect(JSON.stringify(integration)).not.toContain(token);

    const [row] = await db.select().from(glitchtipIntegrations);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);

    const status = await admin("");
    expect(JSON.stringify(status.body)).not.toContain(token);
    expect((status.body.integration as { configured: boolean }).configured).toBe(true);

    // a second PUT updates, never creates a second row or a second secret
    const again = await admin("", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(again.status).toBe(200);
    expect(again.body.token).toBeUndefined();
    expect(await db.select().from(glitchtipIntegrations)).toHaveLength(1);
  });

  it("a wrong secret is 404 and writes nothing", async () => {
    const before = await db.select().from(intakeEvents);
    const r = await hook("tly_gt_" + "A".repeat(32), fx("single-error"));
    expect(r.status).toBe(404);
    const malformed = await hook("not-a-token", fx("single-error"));
    expect(malformed.status).toBe(404);
    expect(await db.select().from(intakeEvents)).toHaveLength(before.length);
  });

  it("creates one triage issue on the mapped team without ranking it", async () => {
    suggestTriage.mockResolvedValue({ action: "accept", reason: "r" });
    const r = await hook(token, fx("single-error"));
    expect(r.status).toBe(200);
    const results = r.body.results as { status: string; issueKey: string; teamKey: string }[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "created", teamKey: "PACE" });
    expect(results[0]!.issueKey).toMatch(/^PACE-\d+$/);
    expect(suggestTriage).not.toHaveBeenCalled();

    const [issue] = await db.select().from(issues).where(eq(issues.key, results[0]!.issueKey));
    expect(issue).toMatchObject({
      state: "triage",
      source: "intake",
      creatorType: "system",
      intakeFingerprint: "glitchtip:errors.pacehq.io/pace/4121",
      occurrenceCount: 1,
    });
    expect(issue!.description).toContain("Project: portal-ui");
    expect(issue!.description).toContain("https://errors.pacehq.io/pace/issues/4121");
    expect(issue!.description).toContain("glitchtip (error, error)");

    const events = await db.select().from(intakeEvents);
    expect(JSON.stringify(events)).not.toContain(token);
    const [row] = await db.select().from(glitchtipIntegrations);
    expect(row!.glitchtipHost).toBe("errors.pacehq.io");
    expect(row!.lastReceivedAt).not.toBeNull();
  });

  it("control: the plain intake path still ranks when ranking is on", async () => {
    const [ws] = await db.select({ id: glitchtipIntegrations.workspaceId }).from(glitchtipIntegrations);
    await ingestIntake(ws!.id, { kind: "error", title: "control", fingerprint: "control-1" }, { type: "system", id: null }, { teamKey: "OPS" });
    expect(suggestTriage).toHaveBeenCalledTimes(1);
  });

  it("an unknown team override is a 422, not a silent fallback to the first team", async () => {
    const [ws] = await db.select({ id: glitchtipIntegrations.workspaceId }).from(glitchtipIntegrations);
    await expect(
      ingestIntake(ws!.id, { kind: "error", title: "t" }, { type: "system", id: null }, { teamKey: "NOPE" }),
    ).rejects.toMatchObject({ status: 422, code: "NO_TEAM" });
  });

  it("drops an identical retry within the same minute", async () => {
    const r = await hook(token, fx("single-error"));
    expect(r.status).toBe(200);
    expect((r.body.results as { status: string }[])[0]!.status).toBe("duplicate_delivery");
    expect(await db.select().from(issues).where(eq(issues.intakeFingerprint, "glitchtip:errors.pacehq.io/pace/4121"))).toHaveLength(1);
  });

  it("bumps the occurrence count when the same alert fires again later", async () => {
    setClock(() => T0 + 5 * 60_000);
    const r = await hook(token, fx("single-error"));
    const [res] = r.body.results as { status: string; occurrenceCount: number; issueKey: string }[];
    expect(res).toMatchObject({ status: "deduped", occurrenceCount: 2 });
    const rows = await db.select().from(issues).where(eq(issues.intakeFingerprint, "glitchtip:errors.pacehq.io/pace/4121"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(2);
    const notes = await db.select().from(comments).where(eq(comments.issueId, rows[0]!.id));
    expect(notes.filter((c) => c.body.includes("New occurrence via glitchtip"))).toHaveLength(1);
  });

  it("lands every item of a batch on its project's team", async () => {
    const r = await hook(token, fx("batch"));
    expect(r.status).toBe(200);
    const results = r.body.results as { status: string; teamKey: string; issueKey: string }[];
    // item 1 is the already-known issue 4121; the others are new
    expect(results.map((x) => [x.teamKey, x.status])).toEqual([
      ["PACE", "deduped"],
      ["PACE", "created"],
      ["WISP", "created"],
    ]);
    expect(results[2]!.issueKey).toMatch(/^WISP-\d+$/);
  });

  it("maps warning and info colors to severity in the issue provenance", async () => {
    const w = await hook(token, fx("warning"));
    const i = await hook(token, fx("info"));
    const keys = [w, i].map((x) => (x.body.results as { issueKey: string }[])[0]!.issueKey);
    const rows = await Promise.all(keys.map((k) => db.select().from(issues).where(eq(issues.key, k))));
    expect(rows[0]![0]!.description).toContain("glitchtip (error, warning)");
    expect(rows[1]![0]!.description).toContain("glitchtip (error, info)");
  });

  it("ignores uptime alerts and bad bodies", async () => {
    const before = await db.select().from(issues);
    const up = await hook(token, fx("uptime"));
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ ok: true, ignored: true, results: [] });
    const bad = await hook(token, "{not json");
    expect(bad.status).toBe(400);
    expect(await db.select().from(issues)).toHaveLength(before.length);
  });

  it("drops alerts that point at a different GlitchTip host", async () => {
    const r = await hook(token, fx("foreign-host"));
    expect(r.body).toMatchObject({ ignored: true, dropped: 1 });
  });

  it("rejects an unmapped project with 422 and creates nothing when there is no default team", async () => {
    const before = await db.select().from(issues);
    const r = await hook(token, fx("unmapped-project"));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: "UNMAPPED_PROJECT" } });
    expect(await db.select().from(issues)).toHaveLength(before.length);
  });

  it("a batch with one unmapped project lands nothing, not even its mapped items", async () => {
    const batch = JSON.parse(fx("batch")) as { attachments: { fields: { title: string; value: string }[] }[] };
    batch.attachments[2]!.fields[0]!.value = "billing-cron"; // was wisp, now unmapped
    const issuesBefore = await db.select().from(issues);
    const eventsBefore = await db.select().from(intakeEvents);
    const r = await hook(token, JSON.stringify(batch));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: "UNMAPPED_PROJECT" } });
    expect(await db.select().from(issues)).toHaveLength(issuesBefore.length);
    expect(await db.select().from(intakeEvents)).toHaveLength(eventsBefore.length);
  });

  it("an attachment without a Project field is unmapped", async () => {
    const body = JSON.parse(fx("single-error")) as { attachments: { title_link: string; fields: { title: string }[] }[] };
    body.attachments[0]!.fields = body.attachments[0]!.fields.filter((f) => f.title !== "Project");
    body.attachments[0]!.title_link = "https://errors.pacehq.io/pace/issues/5555";
    const r = await hook(token, JSON.stringify(body));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: "UNMAPPED_PROJECT" } });
  });

  it("a mapped team that no longer exists is a 422 and writes nothing", async () => {
    const [row] = await db.select().from(glitchtipIntegrations);
    await db
      .update(glitchtipIntegrations)
      .set({ projectMap: { ...row!.projectMap, "billing-cron": "GONE" } })
      .where(eq(glitchtipIntegrations.id, row!.id));
    const issuesBefore = await db.select().from(issues);
    const r = await hook(token, fx("unmapped-project"));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: "UNKNOWN_TEAM" } });
    expect(await db.select().from(issues)).toHaveLength(issuesBefore.length);
    await db
      .update(glitchtipIntegrations)
      .set({ projectMap: row!.projectMap })
      .where(eq(glitchtipIntegrations.id, row!.id));
  });

  it("ingests at most 25 attachments per delivery and reports the rest as dropped", async () => {
    const one = (JSON.parse(fx("warning")) as { attachments: Record<string, unknown>[] }).attachments[0]!;
    const body = {
      text: "GlitchTip Alert (26 issues)",
      attachments: Array.from({ length: 26 }, (_, i) => ({
        ...one,
        title: `Flood ${i}`,
        title_link: `https://errors.pacehq.io/pace/issues/${8000 + i}`,
      })),
    };
    const r = await hook(token, JSON.stringify(body));
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(25);
    expect(r.body.dropped).toBe(1);
    const created = (r.body.results as { status: string }[]).filter((x) => x.status === "created");
    expect(created).toHaveLength(25);
  });

  it("a project named like an Object.prototype key is unmapped, not a crash", async () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      const body = JSON.parse(fx("unmapped-project")) as { attachments: { title_link: string; fields: { title: string; value: string }[] }[] };
      body.attachments[0]!.fields[0]!.value = name;
      body.attachments[0]!.title_link = `https://errors.pacehq.io/pace/issues/${6000 + name.length}`;
      const r = await hook(token, JSON.stringify(body));
      expect(r.status, name).toBe(422);
      expect(r.body, name).toMatchObject({ error: { code: "UNMAPPED_PROJECT" } });
    }
  });

  it("a workspace pending deletion answers like an unknown secret", async () => {
    const [row] = await db.select().from(glitchtipIntegrations);
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, row!.workspaceId));
    expect((await hook(token, fx("single-error"))).status).toBe(404);
    await db.update(workspaces).set({ deletedAt: null }).where(eq(workspaces.id, row!.workspaceId));
    expect((await hook(token, fx("uptime"))).status).toBe(200);
  });

  it("routes an unmapped project to the default team once one is set", async () => {
    const set = await admin("", { method: "PUT", body: JSON.stringify({ defaultTeamKey: "ops" }) });
    expect(set.status).toBe(200);
    const r = await hook(token, fx("unmapped-project"));
    expect(r.status).toBe(200);
    expect((r.body.results as { teamKey: string }[])[0]!.teamKey).toBe("OPS");
  });

  it("a disabled integration answers 404", async () => {
    await admin("", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    expect((await hook(token, fx("single-error"))).status).toBe(404);
    await admin("", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect((await hook(token, fx("uptime"))).status).toBe(200);
  });

  it("rejects an oversized body", async () => {
    const big = JSON.stringify({ pad: "x".repeat(300 * 1024) });
    const r = await hook(token, big);
    expect(r.status).toBe(413);
  });

  it("rotation kills the old secret immediately and reveals the new one once", async () => {
    const rot = await admin("/rotate", { method: "POST" });
    expect(rot.status).toBe(200);
    const next = rot.body.token as string;
    expect(next).not.toBe(token);
    expect((await hook(token, fx("uptime"))).status).toBe(404);
    expect((await hook(next, fx("uptime"))).status).toBe(200);
    expect(JSON.stringify((await admin("")).body)).not.toContain(next);
    const [row] = await db.select().from(glitchtipIntegrations);
    expect(row!.rotatedAt).not.toBeNull();
    token = next;
  });

  it("deleting the integration kills its URL", async () => {
    const del = await admin("", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await hook(token, fx("uptime"))).status).toBe(404);
    expect((await admin("/rotate", { method: "POST" })).status).toBe(404);
    expect((await admin("")).body.integration).toBeNull();
  });
});

describe("glitchtip webhook rate limits (per integration, not per IP)", () => {
  const OTHER_TOKEN = "tly_gt_other-integration-secret-0123456789";
  // config_ is read-only to the type system; the limiters read it per request
  const cfg = config_ as unknown as { glitchtipRatePerMin: number; glitchtipIssuesPerHour: number };
  const saved = { rate: cfg.glitchtipRatePerMin, issues: cfg.glitchtipIssuesPerHour };
  let mine = "";

  const alert = (n: number): string => fx("single-error").replaceAll("4121", String(n));
  const reset = () => {
    (glitchtipDeliveryLimiter.store as MemoryRateStore).buckets.clear();
    (glitchtipIssueLimiter.store as MemoryRateStore).buckets.clear();
  };

  beforeAll(async () => {
    const r = await admin("", { method: "PUT", body: JSON.stringify({ projectMap: { "portal-ui": "PACE" } }) });
    expect(r.status).toBe(201);
    mine = r.body.token as string;
    // a second workspace and integration, as another tenant behind the same
    // GlitchTip egress address
    const [ws] = await db.insert(workspaces).values({ slug: "gt-other", name: "GT Other" }).returning();
    await db.insert(teams).values({ workspaceId: ws!.id, key: "OTH", name: "Other" });
    await db.insert(glitchtipIntegrations).values({
      workspaceId: ws!.id,
      tokenHash: hashToken(OTHER_TOKEN),
      tokenLast4: OTHER_TOKEN.slice(-4),
      defaultTeamKey: "OTH",
    });
  });

  afterAll(async () => {
    cfg.glitchtipRatePerMin = saved.rate;
    cfg.glitchtipIssuesPerHour = saved.issues;
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, "gt-other"));
    if (ws) {
      await db.delete(glitchtipIntegrations).where(eq(glitchtipIntegrations.workspaceId, ws.id));
      const other = await db.select({ id: issues.id }).from(issues).where(eq(issues.workspaceId, ws.id));
      for (const o of other) await db.delete(comments).where(eq(comments.issueId, o.id));
      await db.delete(intakeEvents).where(eq(intakeEvents.workspaceId, ws.id));
      await db.delete(events).where(eq(events.workspaceId, ws.id));
      await db.delete(issues).where(eq(issues.workspaceId, ws.id));
      await db.delete(teams).where(eq(teams.workspaceId, ws.id));
      await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    }
  });

  it("answers 429 with Retry-After beyond N deliveries a minute; another integration is unaffected; the window reopens", async () => {
    reset();
    cfg.glitchtipRatePerMin = 3;
    cfg.glitchtipIssuesPerHour = 0;
    for (let i = 0; i < 3; i++) expect((await hook(mine, fx("uptime"))).status).toBe(200);
    const res = await app.fetch(
      new Request(`http://api.test/webhooks/glitchtip/${mine}`, { method: "POST", body: fx("uptime") }),
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    // same source address, different integration: its own budget
    for (let i = 0; i < 3; i++) expect((await hook(OTHER_TOKEN, fx("uptime"))).status).toBe(200);
    expect((await hook(OTHER_TOKEN, fx("uptime"))).status).toBe(429);

    setClock(() => T0 + 61_000);
    expect((await hook(mine, fx("uptime"))).status).toBe(200);
  });

  it("unknown tokens stay 404 and spend no integration's budget", async () => {
    reset();
    cfg.glitchtipRatePerMin = 2;
    for (let i = 0; i < 5; i++) expect((await hook("tly_gt_does-not-exist", fx("uptime"))).status).toBe(404);
    expect((await hook(mine, fx("uptime"))).status).toBe(200);
  });

  it("caps issues created per hour; deduped occurrences do not spend it; another integration still creates", async () => {
    reset();
    cfg.glitchtipRatePerMin = 0;
    cfg.glitchtipIssuesPerHour = 2;
    setClock(() => T0 + 2 * 3_600_000);
    expect(((await hook(mine, alert(70001))).body.results as { status: string }[])[0]!.status).toBe("created");
    // a repeat later folds onto the existing issue and is free
    setClock(() => T0 + 2 * 3_600_000 + 5 * 60_000);
    expect(((await hook(mine, alert(70001))).body.results as { status: string }[])[0]!.status).toBe("deduped");
    expect(((await hook(mine, alert(70002))).body.results as { status: string }[])[0]!.status).toBe("created");
    const over = await hook(mine, alert(70003));
    expect(over.status).toBe(429);
    expect(await db.select().from(issues).where(eq(issues.intakeFingerprint, "glitchtip:errors.pacehq.io/pace/70003"))).toHaveLength(0);

    const other = await hook(OTHER_TOKEN, alert(70003));
    expect(other.status).toBe(200);
    expect((other.body.results as { status: string; teamKey: string }[])[0]).toMatchObject({ status: "created", teamKey: "OTH" });

    setClock(() => T0 + 2 * 3_600_000 + 61 * 60_000);
    expect((await hook(mine, alert(70003))).status).toBe(200);
  });
});
