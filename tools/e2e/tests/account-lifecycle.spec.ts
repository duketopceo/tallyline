import AxeBuilder from "@axe-core/playwright";
import { expect, request, test, type Browser, type Page } from "@playwright/test";

// Account lifecycle end to end: password reset, email verification, exports,
// workspace delete + restore, account deletion. Mail is never sent: the API
// runs the log transport and these tests read the dev inbox (instance-admin
// only) through the signed-in e2e runner.

const API = `http://localhost:${process.env.E2E_API_PORT ?? "4100"}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

interface Mail {
  to: string;
  kind: string;
  text: string;
}

/** latest captured mail of `kind` to `to`, polled (mail is sent in the background) */
async function mailLink(page: Page, to: string, kind: string, path: string): Promise<string> {
  let link = "";
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/dev/mail");
        if (!res.ok()) return "";
        const { messages } = (await res.json()) as { messages: Mail[] };
        const m = messages.find((x) => x.to === to && x.kind === kind);
        link = m?.text.match(new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_-]+`))?.[0] ?? "";
        return link;
      },
      { timeout: 15_000 },
    )
    .not.toBe("");
  return new URL(link).pathname + new URL(link).search;
}

/** a fresh member of the e2e workspace, claimed through the real invite flow */
async function invitedUser(
  page: Page,
  role: "member" | "admin" = "member",
): Promise<{ email: string; password: string }> {
  const email = `lifecycle-${uniq()}@tallyline.test`;
  const password = `pw-${uniq()}-long-enough`;
  const inv = await page.request.post("/api/settings/invites", { data: { email, role } });
  expect(inv.ok(), await inv.text()).toBe(true);
  const { joinUrl } = (await inv.json()) as { joinUrl: string };
  const anon = await request.newContext({ storageState: { cookies: [], origins: [] } });
  const claim = await anon.post(`${API}/v1/auth/accept-invite`, {
    data: { token: joinUrl.split("/join/")[1], name: "Lifecycle Person", password },
  });
  expect(claim.status(), await claim.text()).toBe(201);
  await anon.dispose();
  return { email, password };
}

async function signedInAs(browser: Browser, email: string, password: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await ctx.request.post("/api/login", { data: { email, password } });
  expect(res.ok(), await res.text()).toBe(true);
  return { ctx, page: await ctx.newPage() };
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("password reset: request, emailed link, new password, signed out elsewhere @keyboard", async ({ page, browser }) => {
  const person = await invitedUser(page);
  const other = await signedInAs(browser, person.email, person.password);

  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anon = await ctx.newPage();
  await anon.goto("/login");
  await anon.getByRole("link", { name: "Forgot your password?" }).focus();
  await anon.keyboard.press("Enter");
  await expect(anon.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await anon.getByLabel("Email").fill(person.email);
  await anon.keyboard.press("Enter");
  await expect(anon.getByText("Check your email")).toBeVisible();

  // the same answer for an address with no account (no enumeration)
  const unknown = await ctx.request.post("/api/auth/password/forgot", { data: { email: `ghost-${uniq()}@tallyline.test` } });
  expect(unknown.status()).toBe(202);

  const link = await mailLink(page, person.email, "password_reset", "/reset-password");
  await anon.goto(link);
  const fresh = `new-${uniq()}-password`;
  await anon.getByLabel("New password").fill(fresh);
  await anon.getByLabel("Type it again").fill(fresh);
  await anon.keyboard.press("Enter");
  await expect(anon.getByText("Password changed")).toBeVisible();

  // single use
  await anon.goto(link);
  await anon.getByLabel("New password").fill(`x-${fresh}`);
  await anon.getByLabel("Type it again").fill(`x-${fresh}`);
  await anon.getByRole("button", { name: "Set new password" }).click();
  await expect(anon.getByText(/expired or was already used/)).toBeVisible();

  // the other device was signed out; the new password works
  await other.page.goto("/settings/account");
  await expect(other.page).toHaveURL(/\/login/);
  const login = await ctx.request.post("/api/login", { data: { email: person.email, password: fresh } });
  expect(login.ok()).toBe(true);
  await ctx.close();
  await other.ctx.close();
});

test("email verification: banner and locked credentials until confirmed @keyboard", async ({ page, browser }) => {
  // admin: allowed to mint PATs, so only the verification gate stands in the way
  const person = await invitedUser(page, "admin");
  const { ctx, page: p } = await signedInAs(browser, person.email, person.password);
  await p.goto("/settings/account");
  await expect(p.getByText("Confirm your email to create personal access tokens and agent keys.").first()).toBeVisible();
  await expect(p.getByText("Not confirmed")).toBeVisible();
  const pat = await p.request.post(`${API}/v1/workspaces/e2e/tokens`, { data: { name: "ci", scopes: ["read"] } });
  expect(pat.status()).toBe(403);
  expect(((await pat.json()) as { error: { code: string } }).error.code).toBe("EMAIL_UNVERIFIED");

  await p.getByRole("button", { name: "Send a new link" }).click();
  // the claim mailed a link moments ago, so a resend is held back for a minute
  await expect(p.getByText(/New link sent to|less than a minute ago/).first()).toBeVisible();
  const link = await mailLink(page, person.email, "email_verify", "/verify-email");
  await p.goto(link);
  await p.getByRole("button", { name: "Confirm my email" }).focus();
  await p.keyboard.press("Enter");
  await expect(p.getByText("Email confirmed")).toBeVisible();

  await p.goto("/settings/account");
  await expect(p.getByText("Not confirmed")).toHaveCount(0);
  await expect(p.getByText("Send a new link")).toHaveCount(0);
  const ok = await p.request.post(`${API}/v1/workspaces/e2e/tokens`, { data: { name: "ci", scopes: ["read"] } });
  expect(ok.status(), await ok.text()).toBe(201);
  await ctx.close();
});

test("exports: workspace JSON and personal data download", async ({ page }) => {
  await page.goto("/settings/workspace");
  const [wsFile] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download workspace export" }).first().click(),
  ]);
  const ws = JSON.parse(await streamText(await wsFile.createReadStream())) as {
    format: string;
    workspace: { slug: string };
    tables: Record<string, unknown[]>;
    attachments: { items: unknown[] };
  };
  expect(ws.format).toBe("tallyline-workspace-export");
  expect(ws.workspace.slug).toBe("e2e");
  expect(Array.isArray(ws.tables.issues)).toBe(true);
  expect(ws.attachments.items).toEqual([]);
  expect(JSON.stringify(ws)).not.toContain("scrypt$");

  await page.goto("/settings/account");
  const [me] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download my data" }).click(),
  ]);
  const personal = JSON.parse(await streamText(await me.createReadStream())) as { format: string; profile: { email: string } };
  expect(personal.format).toBe("tallyline-personal-export");
  expect(personal.profile.email).toBeTruthy();
});

test("workspace delete then restore, typing the slug @keyboard", async ({ page }) => {
  const slug = `del-${uniq()}`;
  const created = await page.request.post(`${API}/v1/workspaces`, { data: { slug, name: `Delete me ${slug}` } });
  expect(created.status(), await created.text()).toBe(201);
  const sw = await page.request.post("/api/auth/session", { data: { workspaceSlug: slug } });
  expect(sw.ok()).toBe(true);
  try {
    await page.goto("/settings/workspace");
    await page.getByRole("button", { name: "Delete workspace" }).click();
    const dialog = page.getByRole("dialog", { name: `Delete Delete me ${slug}` });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: `Delete ${slug}` });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(`Type ${slug} to confirm`).fill(`${slug}-x`);
    await expect(confirm).toBeDisabled();
    // Esc closes and nothing happened
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: "Delete workspace" }).click();
    await page.keyboard.type(slug);
    await page.keyboard.press("Enter");
    await expect(page.getByText(`Delete me ${slug} is scheduled for deletion`)).toBeVisible();

    // the rest of the app is closed, with a way back
    await page.goto("/my-issues");
    await expect(page.getByText(`Delete me ${slug} is scheduled for deletion`)).toBeVisible();
    await page.getByRole("link", { name: "Open workspace settings" }).click();

    await page.getByRole("button", { name: "Restore workspace" }).click();
    await expect(page.getByText(`Delete me ${slug} is restored`)).toBeVisible();
    await page.goto("/my-issues");
    await expect(page.getByText("is scheduled for deletion")).toHaveCount(0);
  } finally {
    await page.request.post("/api/auth/session", { data: { workspaceSlug: "e2e" } });
  }
});

test("account deletion: typed email, refused for a sole owner, signs out @keyboard", async ({ page, browser }) => {
  // the runner is the e2e workspace's only owner: refused with a next step
  await page.goto("/settings/account");
  const me = (await (await page.request.get("/api/me")).json()) as { email: string };
  await page.getByRole("button", { name: "Delete my account" }).click();
  let dialog = page.getByRole("dialog", { name: "Delete your account" });
  await dialog.getByLabel(`Type ${me.email} to confirm`).fill(me.email);
  await dialog.getByRole("button", { name: "Delete my account" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/only owner of .*E2E.*delete the workspace/);
  await page.keyboard.press("Escape");

  const person = await invitedUser(page);
  const { ctx, page: p } = await signedInAs(browser, person.email, person.password);
  await p.goto("/settings/account");
  await p.getByRole("button", { name: "Delete my account" }).click();
  dialog = p.getByRole("dialog", { name: "Delete your account" });
  await p.keyboard.type(person.email);
  await p.keyboard.press("Enter");
  await expect(p).toHaveURL(/\/login\?error=account_deleted/);
  await expect(p.getByText("Your account was deleted.")).toBeVisible();
  const again = await ctx.request.post("/api/login", { data: { email: person.email, password: person.password } });
  expect(again.status()).toBe(401);
  await ctx.close();
});

test.describe("account lifecycle screens pass axe @a11y", () => {
  for (const vp of [
    { name: "1440", width: 1440, height: 900 },
    { name: "390", width: 390, height: 844 },
  ]) {
    for (const theme of ["dark", "light"] as const) {
      test(`settings ${theme} @${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const path of ["/settings/account", "/settings/workspace", "/settings/dev-inbox"]) {
          await page.goto(path);
          await page.waitForLoadState("networkidle");
          await page.evaluate((t) => {
            document.documentElement.classList.remove("light", "dark");
            document.documentElement.classList.add(t);
          }, theme);
          await page.waitForTimeout(400);
          const v = await axe(page);
          expect(v, `${path}\n${v.join("\n")}`).toHaveLength(0);
        }
        // the typed-confirmation dialog
        await page.goto("/settings/workspace");
        await page.getByRole("button", { name: "Delete workspace" }).click();
        await page.waitForTimeout(200);
        const v = await axe(page);
        expect(v, v.join("\n")).toHaveLength(0);
        await page.keyboard.press("Escape");
      });

      test(`signed-out flows ${theme} @${vp.name}`, async ({ browser }) => {
        const ctx = await browser.newContext({
          storageState: { cookies: [], origins: [] },
          viewport: { width: vp.width, height: vp.height },
        });
        const page = await ctx.newPage();
        for (const path of ["/forgot-password", "/reset-password?token=e2e-not-a-token", "/verify-email?token=e2e-not-a-token"]) {
          await page.goto(path);
          await page.waitForLoadState("networkidle");
          await page.evaluate((t) => {
            document.documentElement.classList.remove("light", "dark");
            document.documentElement.classList.add(t);
          }, theme);
          await page.waitForTimeout(400);
          const v = await axe(page);
          expect(v, `${path}\n${v.join("\n")}`).toHaveLength(0);
        }
        await ctx.close();
      });
    }
  }
});

async function streamText(s: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
