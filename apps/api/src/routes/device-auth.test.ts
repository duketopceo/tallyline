import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { deviceAuthorizations, events, userTokens } from "../db/schema.js";
import { app } from "../index.js";
import { resetClock, setClock } from "../services/clock.js";
import {
  hashDeviceCode,
  MAX_PENDING_PER_IP,
  normalizeUserCode,
  startDeviceAuthorization,
} from "../services/device-auth.js";
import { newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// S1-U7: RFC 8628 device authorization for the CLI.

let A: Tenant;
let B: Tenant;
let admin: string;
let member: string;
let outsider: string;

beforeAll(async () => {
  A = await seedTenant("dev-a", "DVA");
  B = await seedTenant("dev-b", "DVB");
  admin = `tly_session=${await newSession(A, "admin")}`;
  member = `tly_session=${await newSession(A, "member")}`;
  outsider = `tly_session=${await newSession(B, "admin")}`;
});

afterEach(() => {
  resetClock();
  tick = Date.now();
});

let tick = Date.now();
type Init = RequestInit & { cookie?: string; bearer?: string; ip?: string };
const call = async (path: string, init: Init = {}) => {
  const { cookie, bearer, ip, ...rest } = init;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(ip ? { "cf-connecting-ip": ip } : {}),
      },
    }),
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _text: text };
  }
  return { status: res.status, body, headers: res.headers, text };
};

const start = async (clientName = "Tallyline CLI on test-laptop") => {
  const r = await call("/v1/auth/device/code", { method: "POST", body: JSON.stringify({ clientName }) });
  expect(r.status).toBe(200);
  return {
    deviceCode: r.body.device_code as string,
    userCode: r.body.user_code as string,
    body: r.body,
  };
};
const poll = (deviceCode: string) =>
  call("/v1/auth/device/token", { method: "POST", body: JSON.stringify({ deviceCode }) });
const decide = (userCode: string, decision: "approve" | "deny", cookie = admin, t = A, scopes?: string[]) =>
  call(`/v1/workspaces/${t.ws.slug}/device/${userCode}`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ decision, ...(scopes ? { scopes } : {}) }),
  });
/** poll as a well-behaved client: advance past the interval first */
const patiently = async (deviceCode: string) => {
  tick += 6_000;
  setClock(() => tick);
  return poll(deviceCode);
};

describe("starting", () => {
  it("returns an RFC 8628 response with a short, unambiguous code", async () => {
    const s = await start();
    expect(s.body).toMatchObject({ expires_in: 600, interval: 5 });
    expect(s.userCode).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
    expect(String(s.body.verification_uri)).toMatch(/\/device$/);
    expect(String(s.body.verification_uri_complete)).toContain(`code=${encodeURIComponent(s.userCode)}`);
    expect(s.deviceCode.length).toBeGreaterThanOrEqual(40);
  });

  it("stores only a hash of the device code and never a credential", async () => {
    const s = await start();
    const [row] = await db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hashDeviceCode(s.deviceCode)));
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(s.deviceCode);
    expect(row!.status).toBe("pending");
  });

  it("caps live codes per client address", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < MAX_PENDING_PER_IP; i++) {
      await startDeviceAuthorization({ requestIp: ip });
    }
    const r = await call("/v1/auth/device/code", { method: "POST", body: "{}", ip });
    expect(r.status).toBe(429);
    expect((r.body.error as { code: string }).code).toBe("RATE_LIMITED");
  });
});

describe("the full handshake", () => {
  it("pending until approved, then one token that really works, then never again", async () => {
    const s = await start("Tallyline CLI on kate-mbp");
    expect((await patiently(s.deviceCode)).body.error).toBe("authorization_pending");

    const seen = await call(`/v1/workspaces/${A.ws.slug}/device/${s.userCode}`, { cookie: admin });
    expect(seen.status).toBe(200);
    expect(seen.body.clientName).toBe("Tallyline CLI on kate-mbp");

    expect((await decide(s.userCode, "approve")).status).toBe(200);

    const won = await patiently(s.deviceCode);
    expect(won.status).toBe(200);
    expect(won.headers.get("cache-control")).toBe("no-store");
    expect(won.body).toMatchObject({ token_type: "Bearer", scope: "read write" });
    const token = won.body.access_token as string;
    expect(token).toMatch(/^tly_pat_/);

    const who = await call("/v1/whoami", { bearer: token });
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ type: "human", workspaceSlug: A.ws.slug });

    // the credential is expiring, named for what asked, and bound to the approver
    const mine = (await db.select().from(userTokens).where(eq(userTokens.workspaceId, A.ws.id))).find((t) =>
      t.name.includes("kate-mbp"),
    )!;
    expect(mine.name).toBe("Tallyline CLI on kate-mbp (device sign-in)");
    expect(mine.expiresAt).not.toBeNull();
    expect(mine.userId).toBe(A.people.admin.id);

    // replay: the device code can never yield a second credential
    const again = await patiently(s.deviceCode);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("expired_token");
  });

  it("two simultaneous polls after approval mint exactly one token", async () => {
    const s = await start("race client");
    await decide(s.userCode, "approve");
    tick += 6_000;
    setClock(() => tick);
    // the second poll lands inside the interval window too, so make that
    // irrelevant by clearing it: this isolates the consume race
    await db
      .update(deviceAuthorizations)
      .set({ lastPolledAt: null })
      .where(eq(deviceAuthorizations.deviceCodeHash, hashDeviceCode(s.deviceCode)));
    const results = await Promise.all([poll(s.deviceCode), poll(s.deviceCode), poll(s.deviceCode)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const minted = (await db.select().from(userTokens).where(eq(userTokens.workspaceId, A.ws.id))).filter((t) =>
      t.name.startsWith("race client"),
    );
    expect(minted).toHaveLength(1);
  });

  it("honours the scopes the approver chose", async () => {
    const s = await start("read-only client");
    expect((await decide(s.userCode, "approve", admin, A, ["read"])).status).toBe(200);
    const won = await patiently(s.deviceCode);
    expect(won.body.scope).toBe("read");
    const write = await call(`/v1/workspaces/${A.ws.slug}/issues`, {
      method: "POST",
      bearer: won.body.access_token as string,
      body: JSON.stringify({ teamId: A.team.id, title: "should be refused" }),
    });
    expect(write.status).toBe(403);
  });

  it("deny ends it with access_denied", async () => {
    const s = await start();
    expect((await decide(s.userCode, "deny")).status).toBe(200);
    const r = await patiently(s.deviceCode);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("access_denied");
  });

  it("the code is accepted in any case and with or without the dash", async () => {
    const s = await start();
    const sloppy = ` ${s.userCode.toLowerCase().replace("-", " ")} `;
    expect(normalizeUserCode(sloppy)).toBe(s.userCode.replace("-", ""));
    expect((await decide(sloppy.trim().replace(" ", ""), "approve")).status).toBe(200);
  });

  it("expires after ten minutes", async () => {
    const s = await start();
    await patiently(s.deviceCode);
    tick += 601_000;
    setClock(() => tick);
    expect((await poll(s.deviceCode)).body.error).toBe("expired_token");
    expect((await decide(s.userCode, "approve")).status).toBe(404);
  });

  it("an unknown device code is just expired_token", async () => {
    const r = await poll("x".repeat(43));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("expired_token");
  });

  it("polling too fast is told to slow down, and the interval grows", async () => {
    const s = await start();
    tick += 6_000;
    setClock(() => tick);
    expect((await poll(s.deviceCode)).body.error).toBe("authorization_pending");
    const fast = await poll(s.deviceCode);
    expect(fast.body).toMatchObject({ error: "slow_down", interval: 10 });
    tick += 6_000; // inside the new 10s interval
    setClock(() => tick);
    expect((await poll(s.deviceCode)).body.error).toBe("slow_down");
  });
});

describe("who may approve", () => {
  it("a code is single-use: deciding twice, or a wrong code, gets the same 404", async () => {
    const s = await start();
    expect((await decide(s.userCode, "approve")).status).toBe(200);
    const twice = await decide(s.userCode, "approve");
    const wrong = await decide("BCDF-GHJK", "approve");
    const short = await decide("ABC", "approve");
    for (const r of [twice, wrong, short]) {
      expect(r.status).toBe(404);
      expect(r.body.error).toEqual(wrong.body.error);
    }
  });

  it("members, other workspaces' admins, delegated tokens and agent keys cannot approve", async () => {
    const s = await start();
    expect((await decide(s.userCode, "approve", member)).status).toBe(403);
    expect((await decide(s.userCode, "approve", outsider, A)).status).toBe(403);
    const agent = await call(`/v1/workspaces/${A.ws.slug}/device/${s.userCode}`, {
      method: "POST",
      bearer: A.agentKeys.write,
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(agent.status).toBe(403);
    const anon = await call(`/v1/workspaces/${A.ws.slug}/device/${s.userCode}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(anon.status).toBe(401);
    // still pending after all of that
    expect((await patiently(s.deviceCode)).body.error).toBe("authorization_pending");
  });

  it("records who approved in the workspace feed, without the code", async () => {
    const s = await start("audit client");
    await decide(s.userCode, "approve");
    const feed = await db.select().from(events).where(eq(events.workspaceId, A.ws.id));
    const hit = feed.find((e) => e.action === "device_authorized" && JSON.stringify(e.after).includes("audit client"));
    expect(hit).toBeDefined();
    expect(hit!.actorId).toBe(A.people.admin.id);
    expect(JSON.stringify(hit)).not.toContain(s.userCode);
  });
});
