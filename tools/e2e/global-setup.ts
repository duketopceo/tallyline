import { mkdirSync } from "node:fs";
import path from "node:path";
import { request } from "@playwright/test";

const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3110"}`;
const API = `http://localhost:${process.env.E2E_API_PORT ?? "4100"}`;
const EMAIL = process.env.E2E_EMAIL ?? "e2e@tallyline.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-test-password-42";

// Bootstrap once per deployment. If a workspace already exists, the e2e
// user joins through the real invite flow: E2E_ADMIN_* creds log in as an
// existing admin, create a bound invite, and accept-invite claims it.
export default async function globalSetup() {
  const ctx = await request.newContext();
  const boot = await ctx.post(`${API}/v1/auth/bootstrap`, {
    data: {
      workspaceSlug: "e2e",
      workspaceName: "E2E",
      teamKey: "E2E",
      email: EMAIL,
      name: "E2E Runner",
      password: PASSWORD,
    },
  });
  if (!boot.ok() && boot.status() !== 403) {
    await ctx.dispose();
    throw new Error(`bootstrap failed: ${boot.status()} ${await boot.text()}`);
  }

  if (boot.status() === 403) {
    // workspace already exists — the e2e user either logs in directly or
    // is onboarded via admin invite (real flow, no raw SQL)
    const login = await ctx.post(`${API}/v1/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    if (!login.ok()) {
      const adminEmail = process.env.E2E_ADMIN_EMAIL;
      const adminPassword = process.env.E2E_ADMIN_PASSWORD;
      if (!adminEmail || !adminPassword) {
        await ctx.dispose();
        throw new Error(
          "workspace exists and e2e user can't log in — set E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD to an admin account so setup can invite the runner",
        );
      }
      const admin = await request.newContext();
      const adminLogin = await admin.post(`${API}/v1/auth/login`, {
        data: { email: adminEmail, password: adminPassword },
      });
      if (!adminLogin.ok()) {
        await admin.dispose();
        await ctx.dispose();
        throw new Error(`E2E admin login failed: ${adminLogin.status()}`);
      }
      const me = await admin.get(`${API}/v1/me`);
      const { memberships } = (await me.json()) as {
        memberships: { workspaceSlug: string }[];
      };
      const slug = memberships[0]?.workspaceSlug;
      if (!slug) throw new Error("E2E admin has no workspace membership");
      const invite = await admin.post(`${API}/v1/workspaces/${slug}/invites`, {
        data: { email: EMAIL, role: "member" },
      });
      await admin.dispose();
      if (!invite.ok()) {
        await ctx.dispose();
        throw new Error(`invite create failed: ${invite.status()} ${await invite.text()}`);
      }
      const { joinUrl } = (await invite.json()) as { joinUrl: string };
      const token = joinUrl.split("/join/")[1]!;
      const claim = await ctx.post(`${API}/v1/auth/accept-invite`, {
        data: { token, name: "E2E Runner", password: PASSWORD },
      });
      if (!claim.ok()) {
        await ctx.dispose();
        throw new Error(`invite claim failed: ${claim.status()} ${await claim.text()}`);
      }
    }
  }
  await ctx.dispose();

  const browser = await request.newContext({ baseURL: WEB });
  const web = await browser.post("/api/login", {
    headers: { "sec-fetch-site": "same-origin" },
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!web.ok()) {
    throw new Error(`web login bridge failed: ${web.status()}`);
  }
  const dir = path.join(import.meta.dirname, "tests", ".auth");
  mkdirSync(dir, { recursive: true });
  await browser.storageState({ path: path.join(dir, "session.json") });
  await browser.dispose();
}
