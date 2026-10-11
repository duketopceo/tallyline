import { createHash } from "node:crypto";
import net from "node:net";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../db/client.js";
import {
  accountTokens,
  auditEvents,
  issues,
  sessions,
  users,
  userTokens,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { app } from "../index.js";
import { settleBackground } from "../services/background.js";
import { resetClock, setClock } from "../services/clock.js";
import {
  buildMime,
  clearDevInbox,
  CloudflareMailer,
  createMailer,
  devInbox,
  LogMailer,
  SmtpMailer,
} from "../services/mailer.js";
import { sweepDeletedWorkspaces } from "../services/workspace-lifecycle.js";
import { createInvite } from "../services/invites.js";
import { mkIssue, mkMember, newSession, PASSWORD, seedTenant, type Tenant } from "../../test/tenants.js";

// Account lifecycle: mail transports, password reset, email verification,
// account deletion, workspace soft delete / restore / purge, exports.

async function req(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {},
) {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.cookie ? { cookie: `dok_session=${init.cookie}` } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: res.status, body, text, headers: res.headers };
}

const code = (r: { body: Record<string, unknown> }) =>
  (r.body.error as { code?: string } | undefined)?.code;

function linkToken(text: string, path: string): string {
  const m = text.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`));
  if (!m) throw new Error(`no ${path} link in mail:\n${text}`);
  return m[1]!;
}

async function freshPerson(): Promise<string> {
  const m = await mkMember(A, "member");
  const [u] = await db.select().from(users).where(eq(users.id, m.userId));
  return u!.email;
}

async function mailsTo(email: string) {
  await settleBackground();
  return devInbox().filter((m) => m.to === email);
}

let A: Tenant;

beforeAll(async () => {
  A = await seedTenant("acct", "ACC");
});

afterEach(() => {
  resetClock();
  clearDevInbox();
});

// ── mail transports ──────────────────────────────────────────────────────────

describe("mailer", () => {
  it("defaults to the log transport and rejects broken configs", () => {
    const base = { mailFrom: "T <t@x.test>", smtpUrl: "", cloudflareAccountId: "", cloudflareEmailApiToken: "" };
    expect(createMailer({ ...base, mailTransport: "" }).transport).toBe("log");
    expect(createMailer({ ...base, mailTransport: "log" }).transport).toBe("log");
    expect(() => createMailer({ ...base, mailTransport: "smtp" })).toThrow(/SMTP_URL/);
    expect(() => createMailer({ ...base, mailTransport: "cloudflare" })).toThrow(/CLOUDFLARE/);
    expect(() => createMailer({ ...base, mailTransport: "carrier-pigeon" })).toThrow(/unknown/);
    expect(createMailer({ ...base, mailTransport: "smtp", smtpUrl: "smtp://h:2525" }).transport).toBe("smtp");
  });

  it("log transport captures to the dev inbox", async () => {
    await new LogMailer("T <t@x.test>").send({ kind: "email_verify", to: "a@x.test", subject: "s", text: "hello" });
    expect(devInbox()).toMatchObject([{ to: "a@x.test", subject: "s", text: "hello", from: "T <t@x.test>" }]);
  });

  it("builds a header-injection-safe, dot-stuffed MIME message", () => {
    const mime = buildMime("T <t@x.test>", {
      kind: "email_verify",
      to: "a@x.test",
      subject: "hi\r\nBcc: evil@x.test",
      text: "line\n.dot",
    });
    expect(mime).toContain("Subject: hi Bcc: evil@x.test\r\n");
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).toContain("\r\n..dot");
  });

  it("smtp transport speaks SMTP to a local fake server (AUTH PLAIN, no TLS offered)", async () => {
    const seen: string[] = [];
    const server = net.createServer((sock) => {
      let buf = "";
      let inData = false;
      sock.write("220 fake ESMTP\r\n");
      sock.on("data", (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              sock.write("250 queued\r\n");
            } else seen.push(`DATA:${line}`);
            continue;
          }
          seen.push(line);
          if (line.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("AUTH PLAIN")) sock.write("235 ok\r\n");
          else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) sock.write("250 ok\r\n");
          else if (line === "DATA") {
            inData = true;
            sock.write("354 go\r\n");
          } else if (line === "QUIT") sock.end("221 bye\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const m = new SmtpMailer(`smtp://user%40x:p%40ss@127.0.0.1:${port}`, "Tallyline <no-reply@x.test>");
      await m.send({ kind: "password_reset", to: "Bob <bob@x.test>", subject: "Reset", text: "click" });
    } finally {
      server.close();
    }
    expect(seen).toContain(`AUTH PLAIN ${Buffer.from("\u0000user@x\u0000p@ss").toString("base64")}`);
    expect(seen).toContain("MAIL FROM:<no-reply@x.test>");
    expect(seen).toContain("RCPT TO:<bob@x.test>");
    expect(seen).toContain("DATA:Subject: Reset");
    expect(seen).toContain("DATA:click");
  });

  it("cloudflare transport posts the Email Sending payload (fetch injected, never the network)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;
    await new CloudflareMailer("acct123", "cf-token", "Tallyline <no-reply@x.test>", fake).send({
      kind: "email_verify",
      to: "a@x.test",
      subject: "Confirm",
      text: "link",
    });
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/email/sending/send");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer cf-token");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      to: "a@x.test",
      from: "no-reply@x.test",
      subject: "Confirm",
      text: "link",
    });
    const failing = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(
      new CloudflareMailer("a", "t", "x@x.test", failing).send({ kind: "email_verify", to: "a@x.test", subject: "s", text: "t" }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

// ── password reset ───────────────────────────────────────────────────────────

describe("password reset", () => {
  it("answers 202 with an identical body for known and unknown addresses", async () => {
    const known = await req("/v1/auth/password/forgot", { method: "POST", body: { email: A.people.member.email } });
    const unknown = await req("/v1/auth/password/forgot", { method: "POST", body: { email: "nobody@nowhere.test" } });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.text).toBe(unknown.text);
    expect(await mailsTo("nobody@nowhere.test")).toHaveLength(0);
    expect(await mailsTo(A.people.member.email)).toHaveLength(1);
  });

  it("stores only a hash, is single-use, revokes sessions, keeps PATs, and audits", async () => {
    const who = A.people.owner;
    const s1 = await newSession(A, "owner");
    await req("/v1/auth/password/forgot", { method: "POST", body: { email: who.email.toUpperCase() } });
    const [mail] = await mailsTo(who.email);
    const token = linkToken(mail!.text, "/reset-password");

    const rows = await db.select().from(accountTokens).where(eq(accountTokens.userId, who.id));
    expect(rows.some((r) => r.tokenHash === createHash("sha256").update(token).digest("hex"))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);

    const ok = await req("/v1/auth/password/reset", { method: "POST", body: { token, password: "brand-new-password-1" } });
    expect(ok.status).toBe(200);
    expect(ok.body.sessionsRevoked).toBeGreaterThanOrEqual(1);

    // single use
    const again = await req("/v1/auth/password/reset", { method: "POST", body: { token, password: "another-password-22" } });
    expect(again.status).toBe(400);
    expect(code(again)).toBe("RESET_TOKEN_INVALID");

    // every session is gone, PATs still work
    expect((await req("/v1/auth/me", { cookie: s1 })).status).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, who.id))).toHaveLength(0);
    expect((await req("/v1/whoami", { bearer: A.pats.read })).status).toBe(200);

    // old password out, new password in
    expect((await req("/v1/auth/login", { method: "POST", body: { email: who.email, password: PASSWORD } })).status).toBe(401);
    expect(
      (await req("/v1/auth/login", { method: "POST", body: { email: who.email, password: "brand-new-password-1" } })).status,
    ).toBe(200);

    // confirmation notice went out
    expect((await mailsTo(who.email)).map((m) => m.kind)).toContain("password_changed");

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.userId, who.id));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["password_reset_requested", "password_reset_completed"]),
    );
    expect(JSON.stringify(audit)).not.toContain(who.email);
  });

  it("expires after 30 minutes", async () => {
    const t0 = Date.now();
    setClock(() => t0);
    await req("/v1/auth/password/forgot", { method: "POST", body: { email: A.people.admin.email } });
    const token = linkToken((await mailsTo(A.people.admin.email))[0]!.text, "/reset-password");
    setClock(() => t0 + 31 * 60_000);
    const r = await req("/v1/auth/password/reset", { method: "POST", body: { token, password: "too-late-password" } });
    expect(code(r)).toBe("RESET_TOKEN_INVALID");
  });

  it("sends at most one reset mail per account per minute, and a newer link burns the older one", async () => {
    const t0 = Date.now();
    setClock(() => t0);
    const email = await freshPerson();
    await req("/v1/auth/password/forgot", { method: "POST", body: { email } });
    await req("/v1/auth/password/forgot", { method: "POST", body: { email } });
    expect(await mailsTo(email)).toHaveLength(1);
    const first = linkToken((await mailsTo(email))[0]!.text, "/reset-password");
    setClock(() => t0 + 61_000);
    await req("/v1/auth/password/forgot", { method: "POST", body: { email } });
    expect(await mailsTo(email)).toHaveLength(2);
    const r = await req("/v1/auth/password/reset", { method: "POST", body: { token: first, password: "older-link-password" } });
    expect(code(r)).toBe("RESET_TOKEN_INVALID");
  });
});

// ── email verification ───────────────────────────────────────────────────────

describe("email verification", () => {
  async function claimInvite(email: string) {
    const { token } = await createInvite({
      workspaceId: A.ws.id,
      email,
      role: "admin",
      teamId: null,
      createdBy: A.people.owner.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const r = await req("/v1/auth/accept-invite", {
      method: "POST",
      body: { token, name: "New Person", password: "new-person-password" },
    });
    expect(r.status).toBe(201);
    return r.headers.get("set-cookie")!.match(/dok_session=([^;]+)/)![1]!;
  }

  it("invite claims start unverified: banner flag, no PATs or agent keys until verified", async () => {
    const email = "claimer@matrix.test";
    const cookie = await claimInvite(email);
    const me = await req("/v1/auth/me", { cookie });
    expect(me.body.emailVerified).toBe(false);

    const pat = await req(`/v1/workspaces/${A.ws.slug}/tokens`, {
      method: "POST",
      cookie,
      body: { name: "ci", scopes: ["read"] },
    });
    expect(pat.status).toBe(403);
    expect(code(pat)).toBe("EMAIL_UNVERIFIED");
    const key = await req(`/v1/workspaces/${A.ws.slug}/agents/${A.agent.id}/keys`, {
      method: "POST",
      cookie,
      body: { name: "k", scopes: ["read"] },
    });
    expect(code(key)).toBe("EMAIL_UNVERIFIED");
    // they can still use the product
    expect((await req(`/v1/workspaces/${A.ws.slug}/issues`, { cookie })).status).toBe(200);

    // the claim mailed a link; resending inside a minute is held back, after
    // that it burns the old link and mails a fresh one
    const first = linkToken((await mailsTo(email))[0]!.text, "/verify-email");
    const early = await req("/v1/me/verify-email/resend", { method: "POST", cookie });
    expect(early.body.status).toBe("recently_sent");
    expect(await mailsTo(email)).toHaveLength(1);
    const t0 = Date.now();
    setClock(() => t0 + 61_000);
    const resend = await req("/v1/me/verify-email/resend", { method: "POST", cookie });
    expect(resend.status).toBe(202);
    const mails = await mailsTo(email);
    expect(mails).toHaveLength(2);
    expect(code(await req("/v1/auth/verify-email", { method: "POST", body: { token: first } }))).toBe(
      "VERIFY_TOKEN_INVALID",
    );
    const fresh = linkToken(mails[0]!.text, "/verify-email");
    expect((await req("/v1/auth/verify-email", { method: "POST", body: { token: fresh } })).status).toBe(200);
    expect((await req("/v1/auth/verify-email", { method: "POST", body: { token: fresh } })).status).toBe(400);

    expect((await req("/v1/auth/me", { cookie })).body.emailVerified).toBe(true);
    const pat2 = await req(`/v1/workspaces/${A.ws.slug}/tokens`, {
      method: "POST",
      cookie,
      body: { name: "ci", scopes: ["read"] },
    });
    expect(pat2.status).toBe(201);
    const again = await req("/v1/me/verify-email/resend", { method: "POST", cookie });
    expect(again.body.status).toBe("already_verified");
  });

  it("a verify link is bound to the address it was mailed to", async () => {
    const email = "mover@matrix.test";
    await claimInvite(email);
    const token = linkToken((await mailsTo(email))[0]!.text, "/verify-email");
    await db.update(users).set({ email: "moved@matrix.test" }).where(eq(users.email, email));
    expect(code(await req("/v1/auth/verify-email", { method: "POST", body: { token } }))).toBe("VERIFY_TOKEN_INVALID");
  });

  it("existing and bootstrap accounts are verified", async () => {
    const cookie = await newSession(A, "member");
    expect((await req("/v1/auth/me", { cookie })).body.emailVerified).toBe(true);
  });
});

// ── account deletion ─────────────────────────────────────────────────────────

describe("account deletion", () => {
  it("requires the exact email and refuses a sole owner with a clear next step", async () => {
    const cookie = await newSession(A, "owner");
    const wrong = await req("/v1/me/deletion", { method: "POST", cookie, body: { confirm: "someone@else.test" } });
    expect(code(wrong)).toBe("CONFIRM_MISMATCH");
    const sole = await req("/v1/me/deletion", { method: "POST", cookie, body: { confirm: A.people.owner.email } });
    expect(sole.status).toBe(409);
    expect(code(sole)).toBe("SOLE_OWNER");
    expect((sole.body.error as { message: string }).message).toContain(`Tenant ${A.sentinel}`);
    expect((sole.body.error as { message: string }).message).toMatch(/owner, or delete the workspace/);
  });

  it("deletes the person, their credentials and assignments; workspace content stays", async () => {
    const m = await mkMember(A, "member");
    const [u] = await db.select().from(users).where(eq(users.id, m.userId));
    const issue = await mkIssue(A, { assigneeType: "human", assigneeId: m.userId, creatorId: m.userId });
    const [s] = await db.insert(sessions).values({
      userId: m.userId,
      workspaceId: A.ws.id,
      tokenHash: `h-${m.userId}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning();
    expect(s).toBeTruthy();
    const { createSession } = await import("../services/auth.js");
    const cookie = await createSession(m.userId, A.ws.id);

    const r = await req("/v1/me/deletion", { method: "POST", cookie, body: { confirm: ` ${u!.email.toUpperCase()} ` } });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/dok_session=;/);

    expect(await db.select().from(users).where(eq(users.id, m.userId))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, m.userId))).toHaveLength(0);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, m.userId))).toHaveLength(0);
    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after!.assigneeId).toBeNull();
    expect(after!.title).toBe(issue.title);
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.userId, m.userId), eq(auditEvents.action, "account_deleted")));
    expect(audit).toHaveLength(1);
  });

  it("is allowed for an owner once another owner exists", async () => {
    const t = await seedTenant("co", "COO");
    await db.update(workspaceMembers).set({ role: "owner" }).where(eq(workspaceMembers.id, t.people.admin.memberRowId));
    const cookie = await newSession(t, "owner");
    const r = await req("/v1/me/deletion", { method: "POST", cookie, body: { confirm: t.people.owner.email } });
    expect(r.status).toBe(200);
    // the owner's PATs died with the account
    expect(await db.select().from(userTokens).where(eq(userTokens.userId, t.people.owner.id))).toHaveLength(0);
    expect((await req("/v1/whoami", { bearer: t.pats.read })).status).toBe(401);
  });
});

// ── workspace deletion, restore, purge ───────────────────────────────────────

describe("workspace deletion", () => {
  it("closes the workspace, keeps it restorable for 7 days, then the job purges it", async () => {
    const t = await seedTenant("del", "DEL");
    const owner = await newSession(t, "owner");
    const admin = await newSession(t, "admin");
    const base = `/v1/workspaces/${t.ws.slug}`;

    expect(code(await req(`${base}/deletion`, { method: "POST", cookie: admin, body: { confirm: t.ws.slug } }))).toBe(
      "FORBIDDEN_ROLE",
    );
    expect(code(await req(`${base}/deletion`, { method: "POST", cookie: owner, body: { confirm: "nope" } }))).toBe(
      "CONFIRM_MISMATCH",
    );

    const t0 = Date.now();
    setClock(() => t0);
    const del = await req(`${base}/deletion`, { method: "POST", cookie: owner, body: { confirm: t.ws.slug } });
    expect(del.status).toBe(202);
    expect(new Date(del.body.purgeAfter as string).getTime()).toBe(t0 + 7 * 86_400_000);

    // closed for normal use, every credential class
    const closed = await req(`${base}/issues`, { cookie: owner });
    expect(closed.status).toBe(410);
    expect(code(closed)).toBe("WORKSPACE_DELETED");
    expect((await req(`${base}/issues`, { bearer: t.agentKeys.read })).status).toBe(410);
    // ... but still readable, exportable and restorable
    expect((await req(base, { cookie: owner })).body.deletedAt).toBeTruthy();
    expect((await req(`${base}/export`, { cookie: admin })).status).toBe(200);
    const me = await req("/v1/auth/me", { cookie: owner });
    expect((me.body.memberships as { workspaceSlug: string; purgeAfter: string | null }[]).find((m) => m.workspaceSlug === t.ws.slug)!.purgeAfter).toBeTruthy();
    expect(code(await req(`${base}/deletion`, { method: "POST", cookie: owner, body: { confirm: t.ws.slug } }))).toBe(
      "ALREADY_SCHEDULED",
    );

    // restore inside the window
    expect(code(await req(`${base}/restore`, { method: "POST", cookie: admin }))).toBe("FORBIDDEN_ROLE");
    const restored = await req(`${base}/restore`, { method: "POST", cookie: owner });
    expect(restored.status).toBe(200);
    expect((await req(`${base}/issues`, { cookie: owner })).status).toBe(200);
    expect(code(await req(`${base}/restore`, { method: "POST", cookie: owner }))).toBe("NOT_DELETED");

    // delete again; the job leaves it alone inside the window, purges after
    await req(`${base}/deletion`, { method: "POST", cookie: owner, body: { confirm: t.ws.slug } });
    setClock(() => t0 + 6 * 86_400_000);
    expect(await sweepDeletedWorkspaces()).not.toContain(t.ws.id);
    setClock(() => t0 + 7 * 86_400_000 + 1000);
    expect(await sweepDeletedWorkspaces()).toContain(t.ws.id);
    expect(await db.select().from(workspaces).where(eq(workspaces.id, t.ws.id))).toHaveLength(0);
    expect((await req(base, { cookie: owner })).status).toBe(401); // the session was bound to it
    const purged = await db.select().from(auditEvents).where(eq(auditEvents.action, "workspace_purged"));
    expect(purged.some((a) => (a.meta as { workspaceId?: string }).workspaceId === t.ws.id)).toBe(true);
  });

  it("a workspace pending deletion still blocks its sole owner's account deletion until restored", async () => {
    const t = await seedTenant("own", "OWN");
    const owner = await newSession(t, "owner");
    await req(`/v1/workspaces/${t.ws.slug}/deletion`, { method: "POST", cookie: owner, body: { confirm: t.ws.slug } });
    const blocked = await req("/v1/me/deletion", { method: "POST", cookie: owner, body: { confirm: t.people.owner.email } });
    expect(blocked.status).toBe(409);
    expect(code(blocked)).toBe("SOLE_OWNER");
    await req(`/v1/workspaces/${t.ws.slug}/restore`, { method: "POST", cookie: owner });
    // restored and live again: still the sole owner, so still blocked
    expect((await req("/v1/me/deletion", { method: "POST", cookie: owner, body: { confirm: t.people.owner.email } })).status).toBe(409);
  });
});

// ── exports ──────────────────────────────────────────────────────────────────

describe("exports", () => {
  it("streams a workspace export as a JSON attachment", async () => {
    const r = await req(`/v1/workspaces/${A.ws.slug}/export`, { cookie: await newSession(A, "admin") });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="tallyline-tenant-acct-[a-f0-9]+-\d{4}-\d{2}-\d{2}\.json"/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body.format).toBe("tallyline-workspace-export");
    expect((r.body.tables as Record<string, unknown[]>).issues!.length).toBeGreaterThan(0);
    expect(r.body.attachments).toEqual({ count: 0, items: [] });
  });

  it("personal export holds the profile and activity but no password hash", async () => {
    const cookie = await newSession(A, "member");
    const r = await req("/v1/me/export", { cookie });
    expect(r.status).toBe(200);
    expect(r.body.format).toBe("tallyline-personal-export");
    expect((r.body.profile as { email: string }).email).toBe(A.people.member.email);
    expect((r.body.memberships as unknown[]).length).toBe(1);
    expect(r.text).not.toContain("scrypt$");
    const { rows } = await pool.query(`select password_hash from users where id = $1`, [A.people.member.id]);
    expect(r.text).not.toContain(rows[0].password_hash);
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.userId, A.people.member.id), eq(auditEvents.action, "personal_export")));
    expect(audit).toHaveLength(1);
  });
});

describe("dev inbox", () => {
  it("shows captured mail to instance admins only", async () => {
    const email = await freshPerson();
    await req("/v1/auth/password/forgot", { method: "POST", body: { email } });
    await settleBackground();
    const r = await req("/v1/dev/mail", { cookie: await newSession(A, "owner") });
    expect(r.status).toBe(200);
    expect((r.body.messages as { to: string }[]).some((m) => m.to === email)).toBe(true);
    expect((await req("/v1/dev/mail", { cookie: await newSession(A, "member") })).status).toBe(403);
  });
});
