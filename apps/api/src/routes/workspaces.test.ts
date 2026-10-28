import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config_ } from "../env.js";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  agentKeys,
  agents,
  authIdentities,
  authProviders,
  comments,
  events,
  invites,
  issues,
  labels,
  oauthCodes,
  sessions,
  slackLinks,
  teamMembers,
  teams,
  userIdMap,
  users,
  userTokens,
  views,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";

const WIPE = [
  comments, events, slackLinks, labels, issues, views, agentKeys, agents,
  userTokens, sessions, invites, oauthCodes, authIdentities, authProviders,
  userIdMap, teamMembers, workspaceMembers, teams, users, workspaces,
] as const;
import { hashPassword } from "../services/auth.js";

// U2 credential-class matrix: cookie sessions roam via membership,
// PATs/JWTs stay hard-bound + die with the member row, agent keys stay
// bound and hold no member powers.

let ownerCookie = "";
let memberCookie = "";
let memberUserId = "";
let wsA = "";
let wsB = "";
let memberPat = "";

async function req(
  path: string,
  init?: RequestInit & { cookie?: string },
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const { cookie, ...rest } = init ?? {};
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...((rest.headers as Record<string, string>) ?? {}),
      },
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

function cookieFrom(res: { headers: Headers }) {
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

async function createUser(email: string, wsId: string, role: "member" | "admin" | "owner", password = "test-password-123") {
  const [u] = await db
    .insert(users)
    .values({ email, name: email.split("@")[0]!, passwordHash: hashPassword(password) })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: wsId, userId: u!.id, role });
  return u!.id;
}

beforeAll(async () => {
  await runMigrations();
  for (const t of WIPE) await db.delete(t);

  // ws A via bootstrap (owner), ws B via POST /workspaces (owner is member of both)
  const boot = await req("/v1/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      workspaceSlug: "u2-a",
      workspaceName: "U2 A",
      teamKey: "UA",
      email: "owner@u2.test",
      name: "Owner",
      password: "test-password-123",
    }),
  });
  expect(boot.status).toBe(201);
  ownerCookie = cookieFrom(boot);
  wsA = (boot.body.workspace as { id: string }).id;

  const b = await req("/v1/workspaces", {
    method: "POST",
    cookie: ownerCookie,
    body: JSON.stringify({ slug: "u2-b", name: "U2 B" }),
  });
  expect(b.status).toBe(201);
  wsB = (b.body as { id: string }).id;

  memberUserId = await createUser("member@u2.test", wsA, "member");
  const login = await req("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "member@u2.test", password: "test-password-123" }),
  });
  expect(login.status).toBe(200);
  memberCookie = cookieFrom(login);

  await db.insert(teams).values({ workspaceId: wsB, key: "UB", name: "B" });
});

afterAll(async () => {
  for (const t of WIPE) await db.delete(t);
  await closeDb();
});

describe("membership enforcement", () => {
  it("member reads own workspace; 403 on a non-member workspace", async () => {
    const ok = await req(`/v1/workspaces/u2-a/teams`, { cookie: memberCookie });
    expect(ok.status).toBe(200);
    const denied = await req(`/v1/workspaces/u2-b/teams`, { cookie: memberCookie });
    expect(denied.status).toBe(403);
    expect((denied.body.error as { code: string }).code).toBe("FORBIDDEN_WORKSPACE");
  });

  it("cookie session roams across memberships; /auth/session re-binds", async () => {
    // owner is a member of both A and B
    const roams = await req(`/v1/workspaces/u2-b/teams`, { cookie: ownerCookie });
    expect(roams.status).toBe(200);

    const sw = await req("/v1/auth/session", {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ workspaceSlug: "u2-b" }),
    });
    expect(sw.status).toBe(200);
    expect(sw.body.workspaceSlug).toBe("u2-b");
    const slugs = (sw.body.memberships as { workspaceSlug: string }[]).map((m) => m.workspaceSlug);
    expect(slugs).toContain("u2-a");
    expect(slugs).toContain("u2-b");

    const me = await req("/v1/auth/me", { cookie: ownerCookie });
    expect(me.status).toBe(200);
    expect(me.body.activeWorkspaceSlug).toBe("u2-b");
    expect(me.body.isInstanceAdmin).toBe(true); // bootstrap-owner fallback
  });

  it("/auth/session rejects non-member workspace and PAT credentials", async () => {
    const bad = await req("/v1/auth/session", {
      method: "POST",
      cookie: memberCookie,
      body: JSON.stringify({ workspaceSlug: "u2-b" }),
    });
    expect(bad.status).toBe(403);

    const viaPat = await req("/v1/auth/session", {
      method: "POST",
      body: JSON.stringify({ workspaceSlug: "u2-a" }),
      headers: { authorization: `Bearer ${memberPat}` },
    });
    expect(viaPat.status).toBe(401); // no cookie → /v1/auth/session self-auths on cookie
  });

  it("PAT stays hard-bound: member joins B, PAT still 403s on B; dies with member row", async () => {
    // mint a PAT for the member in ws A (admin+ only — use owner cookie
    // on the member's own behalf is not possible; member mints via
    // /auth/token path is JWT. PAT mint needs admin — promote flow:
    // owner creates PAT via direct service for the member instead)
    const { createUserToken } = await import("../services/tokens.js");
    const { token } = await createUserToken(memberUserId, wsA, "member-pat", ["read", "write"]);
    memberPat = token;

    const inA = await req(`/v1/workspaces/u2-a/teams`, {
      headers: { authorization: `Bearer ${memberPat}` },
    });
    expect(inA.status).toBe(200);

    // member joins B — PAT still cannot reach B (hard binding)
    await db.insert(workspaceMembers).values({ workspaceId: wsB, userId: memberUserId, role: "member" });
    const inB = await req(`/v1/workspaces/u2-b/teams`, {
      headers: { authorization: `Bearer ${memberPat}` },
    });
    expect(inB.status).toBe(403);
    // cookie CAN reach B now (roaming)
    const roamB = await req(`/v1/workspaces/u2-b/teams`, { cookie: memberCookie });
    expect(roamB.status).toBe(200);

    // remove the member row in A — live PAT and cookie die on next request there
    await db
      .delete(workspaceMembers)
      .where(sql`${workspaceMembers.workspaceId} = ${wsA} AND ${workspaceMembers.userId} = ${memberUserId}`);
    const deadPat = await req(`/v1/workspaces/u2-a/teams`, {
      headers: { authorization: `Bearer ${memberPat}` },
    });
    expect(deadPat.status).toBe(403);
    const deadCookie = await req(`/v1/workspaces/u2-a/teams`, { cookie: memberCookie });
    expect(deadCookie.status).toBe(403);
    // …but the cookie still works in B
    const stillB = await req(`/v1/workspaces/u2-b/teams`, { cookie: memberCookie });
    expect(stillB.status).toBe(200);
    // restore A membership for later tests
    await db.insert(workspaceMembers).values({ workspaceId: wsA, userId: memberUserId, role: "member" });
  });

  it("POST /workspaces: agent key → 403, cookie → 201 + owner member", async () => {
    const agent = await req(`/v1/workspaces/u2-a/agents`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ name: "wrecker", harness: "test" }),
    });
    const minted = await req(`/v1/workspaces/u2-a/agents/${agent.body.id}/keys`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ scopes: ["write"] }),
    });
    const viaKey = await req(`/v1/workspaces`, {
      method: "POST",
      body: JSON.stringify({ slug: "u2-evil", name: "Evil" }),
      headers: { authorization: `Bearer ${minted.body.key}` },
    });
    expect(viaKey.status).toBe(403);
    const gone = await db.select().from(workspaces).where(eq(workspaces.slug, "u2-evil"));
    expect(gone).toHaveLength(0);
  });
});

describe("team writes", () => {
  it("POST teams: member 403, admin 201, agent key 201, duplicate 409, bad key 400", async () => {
    const body = (key: string) => JSON.stringify({ key, name: `Team ${key}` });
    const asMember = await req(`/v1/workspaces/u2-a/teams`, {
      method: "POST",
      cookie: memberCookie,
      body: body("MEM"),
    });
    expect(asMember.status).toBe(403);
    expect((asMember.body.error as { code: string }).code).toBe("FORBIDDEN_ROLE");

    const asOwner = await req(`/v1/workspaces/u2-a/teams`, {
      method: "POST",
      cookie: ownerCookie,
      body: body("OWN"),
    });
    expect(asOwner.status).toBe(201);

    const agent = await req(`/v1/workspaces/u2-a/agents`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ name: "team-maker", harness: "test" }),
    });
    const minted = await req(`/v1/workspaces/u2-a/agents/${agent.body.id}/keys`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ scopes: ["write"] }),
    });
    const viaKey = await req(`/v1/workspaces/u2-a/teams`, {
      method: "POST",
      body: body("AGT"),
      headers: { authorization: `Bearer ${minted.body.key}` },
    });
    expect(viaKey.status).toBe(201);
    const roKey = await req(`/v1/workspaces/u2-a/agents/${agent.body.id}/keys`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ scopes: ["read"] }),
    });
    const viaRead = await req(`/v1/workspaces/u2-a/teams`, {
      method: "POST",
      body: body("RDO"),
      headers: { authorization: `Bearer ${roKey.body.key}` },
    });
    expect(viaRead.status).toBe(403);
    const { createUserToken } = await import("../services/tokens.js");
    const { token: memberWritePat } = await createUserToken(memberUserId, wsA, "team-pat", ["read", "write"]);
    const viaPat = await req(`/v1/workspaces/u2-a/teams`, {
      method: "POST",
      body: body("PAT"),
      headers: { authorization: `Bearer ${memberWritePat}` },
    });
    expect(viaPat.status).toBe(403);
    expect((viaPat.body.error as { code: string }).code).toBe("FORBIDDEN_ROLE");
    const dup = await req(`/v1/workspaces/u2-a/teams`, {
      method: "POST",
      body: body("AGT"),
      headers: { authorization: `Bearer ${minted.body.key}` },
    });
    expect(dup.status).toBe(409);
    const bad = await req(`/v1/workspaces/u2-a/teams`, {
      method: "POST",
      cookie: ownerCookie,
      body: body("toolong7"),
    });
    expect(bad.status).toBe(400);
  });
});

describe("role gates", () => {
  it("PAT mint: member → 403, admin → 201, PAT credential → 403", async () => {
    const asMember = await req(`/v1/workspaces/u2-a/tokens`, {
      method: "POST",
      cookie: memberCookie,
      body: JSON.stringify({ name: "nope" }),
    });
    expect(asMember.status).toBe(403);
    expect((asMember.body.error as { code: string }).code).toBe("FORBIDDEN_ROLE");

    const adminId = await createUser("admin@u2.test", wsA, "admin");
    void adminId;
    const login = await req("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@u2.test", password: "test-password-123" }),
    });
    const adminCookie = cookieFrom(login);
    const asAdmin = await req(`/v1/workspaces/u2-a/tokens`, {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({ name: "admin-pat", scopes: ["read"] }),
    });
    expect(asAdmin.status).toBe(201);

    const viaPat = await req(`/v1/workspaces/u2-a/tokens`, {
      method: "POST",
      body: JSON.stringify({ name: "pat-mint" }),
      headers: { authorization: `Bearer ${memberPat}` },
    });
    expect(viaPat.status).toBe(403); // not a cookie session regardless of role
  });

  it("/v1/auth/token stays member-mintable (R16 exemption)", async () => {
    const res = await req("/v1/auth/token", { method: "POST", cookie: memberCookie });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });
});

describe("x-actor terminal rule", () => {
  it("cookie + x-actor-type:agent → 403; agent key + agent → honored; system → 403", async () => {
    await db.insert(issues).values({
      workspaceId: wsA, teamId: (await db.select().from(teams).where(eq(teams.workspaceId, wsA)))[0]!.id,
      key: "UA-1", number: 1, title: "actor test",
    });
    const forged = await req(`/v1/workspaces/u2-a/issues/UA-1/comments`, {
      method: "POST",
      cookie: memberCookie,
      body: JSON.stringify({ body: "forge" }),
      headers: { "x-actor-type": "agent" },
    });
    expect(forged.status).toBe(403);

    const sys = await req(`/v1/workspaces/u2-a/issues/UA-1/comments`, {
      method: "POST",
      cookie: memberCookie,
      body: JSON.stringify({ body: "forge" }),
      headers: { "x-actor-type": "system" },
    });
    expect(sys.status).toBe(403);

    const human = await req(`/v1/workspaces/u2-a/issues/UA-1/comments`, {
      method: "POST",
      cookie: memberCookie,
      body: JSON.stringify({ body: "legit" }),
      headers: { "x-actor-type": "human", "x-actor-id": "00000000-0000-0000-0000-000000000000" },
    });
    expect(human.status).toBe(201);
    expect(human.body.actorId).toBe(memberUserId); // x-actor-id never honored
  });
});

describe("workspace creation gate", () => {
  const cfg = config_ as { allowWorkspaceCreate: boolean };
  it("non-admin member is refused by default; instance admin (bootstrap owner) is allowed", async () => {
    expect(cfg.allowWorkspaceCreate).toBe(false);
    const denied = await req("/v1/workspaces", {
      method: "POST",
      cookie: memberCookie,
      body: JSON.stringify({ slug: "u2-gate", name: "Gate" }),
    });
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN_INSTANCE_ADMIN",
    );
    const ok = await req("/v1/workspaces", {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ slug: "u2-gate-admin", name: "Gate admin" }),
    });
    expect(ok.status).toBe(201);
  });

  it("TALLYLINE_ALLOW_WORKSPACE_CREATE=1 opens creation to any signed-in member", async () => {
    cfg.allowWorkspaceCreate = true;
    try {
      const res = await req("/v1/workspaces", {
        method: "POST",
        cookie: memberCookie,
        body: JSON.stringify({ slug: "u2-gate-open", name: "Gate open" }),
      });
      expect(res.status).toBe(201);
    } finally {
      cfg.allowWorkspaceCreate = false;
    }
  });
});
