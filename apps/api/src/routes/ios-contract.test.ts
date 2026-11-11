import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { APPLE_JWKS_URL } from "../auth/apple-identity.js";
import { __setProviderFetchForTests } from "../auth/providers/types.js";
import { db } from "../db/client.js";
import { authIdentities } from "../db/schema.js";
import { config_ } from "../env.js";
import { app } from "../index.js";
import { mkCycle, mkDispatch, mkIssue, mkLabel, mkMilestone, mkProject, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// The iOS client's wire contract. Every response the app decodes is captured
// here from the real routes and checked against the JSON fixtures that
// apps/ios TallylineCore tests decode. If a route's shape changes, this fails
// until the fixture is refreshed, and then the Swift decode tests run on it:
//
//   IOS_FIXTURES=write pnpm --filter @tallyline/api exec vitest run src/routes/ios-contract.test.ts

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../ios/Tests/TallylineCoreTests/Fixtures",
);
const WRITE = process.env.IOS_FIXTURES === "write";

let A: Tenant;
let token: string;

const call = async (path: string, init: RequestInit & { cookie?: string; bearer?: string; key?: string } = {}) => {
  const { cookie, bearer, key, ...rest } = init;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
    }),
  );
  return { status: res.status, body: (await res.json()) as unknown };
};

/** Structural fingerprint: key names and JSON types, recursively. Arrays use their first element. */
function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, shape((v as Record<string, unknown>)[k])]),
    );
  }
  return typeof v;
}

/**
 * Nullable columns may be null in one capture and set in another; treat
 * "null" as matching any type so the check flags only added or removed keys
 * and real type changes.
 */
function sameShape(a: unknown, b: unknown, path = "$"): string[] {
  if (a === "null" || b === "null") return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (!a.length || !b.length) return [];
    return sameShape(a[0], b[0], `${path}[0]`);
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    const missing = ka.filter((k) => !kb.includes(k)).map((k) => `${path}.${k} removed`);
    const added = kb.filter((k) => !ka.includes(k)).map((k) => `${path}.${k} added`);
    const nested = ka
      .filter((k) => kb.includes(k))
      .flatMap((k) => sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
    return [...missing, ...added, ...nested];
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
}

/** Credentials never land in a checked-in file, even short-lived test ones. */
const redact = (body: unknown): unknown =>
  JSON.parse(JSON.stringify(body), (k, v: unknown) => (k === "token" && typeof v === "string" ? "tly_pat_REDACTED" : v));

function check(name: string, body: unknown) {
  const file = resolve(FIXTURES, `${name}.json`);
  if (WRITE) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${JSON.stringify(redact(body), null, 2)}\n`);
    return;
  }
  expect(existsSync(file), `missing fixture ${name}.json; run with IOS_FIXTURES=write`).toBe(true);
  const fixture = JSON.parse(readFileSync(file, "utf8")) as unknown;
  expect(sameShape(shape(fixture), shape(body)), `${name}.json is stale; run with IOS_FIXTURES=write`).toEqual([]);
}

beforeAll(async () => {
  A = await seedTenant("ios-contract", "IOS");
  const member = `tly_session=${await newSession(A, "member")}`;
  const minted = await call(`/v1/workspaces/${A.ws.slug}/devices/pairing`, { method: "POST", cookie: member, body: "{}" });
  const code = (minted.body as { code: string }).code;
  const redeemed = await call("/v1/auth/pair/redeem", {
    method: "POST",
    body: JSON.stringify({ code, deviceName: "Test phone", platform: "ios" }),
  });
  expect(redeemed.status).toBe(200);
  check("pair_redeem", redeemed.body);
  token = (redeemed.body as { token: string }).token;
});

describe("iOS wire contract", () => {
  const ws = () => `/v1/workspaces/${A.ws.slug}`;

  it("whoami as a paired device", async () => {
    const r = await call("/v1/whoami", { bearer: token });
    expect(r.status).toBe(200);
    check("whoami", r.body);
  });

  it("issue list, delta list, detail", async () => {
    const issue = await mkIssue(A, { state: "triage", priority: "high", estimate: 3, dueDate: new Date("2026-11-01T00:00:00Z") });
    const list = await call(`${ws()}/issues?state=triage`, { bearer: token });
    expect(list.status).toBe(200);
    check("issues_list", list.body);
    const delta = await call(`${ws()}/issues?updatedSince=${encodeURIComponent("2000-01-01T00:00:00.000Z")}`, { bearer: token });
    expect(delta.status).toBe(200);
    check("issues_delta", delta.body);
    const detail = await call(`${ws()}/issues/${issue.key}`, { bearer: token });
    expect(detail.status).toBe(200);
    check("issue_detail", detail.body);
  });

  it("create, patch, comment (with idempotency keys)", async () => {
    const created = await call(`${ws()}/issues`, {
      method: "POST",
      bearer: token,
      key: "ios-contract-create",
      body: JSON.stringify({ title: "From the phone", teamId: A.team.id, priority: "medium" }),
    });
    expect(created.status).toBe(201);
    check("issue_create", created.body);
    const key = (created.body as { key: string }).key;
    const patched = await call(`${ws()}/issues/${key}`, {
      method: "PATCH",
      bearer: token,
      key: "ios-contract-patch",
      body: JSON.stringify({ state: "todo" }),
    });
    expect(patched.status).toBe(200);
    check("issue_patch", patched.body);
    const comment = await call(`${ws()}/issues/${key}/comments`, {
      method: "POST",
      bearer: token,
      key: "ios-contract-comment",
      body: JSON.stringify({ body: "Looks right" }),
    });
    expect(comment.status).toBe(201);
    check("comment_create", comment.body);
    const comments = await call(`${ws()}/issues/${key}/comments`, { bearer: token });
    check("comments_list", comments.body);
  });

  it("pickers: teams, projects, cycles, labels, members", async () => {
    await mkProject(A);
    await mkCycle(A);
    await mkLabel(A);
    for (const [name, path] of [
      ["teams", "/teams"],
      ["projects", "/projects"],
      ["cycles", "/cycles"],
      ["labels", "/labels"],
      ["members", "/members"],
    ] as const) {
      const r = await call(`${ws()}${path}`, { bearer: token });
      expect(r.status, name).toBe(200);
      check(name, r.body);
    }
  });

  it("roadmap summary and milestones", async () => {
    const project = await mkProject(A);
    await mkMilestone(A, project.id);
    await mkIssue(A, { projectId: project.id, state: "done" });
    const milestones = await call(`${ws()}/milestones`, { bearer: token });
    expect(milestones.status).toBe(200);
    check("milestones", milestones.body);
    const summary = await call(`${ws()}/roadmap/summary`, { bearer: token });
    expect(summary.status).toBe(200);
    // byState (keyed by whatever states exist) and recent are not decoded by the app
    const body = summary.body as { projects: Record<string, unknown>[] };
    check("roadmap_summary", {
      ...body,
      projects: body.projects.map(({ byState: _b, recent: _r, ...rest }) => rest),
    });
  });

  it("apple sign-in returns the pairing credential", async () => {
    const prevBundles = [...config_.appleBundleIds];
    const prevClient = config_.appleClientId;
    const mutable = config_ as { appleBundleIds: string[]; appleClientId: string };
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "contract-kid", alg: "RS256", use: "sig" };
    const rawNonce = "client-nonce-1";
    const sub = "apple-sub-contract";
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "contract-kid" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://appleid.apple.com",
        aud: "app.tallyline.ios",
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub,
        email: A.people.member.email,
        email_verified: "true",
        nonce: createHash("sha256").update(rawNonce, "utf8").digest("hex"),
      }),
    ).toString("base64url");
    const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign({ key: privateKey });
    const identityToken = `${header}.${payload}.${sig.toString("base64url")}`;
    try {
      mutable.appleBundleIds = ["app.tallyline.ios"];
      mutable.appleClientId = "";
      __setProviderFetchForTests(async (url) => {
        if (url !== APPLE_JWKS_URL) throw new Error(`unexpected fetch ${url}`);
        return { ok: true, status: 200, json: async () => ({ keys: [jwk] }), text: async () => "" };
      });
      await db.insert(authIdentities).values({
        userId: A.people.member.id,
        providerKey: "apple",
        providerSubject: sub,
        email: A.people.member.email,
        emailVerified: true,
      });
      const r = await call("/v1/auth/apple", {
        method: "POST",
        body: JSON.stringify({
          identityToken,
          rawNonce,
          deviceName: "Luke's iPhone",
          platform: "ios",
        }),
      });
      expect(r.status).toBe(200);
      const body = r.body as { token: string; scopes: string[]; workspace: { slug: string; name: string } };
      expect(body.token).toMatch(/^tly_pat_/);
      expect(body.scopes).toEqual(["read", "write"]);
      expect(body.workspace.slug).toBe(A.ws.slug);
      expect(body.workspace.name.length).toBeGreaterThan(0);
      check("apple_sign_in", r.body);
    } finally {
      mutable.appleBundleIds = prevBundles;
      mutable.appleClientId = prevClient;
      __setProviderFetchForTests(null);
    }
  });

  it("review queue", async () => {
    const issue = await mkIssue(A, { state: "in_review" });
    await mkDispatch(A, issue.id);
    const r = await call(`${ws()}/review-queue`, { bearer: token });
    expect(r.status).toBe(200);
    expect((r.body as { queue: unknown[] }).queue.length).toBeGreaterThan(0);
    check("review_queue", r.body);
  });
});
