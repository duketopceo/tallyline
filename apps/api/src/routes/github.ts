import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  githubInstallations,
  githubRepos,
  githubWebhookEvents,
  teams,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { clock } from "../services/clock.js";
import {
  convertManifestCode,
  fetchAppInstallation,
  githubAppConfigured,
  type ManifestConversion,
} from "../services/github-sync.js";
import {
  signManifestState,
  verifyManifestState,
} from "../services/github-manifest.js";
import { requireRole } from "../services/members.js";
import {
  backfillRepoProjects,
  getWorkspaceProject,
  fillProjectIconFromRepo,
} from "../services/repo-projects.js";
import { requireWorkspace } from "./workspaces.js";

const repoBodySchema = z.object({
  fullName: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected 'owner/repo'"),
  teamKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9]*$/)
    .optional(),
});

export const githubRoutes = new Hono()
  // manifest flow: self-hosters POST this to github.com/apps/new to create
  // their own GitHub App with the right permissions/URLs preconfigured
  .get("/workspaces/:ws/github/manifest", async (c) => {
    const ws = await requireWorkspace(c);
    const base = config_.apiBaseUrl;
    return c.json({
      name: "tallyline",
      url: base,
      hook_attributes: {
        url: `${base}/webhooks/github`,
        active: true,
      },
      // real public route (GET /github/manifest/callback/:state) — the
      // signed state binds the flow to this workspace; GitHub appends ?code=
      redirect_url: `${base}/github/manifest/callback/${signManifestState(ws.id)}`,
      public: false,
      default_permissions: {
        issues: "write",
        pull_requests: "read",
        contents: "read",
        metadata: "read",
      },
      default_events: [
        "installation",
        "installation_repositories",
        "issues",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "push",
      ],
    });
  })
  .get("/workspaces/:ws/github/install-url", async (c) => {
    await requireWorkspace(c);
    if (!config_.githubAppSlug) {
      throw new HttpError(503, "GITHUB_NOT_CONFIGURED", "GITHUB_APP_SLUG not set");
    }
    return c.json({
      installUrl: `https://github.com/apps/${config_.githubAppSlug}/installations/new`,
    });
  })
  // bind an installation. GitHub's Setup URL lands on a WEB page (it cannot
  // carry our credentials); that page POSTs here with the user's session.
  // Binds the installation to this workspace and backfills repos from the
  // stored installation.created delivery (which arrives unbound). State
  // changing, so POST-only, owner/admin only, JSON body only (a cross-site
  // form cannot send it; session cookies are SameSite=Lax).
  .post(
    "/workspaces/:ws/github/setup",
    zValidator(
      "json",
      z.object({ installationId: z.number().int().positive() }),
      (result) => {
        if (!result.success) {
          throw new HttpError(
            400,
            "MALFORMED_SETUP",
            "body must be {installationId: <positive integer>}",
          );
        }
      },
    ),
    async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const { installationId } = c.req.valid("json");
    // anyone can put any installation_id in this URL — prove the installation
    // belongs to THIS GitHub App before binding it (PLAN-006)
    if (!githubAppConfigured()) {
      throw new HttpError(
        503,
        "GITHUB_APP_NOT_CONFIGURED",
        "GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set — cannot verify the installation",
      );
    }
    let verified: { id: number; accountLogin: string } | null;
    try {
      verified = await fetchAppInstallation(installationId);
    } catch (err) {
      console.error("github setup: installation lookup failed", err);
      throw new HttpError(502, "GITHUB_ERROR", "could not verify installation with GitHub");
    }
    if (!verified) {
      throw new HttpError(
        404,
        "NOT_FOUND",
        `installation ${installationId} does not belong to this GitHub App`,
      );
    }
    const accountLogin = verified.accountLogin;

    // first writer wins; another workspace cannot take over a bound installation
    await db
      .insert(githubInstallations)
      .values({ workspaceId: ws.id, installationId, accountLogin })
      .onConflictDoNothing({ target: githubInstallations.installationId });
    const [bound] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);
    if (!bound || bound.workspaceId !== ws.id) {
      throw new HttpError(
        409,
        "INSTALLATION_BOUND",
        `installation ${installationId} is already bound to another workspace`,
      );
    }
    await db
      .update(githubInstallations)
      .set({ accountLogin })
      .where(eq(githubInstallations.id, bound.id));

    // backfill repos captured in the delivery log before binding
    const deliveries = await db
      .select()
      .from(githubWebhookEvents)
      .where(
        and(
          eq(githubWebhookEvents.eventType, "installation"),
          isNull(githubWebhookEvents.processedAt),
        ),
      );
    for (const d of deliveries) {
      if (!d.payload) continue; // cleared by retention (never true for unprocessed)
      const p = d.payload as {
        installation?: { id: number };
        repositories?: { id: number; full_name?: string; name: string }[];
      };
      if (p.installation?.id !== installationId) continue;
      for (const repo of p.repositories ?? []) {
        const fullName = repo.full_name ?? repo.name;
        await db
          .insert(githubRepos)
          .values({
            workspaceId: ws.id,
            installationId,
            repoId: repo.id,
            fullName,
            enabled: false,
          })
          .onConflictDoNothing();
      }
      await db
        .update(githubWebhookEvents)
        .set({ processedAt: clock.now() })
        .where(eq(githubWebhookEvents.id, d.id));
    }

    return c.json({ ok: true, installationId, workspace: ws.slug });
    },
  )
  .get("/workspaces/:ws/github/repos", async (c) => {
    const ws = await requireWorkspace(c);
    const rows = await db
      .select()
      .from(githubRepos)
      .where(eq(githubRepos.workspaceId, ws.id));
    return c.json({ repos: rows });
  })
  .post(
    "/workspaces/:ws/github/repos/connect",
    zValidator("json", repoBodySchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const { fullName, teamKey } = c.req.valid("json");
      let teamId: string | null = null;
      if (teamKey) {
        const [team] = await db
          .select()
          .from(teams)
          .where(and(eq(teams.workspaceId, ws.id), eq(teams.key, teamKey)))
          .limit(1);
        if (!team) {
          throw new HttpError(404, "NOT_FOUND", `team '${teamKey}' not found`);
        }
        teamId = team.id;
      }
      const [row] = await db
        .insert(githubRepos)
        .values({ workspaceId: ws.id, fullName, teamId, enabled: true })
        .onConflictDoUpdate({
          target: [githubRepos.workspaceId, githubRepos.fullName],
          set: { enabled: true, teamId },
        })
        .returning();
      return c.json(row);
    },
  )
  .post(
    "/workspaces/:ws/github/repos/project",
    zValidator(
      "json",
      z.object({
        fullName: repoBodySchema.shape.fullName,
        projectId: z.uuid().nullable(),
      }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const { fullName, projectId } = c.req.valid("json");
      if (projectId) await getWorkspaceProject(ws.id, projectId);
      const [row] = await db
        .update(githubRepos)
        .set({ projectId })
        .where(
          and(
            eq(githubRepos.workspaceId, ws.id),
            eq(githubRepos.fullName, fullName),
          ),
        )
        .returning();
      if (!row) {
        throw new HttpError(404, "NOT_FOUND", `repo '${fullName}' not linked`);
      }
      if (projectId) await fillProjectIconFromRepo(db, projectId, fullName);
      return c.json(row);
    },
  )
  // dry run unless `apply: true`; `map` is repo full name -> project id
  .post(
    "/workspaces/:ws/github/repos/backfill",
    zValidator(
      "json",
      z.object({
        map: z.record(repoBodySchema.shape.fullName, z.uuid()).default({}),
        apply: z.boolean().default(false),
      }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const { map, apply } = c.req.valid("json");
      return c.json(await backfillRepoProjects(ws.id, map, apply));
    },
  )
  .post(
    "/workspaces/:ws/github/repos/disconnect",
    zValidator("json", repoBodySchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const { fullName } = c.req.valid("json");
      const [row] = await db
        .update(githubRepos)
        .set({ enabled: false })
        .where(
          and(
            eq(githubRepos.workspaceId, ws.id),
            eq(githubRepos.fullName, fullName),
          ),
        )
        .returning();
      if (!row) {
        throw new HttpError(404, "NOT_FOUND", `repo '${fullName}' not linked`);
      }
      return c.json(row);
    },
  );

const esc = (v: string) =>
  v.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

function credentialsPage(app: ManifestConversion): string {
  const row = (label: string, value: string) =>
    `<h3>${esc(label)}</h3><pre>${esc(value)}</pre>`;
  const env = [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_WEBHOOK_SECRET=${app.webhookSecret}`,
    `GITHUB_APP_PRIVATE_KEY="${app.pem.trim().replace(/\n/g, "\\n")}"`,
  ].join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub App created</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}pre{background:#f4f4f5;padding:.75rem;overflow:auto;white-space:pre-wrap;word-break:break-all}.warn{border-left:4px solid #b45309;padding:.25rem .75rem;background:#fffbeb}</style>
</head><body>
<h1>GitHub App &ldquo;${esc(app.name)}&rdquo; created</h1>
<p class="warn"><strong>Copy these now.</strong> Tallyline stores none of them and this page cannot be shown again. Put them in your API environment, restart the API, then install the App.</p>
${row("Environment", env)}
${row("App ID", String(app.id))}
${row("Webhook secret", app.webhookSecret)}
${row("Client ID", app.clientId)}
${row("Client secret", app.clientSecret)}
${row("Private key (PEM)", app.pem)}
<p><a href="${esc(app.htmlUrl)}" rel="noreferrer">Open the App on GitHub</a></p>
</body></html>`;
}

// Public (no session) — GitHub redirects the operator's browser here after
// they approve the manifest. The signed `state` path segment authorises it;
// the single-use `code` is exchanged for the App credentials, which are
// shown once and never stored.
export const githubPublicRoutes = new Hono().get(
  "/manifest/callback/:state",
  async (c) => {
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const fail = (status: 400 | 502, code: string, message: string) =>
      wantsJson
        ? c.json({ error: { code, message } }, status)
        : c.html(
            `<!doctype html><title>GitHub App setup failed</title><p>${esc(message)}</p>`,
            status,
          );

    if (!verifyManifestState(c.req.param("state"))) {
      return fail(400, "INVALID_STATE", "setup link is invalid or expired — start again from Settings");
    }
    const code = c.req.query("code");
    if (!code) return fail(400, "MALFORMED_CALLBACK", "missing code");

    let app: ManifestConversion | null;
    try {
      app = await convertManifestCode(code);
    } catch (err) {
      console.error("github manifest: conversion failed", err);
      return fail(502, "GITHUB_ERROR", "GitHub did not accept the manifest code");
    }
    if (!app) return fail(400, "INVALID_CODE", "manifest code is invalid, expired or already used");

    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    return wantsJson ? c.json(app) : c.html(credentialsPage(app));
  },
);
