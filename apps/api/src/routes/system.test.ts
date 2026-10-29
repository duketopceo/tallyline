import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { aiProviders } from "../db/schema.js";
import { config_ } from "../env.js";
import { app } from "../index.js";
import { urlIssues } from "../services/system-status.js";
import { newSession, seedTenant, type Tenant } from "../../test/tenants.js";
import { eq } from "drizzle-orm";

// S2-U3: GET /system/status feeds the first-run checklist. Admin only; yes/no
// state and public addresses, never a secret; a backup that is not configured
// is an attention state, not a failure.

let A: Tenant;
let B: Tenant;
let admin: string;
let member: string;
let bAdmin: string;

const mutable = config_ as unknown as Record<string, unknown>;
const saved = {
  mailTransport: config_.mailTransport,
  smtpUrl: config_.smtpUrl,
  webUrl: config_.webUrl,
  apiBaseUrl: config_.apiBaseUrl,
  githubClientId: config_.githubClientId,
  authDisablePassword: config_.authDisablePassword,
  authSecretKey: config_.authSecretKey,
  llmApiKey: config_.llmApiKey,
};
const savedMarker = process.env.TALLYLINE_BACKUP_MARKER;
const savedRev = process.env.TALLYLINE_REVISION;
let dir: string | null = null;

beforeAll(async () => {
  A = await seedTenant("sys-a", "SYA");
  B = await seedTenant("sys-b", "SYB");
  admin = `tly_session=${await newSession(A, "admin")}`;
  member = `tly_session=${await newSession(A, "member")}`;
  bAdmin = `tly_session=${await newSession(B, "admin")}`;
});

afterEach(async () => {
  Object.assign(mutable, saved);
  if (savedMarker === undefined) delete process.env.TALLYLINE_BACKUP_MARKER;
  else process.env.TALLYLINE_BACKUP_MARKER = savedMarker;
  if (savedRev === undefined) delete process.env.TALLYLINE_REVISION;
  else process.env.TALLYLINE_REVISION = savedRev;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const status = async (t: Tenant, cookie?: string) => {
  const res = await app.fetch(
    new Request(`http://api.test/v1/workspaces/${t.ws.slug}/system/status`, {
      headers: cookie ? { cookie } : {},
    }),
  );
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, any>, headers: res.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe("who may read it", () => {
  it("admins can; members, anonymous callers and other workspaces cannot", async () => {
    expect((await status(A, admin)).status).toBe(200);
    expect((await status(A, member)).status).toBe(403);
    expect((await status(A)).status).toBe(401);
    expect((await status(A, bAdmin)).status).toBe(403);
  });
  it("is never cached", async () => {
    expect((await status(A, admin)).headers.get("cache-control")).toBe("no-store");
  });
});

describe("what it reports", () => {
  it("database, counts and the build the operator set", async () => {
    process.env.TALLYLINE_REVISION = "abc1234";
    const r = await status(A, admin);
    expect(r.body.database.ok).toBe(true);
    expect(typeof r.body.database.latencyMs).toBe("number");
    expect(r.body.revision).toBe("abc1234");
    expect(r.body.workspace.members).toBeGreaterThanOrEqual(3);
    expect(r.body.workspace.issues).toBeGreaterThanOrEqual(0);
    expect(typeof r.body.checkedAt).toBe("string");
  });
  it("counts only this workspace", async () => {
    const a = await status(A, admin);
    const b = await status(B, bAdmin);
    expect(a.body.workspace.members).not.toBe(0);
    expect(b.body.workspace.members).toBeGreaterThanOrEqual(1);
  });
  it("backups: not configured is an attention state, then none yet, ok and stale", async () => {
    delete process.env.TALLYLINE_BACKUP_MARKER;
    expect((await status(A, admin)).body.backup).toEqual({ state: "not_configured", lastBackupAt: null, ageHours: null });
    dir = await mkdtemp(join(tmpdir(), "tly-marker-"));
    const marker = join(dir, "last-backup");
    process.env.TALLYLINE_BACKUP_MARKER = marker;
    expect((await status(A, admin)).body.backup.state).toBe("none_yet");
    await writeFile(marker, "");
    const fresh = (await status(A, admin)).body.backup;
    expect(fresh.state).toBe("ok");
    expect(fresh.ageHours).toBeLessThan(1);
    const old = new Date(Date.now() - 72 * 3_600_000);
    await utimes(marker, old, old);
    const stale = (await status(A, admin)).body.backup;
    expect(stale.state).toBe("stale");
    expect(stale.ageHours).toBeGreaterThan(48);
  });
  it("email: log transport is not configured; smtp with a url is", async () => {
    mutable.mailTransport = "log";
    expect((await status(A, admin)).body.email).toEqual({ transport: "log", configured: false });
    mutable.mailTransport = "smtp";
    mutable.smtpUrl = "smtp://user:hunter2@mail.example.test:587";
    const r = await status(A, admin);
    expect(r.body.email).toEqual({ transport: "smtp", configured: true });
    expect(r.text).not.toContain("hunter2");
  });
  it("sign-in: password flag and configured providers by name only", async () => {
    mutable.githubClientId = "gh-client-id-xyz";
    mutable.authDisablePassword = true;
    const r = await status(A, admin);
    expect(r.body.signIn.password).toBe(false);
    expect(r.body.signIn.providers).toContainEqual({ key: "github", type: "github", label: "GitHub", source: "env" });
    expect(r.text).not.toContain("gh-client-id-xyz");
  });
  it("AI: a saved key the server can no longer read is reported, not a 409", async () => {
    // the tenant seed sealed its provider with a different AUTH_SECRET_KEY
    const r = await status(A, admin);
    expect(r.status).toBe(200);
    expect(r.body.ai).toEqual({ configured: false, provider: null, problem: "AI_KEY_UNREADABLE" });
  });
  it("AI: not configured, then an environment provider without its key", async () => {
    await db.delete(aiProviders).where(eq(aiProviders.workspaceId, A.ws.id));
    mutable.llmApiKey = "";
    expect((await status(A, admin)).body.ai).toEqual({ configured: false, provider: null, problem: null });
    mutable.llmApiKey = "sk-env-secret-value-123";
    const r = await status(A, admin);
    expect(r.body.ai.configured).toBe(true);
    expect(r.body.ai.provider.hasKey).toBe(true);
    expect(r.text).not.toContain("sk-env-secret-value-123");
  });
  it("never includes a secret-shaped field", async () => {
    mutable.authSecretKey = "super-secret-auth-key-0123456789-abcdef";
    const r = await status(A, admin);
    expect(r.text).not.toContain("super-secret-auth-key");
    expect(r.text).not.toMatch(/secret|password":"|token|apiKey/i);
  });
});

describe("public address check", () => {
  it("flags this-computer and plain-http addresses in plain words", () => {
    expect(urlIssues("https://tally.example.com", "https://api.tally.example.com")).toEqual([]);
    expect(urlIssues("http://localhost:3100", "https://api.example.com")).toEqual([
      "The web address points at this computer, so nobody else can reach it.",
    ]);
    expect(urlIssues("https://a.example.com", "http://api.example.com")[0]).toContain("not https");
    expect(urlIssues("not a url", "https://a.example.com")[0]).toContain("not a valid address");
  });
});
