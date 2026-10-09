import { createSign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { IssueState } from "@docketry/types";
import { db } from "../db/client.js";
import {
  events,
  githubIssueLinks,
  githubRepos,
  issueLabels,
  labels,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { queueDeliveries } from "./outbound.js";

// ── Bidirectional GitHub issue sync — outbound half (#60) ─────────
//
// Loop prevention is two-layered:
//  1. Inbound-originated mutations carry `via: "github"` (comments.via column,
//     event `after` metadata). Every mirror entry point skips via=github
//     writes, so a GH→docketry change never re-fires a GH API call.
//  2. Our own outbound writes echo back as webhook deliveries whose sender
//     is `${appSlug}[bot]` (and mirrored comments start with the docketry
//     marker) — the inbound handlers drop them before any mutation.
//
// All mirror functions are best-effort and never throw: they are invoked
// fire-and-forget after the local commit, exactly like queueDeliveries —
// failures land on the issue timeline as `github_sync_failed` events.

export const DOCKETRY_COMMENT_MARKER = "**[docketry]**";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);
let ghFetcher: Fetcher = defaultFetcher;

// app credentials are module-mutable so tests can inject a real RSA key +
// mock transport without touching process.env
let appId = config_.githubAppId;
let appPrivateKey = config_.githubAppPrivateKey;

export function setGithubApiFetcher(fetcher: Fetcher | null): void {
  ghFetcher = fetcher ?? defaultFetcher;
}

export function configureGithubApp(input: {
  appId?: string;
  privateKey?: string;
}): void {
  if (input.appId !== undefined) appId = input.appId;
  if (input.privateKey !== undefined) {
    appPrivateKey = input.privateKey.replace(/\\n/g, "\n");
  }
}

// test hook — restore env-derived config + real fetch + empty token cache
export function resetGithubSync(): void {
  ghFetcher = defaultFetcher;
  appId = config_.githubAppId;
  appPrivateKey = config_.githubAppPrivateKey;
  tokenCache.clear();
}

// ── GitHub App auth ────────────────────────────────────────────────

const GH_API = "https://api.github.com";
// refresh a cached token once it is inside this window of expiry
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

// App JWT — RS256, <=10min lifetime, iss = app id (docs.github.com/apps)
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  )}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(appPrivateKey)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return cached.token;
  }
  const res = await ghFetcher(
    `${GH_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!res.ok) {
    throw new Error(`installation token exchange returned ${res.status}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: Date.parse(body.expires_at),
  });
  return body.token;
}

const syncEnabled = () => appId !== "" && appPrivateKey !== "";

interface GhRepoAuth {
  id: string;
  fullName: string;
  installationId: number | null;
}

async function ghApi(
  repo: GhRepoAuth,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  if (!repo.installationId) {
    // manually-connected repos have no installation — no auth path exists
    throw new Error(`repo ${repo.fullName} has no installation`);
  }
  const token = await installationToken(repo.installationId);
  const res = await ghFetcher(`${GH_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  return res;
}

// the sync map: issueId → link + repo. Non-linked issues are a null — the
// mirrors no-op, so callers never need a pre-check.
async function linkForIssue(issueId: string) {
  const [row] = await db
    .select({ link: githubIssueLinks, repo: githubRepos })
    .from(githubIssueLinks)
    .innerJoin(githubRepos, eq(githubIssueLinks.repoId, githubRepos.id))
    .where(eq(githubIssueLinks.issueId, issueId))
    .limit(1);
  if (!row?.repo.enabled) return null;
  return row;
}

// failures are durable: every failed mirror lands on the issue timeline and
// fans out to webhook subscribers — a failed sync is never silent.
async function logSyncFailure(input: {
  workspaceId: string;
  issueId: string;
  op: string;
  error: unknown;
}): Promise<void> {
  try {
    const after = {
      op: input.op,
      error:
        input.error instanceof Error
          ? input.error.message
          : String(input.error),
    };
    await db.insert(events).values({
      workspaceId: input.workspaceId,
      entityType: "issue",
      entityId: input.issueId,
      action: "github_sync_failed",
      actorType: "system",
      actorId: null,
      after,
    });
    await queueDeliveries({
      workspaceId: input.workspaceId,
      entityType: "issue",
      entityId: input.issueId,
      action: "github_sync_failed",
      actorType: "system",
      actorId: null,
      after,
    });
  } catch (err) {
    console.error("github sync: failed to log sync failure", err);
  }
}

// inbound-side drift record — a GH update that collides with local state
// logs `sync_conflict` with both sides, never silently drops (#60)
export async function recordSyncConflict(input: {
  workspaceId: string;
  issueId: string;
  conflict: Record<string, unknown>;
}): Promise<void> {
  const after = { ...input.conflict };
  await db.insert(events).values({
    workspaceId: input.workspaceId,
    entityType: "issue",
    entityId: input.issueId,
    action: "sync_conflict",
    actorType: "system",
    actorId: null,
    after,
  });
  await queueDeliveries({
    workspaceId: input.workspaceId,
    entityType: "issue",
    entityId: input.issueId,
    action: "sync_conflict",
    actorType: "system",
    actorId: null,
    after,
  });
}

// sender of the delivery is our own App → the event is an echo of an
// outbound write. GitHub names app bots `${slug}[bot]`.
export function isAppBotSender(payload: Record<string, unknown>): boolean {
  if (!config_.githubAppSlug) return false;
  const sender = payload.sender as { login?: string } | undefined;
  return sender?.login === `${config_.githubAppSlug}[bot]`;
}

// ── mirror: state ──────────────────────────────────────────────────

const TERMINAL: ReadonlySet<IssueState> = new Set([
  "done",
  "canceled",
  "duplicate",
]);

export async function mirrorIssueState(input: {
  issueId: string;
  to: IssueState;
  via?: string | undefined;
}): Promise<void> {
  if (input.via === "github" || !syncEnabled()) return;
  const found = await linkForIssue(input.issueId);
  if (!found) return;
  const { link, repo } = found;

  const terminal = TERMINAL.has(input.to);
  const desired = terminal ? "closed" : "open";
  if (link.ghState === desired) return; // already in sync — skip the PATCH

  try {
    const res = await ghApi(
      repo,
      "PATCH",
      `/repos/${repo.fullName}/issues/${link.ghIssueNumber}`,
      terminal
        ? {
            state: "closed",
            state_reason:
              input.to === "done" ? "completed" : "not_planned",
          }
        : { state: "open" },
    );
    if (!res.ok) throw new Error(`PATCH issue state returned ${res.status}`);
    await db
      .update(githubIssueLinks)
      .set({ ghState: desired })
      .where(eq(githubIssueLinks.id, link.id));
  } catch (err) {
    await logSyncFailure({
      workspaceId: link.workspaceId,
      issueId: link.issueId,
      op: "state",
      error: err,
    });
  }
}

// ── mirror: comments ───────────────────────────────────────────────

export async function mirrorIssueComment(input: {
  issueId: string;
  body: string;
  via?: string | null | undefined;
}): Promise<void> {
  if (input.via === "github" || !syncEnabled()) return;
  const found = await linkForIssue(input.issueId);
  if (!found) return;
  const { link, repo } = found;

  try {
    const res = await ghApi(
      repo,
      "POST",
      `/repos/${repo.fullName}/issues/${link.ghIssueNumber}/comments`,
      { body: `${DOCKETRY_COMMENT_MARKER}\n\n${input.body}` },
    );
    if (!res.ok) throw new Error(`POST comment returned ${res.status}`);
  } catch (err) {
    await logSyncFailure({
      workspaceId: link.workspaceId,
      issueId: link.issueId,
      op: "comment",
      error: err,
    });
  }
}

// ── mirror: labels ─────────────────────────────────────────────────

// pushes the issue's current docketry label set onto the linked GH issue.
// Labels are ensured one-by-one (422 = already exists) then added in a
// single call. Removals never propagate outbound — docketry has no
// remove-label write path, so ghState-style diffing isn't needed here.
export async function mirrorIssueLabels(issueId: string): Promise<void> {
  if (!syncEnabled()) return;
  const found = await linkForIssue(issueId);
  if (!found) return;
  const { link, repo } = found;

  try {
    const names = await db
      .select({ name: labels.name, color: labels.color })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(
        and(
          eq(issueLabels.issueId, issueId),
          eq(labels.workspaceId, link.workspaceId),
        ),
      );
    if (names.length === 0) return;
    for (const l of names) {
      const res = await ghApi(repo, "POST", `/repos/${repo.fullName}/labels`, {
        name: l.name,
        color: l.color.replace(/^#/, ""),
      });
      // 422 = label already exists — fine, keep going
      if (!res.ok && res.status !== 422) {
        throw new Error(`create label '${l.name}' returned ${res.status}`);
      }
    }
    const res = await ghApi(
      repo,
      "POST",
      `/repos/${repo.fullName}/issues/${link.ghIssueNumber}/labels`,
      { labels: names.map((l) => l.name) },
    );
    if (!res.ok) throw new Error(`add labels returned ${res.status}`);
  } catch (err) {
    await logSyncFailure({
      workspaceId: link.workspaceId,
      issueId: link.issueId,
      op: "labels",
      error: err,
    });
  }
}
