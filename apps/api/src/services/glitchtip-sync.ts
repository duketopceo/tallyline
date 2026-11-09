// GlitchTip pull side: connection, per-project mapping, cached sync and the
// read shape the project page, the MCP tools and the later portfolio page share.
// Every query is scoped by workspace_id. GlitchTip being slow, down, rate
// limiting us or answering garbage never throws out of a read: the cache is
// served and the failure is recorded as a status.
import { and, desc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../auth/secrets.js";
import { db } from "../db/client.js";
import {
  events,
  glitchtipConnections,
  glitchtipIssues,
  glitchtipProjectLinks,
  issues,
  projects,
  teams,
} from "../db/schema.js";
import { config_ } from "../env.js";
import {
  fetchLatestEvent,
  fetchUnresolvedIssues,
  GlitchtipApiError,
  isSlug,
  issueLink,
  probeConnection,
  type ApiIssue,
} from "../lib/glitchtip-api.js";
import { HttpError } from "../lib/errors.js";
import { assertSafeOutboundUrl, webhookAllowPrivate } from "../lib/net-guard.js";
import { clock } from "./clock.js";
import { createIssue, type Actor } from "./issues.js";

export const SYNC_INTERVAL_MS = 5 * 60_000;
/** a cache older than this is reported as stale (three missed ticks) */
export const STALE_AFTER_MS = 15 * 60_000;
export const EVENT_TTL_MS = 5 * 60_000;
const RESOLVED_KEEP_MS = 30 * 24 * 60 * 60_000;
const RECENT_LIMIT = 10;

export type ConnectionStatus =
  | "ok"
  | "auth_failed"
  | "unreachable"
  | "rate_limited"
  | "token_unreadable"
  | "bad_response"
  | "not_found";

type Connection = typeof glitchtipConnections.$inferSelect;
type Link = typeof glitchtipProjectLinks.$inferSelect;
type CachedIssue = typeof glitchtipIssues.$inferSelect;

// ── connection ───────────────────────────────────────────────────────────

export async function normalizeBaseUrl(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(422, "BAD_BASE_URL", "that doesn't look like a web address");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && webhookAllowPrivate())) {
    throw new HttpError(
      422,
      "BASE_URL_NOT_HTTPS",
      "the address must start with https:// (plain http is only allowed on servers set up for a private network)",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HttpError(422, "BAD_BASE_URL", "the address must not contain credentials, a query or a fragment");
  }
  try {
    await assertSafeOutboundUrl(url.origin);
  } catch (e) {
    throw new HttpError(422, "BASE_URL_NOT_ALLOWED", e instanceof Error ? e.message : "that address isn't allowed");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function sealToken(plain: string): string {
  if (!config_.authSecretKey) {
    throw new HttpError(
      503,
      "SECRETS_KEY_MISSING",
      "this server has no AUTH_SECRET_KEY, so it can't store a token safely; ask whoever runs it to set one",
    );
  }
  return encryptSecret(plain, config_.authSecretKey);
}

function openToken(conn: Connection): string | null {
  try {
    return decryptSecret(conn.tokenEnc, config_.authSecretKey);
  } catch {
    return null;
  }
}

export async function getConnection(workspaceId: string): Promise<Connection | undefined> {
  const [row] = await db.select().from(glitchtipConnections).where(eq(glitchtipConnections.workspaceId, workspaceId));
  return row;
}

/** Everything the UI may show. Never includes the token. */
export function connectionView(c: Connection) {
  return {
    baseUrl: c.baseUrl,
    tokenLast4: c.tokenLast4,
    status: c.lastStatus,
    lastCheckedAt: c.lastCheckedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function emit(
  workspaceId: string,
  actor: Actor,
  entityType: string,
  entityId: string,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    workspaceId,
    entityType,
    entityId,
    action,
    actorType: actor.type,
    actorId: actor.id,
    after,
  });
}

function failureStatus(e: unknown): ConnectionStatus {
  return e instanceof GlitchtipApiError ? e.kind : "unreachable";
}

export async function saveConnection(
  workspaceId: string,
  actor: Actor,
  input: { baseUrl: string; token?: string | undefined },
): Promise<Connection> {
  const baseUrl = await normalizeBaseUrl(input.baseUrl);
  const existing = await getConnection(workspaceId);
  const token = input.token?.trim() || undefined;
  if (!existing && !token) throw new HttpError(422, "TOKEN_REQUIRED", "a GlitchTip API token is required");
  const plain = token ?? (existing ? openToken(existing) : null);
  if (!plain) throw new HttpError(409, "TOKEN_UNREADABLE", "the saved token can't be read; enter it again");

  // a token GlitchTip rejects is never saved; an unreachable server is, so a
  // temporary outage doesn't block setup
  let status: ConnectionStatus = "ok";
  try {
    await probeConnection(baseUrl, plain);
  } catch (e) {
    status = failureStatus(e);
    if (status === "auth_failed") {
      throw new HttpError(422, "GLITCHTIP_AUTH_FAILED", "GlitchTip rejected that token");
    }
  }
  const now = clock.now();
  const values = {
    baseUrl,
    ...(token ? { tokenEnc: sealToken(token), tokenLast4: token.slice(-4) } : {}),
    lastStatus: status,
    lastCheckedAt: now,
    updatedAt: now,
  };
  const safeAfter = { baseUrl, tokenLast4: token ? token.slice(-4) : existing?.tokenLast4, status };
  if (existing) {
    const [row] = await db
      .update(glitchtipConnections)
      .set(values)
      .where(and(eq(glitchtipConnections.id, existing.id), eq(glitchtipConnections.workspaceId, workspaceId)))
      .returning();
    await emit(workspaceId, actor, "glitchtip_connection", existing.id, "glitchtip_connection_changed", safeAfter);
    return row!;
  }
  const [row] = await db
    .insert(glitchtipConnections)
    .values({
      workspaceId,
      createdBy: actor.id,
      baseUrl,
      tokenEnc: sealToken(token!),
      tokenLast4: token!.slice(-4),
      lastStatus: status,
      lastCheckedAt: now,
    })
    .returning();
  await emit(workspaceId, actor, "glitchtip_connection", row!.id, "glitchtip_connected", safeAfter);
  return row!;
}

export async function removeConnection(workspaceId: string, actor: Actor): Promise<boolean> {
  const [row] = await db
    .delete(glitchtipConnections)
    .where(eq(glitchtipConnections.workspaceId, workspaceId))
    .returning({ id: glitchtipConnections.id });
  if (!row) return false;
  await emit(workspaceId, actor, "glitchtip_connection", row.id, "glitchtip_disconnected", {});
  return true;
}

// ── project mapping ──────────────────────────────────────────────────────

export async function getLink(workspaceId: string, projectId: string): Promise<Link | undefined> {
  const [row] = await db
    .select()
    .from(glitchtipProjectLinks)
    .where(and(eq(glitchtipProjectLinks.workspaceId, workspaceId), eq(glitchtipProjectLinks.projectId, projectId)));
  return row;
}

export async function saveLink(
  workspaceId: string,
  actor: Actor,
  projectId: string,
  input: { orgSlug: string; projectSlug: string },
): Promise<Link> {
  if (!isSlug(input.orgSlug) || !isSlug(input.projectSlug)) {
    throw new HttpError(422, "BAD_SLUG", "GlitchTip organization and project slugs use letters, digits, . _ and -");
  }
  if (!(await getConnection(workspaceId))) {
    throw new HttpError(409, "NOT_CONNECTED", "connect GlitchTip for this workspace first");
  }
  const existing = await getLink(workspaceId, projectId);
  const safeAfter = { projectId, orgSlug: input.orgSlug, projectSlug: input.projectSlug };
  let row: Link;
  if (existing) {
    const changed = existing.orgSlug !== input.orgSlug || existing.projectSlug !== input.projectSlug;
    [row] = await db
      .update(glitchtipProjectLinks)
      .set(
        changed
          ? { ...input, lastStatus: null, lastSyncedAt: null, backoffUntil: null, openCount: 0, openCapped: false }
          : input,
      )
      .where(and(eq(glitchtipProjectLinks.id, existing.id), eq(glitchtipProjectLinks.workspaceId, workspaceId)))
      .returning() as [Link];
    if (changed) {
      await db
        .delete(glitchtipIssues)
        .where(and(eq(glitchtipIssues.workspaceId, workspaceId), eq(glitchtipIssues.projectId, projectId)));
    }
    await emit(workspaceId, actor, "glitchtip_project_link", row.id, "glitchtip_project_link_changed", safeAfter);
  } else {
    [row] = await db
      .insert(glitchtipProjectLinks)
      .values({ workspaceId, projectId, ...input })
      .returning() as [Link];
    await emit(workspaceId, actor, "glitchtip_project_link", row.id, "glitchtip_project_linked", safeAfter);
  }
  await syncLink(row.id).catch(() => undefined);
  return (await getLink(workspaceId, projectId)) ?? row;
}

export async function removeLink(workspaceId: string, actor: Actor, projectId: string): Promise<boolean> {
  const [row] = await db
    .delete(glitchtipProjectLinks)
    .where(and(eq(glitchtipProjectLinks.workspaceId, workspaceId), eq(glitchtipProjectLinks.projectId, projectId)))
    .returning({ id: glitchtipProjectLinks.id });
  if (!row) return false;
  await db
    .delete(glitchtipIssues)
    .where(and(eq(glitchtipIssues.workspaceId, workspaceId), eq(glitchtipIssues.projectId, projectId)));
  await emit(workspaceId, actor, "glitchtip_project_link", row.id, "glitchtip_project_unlinked", { projectId });
  return true;
}

// ── sync ─────────────────────────────────────────────────────────────────

const inflight = new Map<string, Promise<ConnectionStatus | "skipped">>();

/**
 * Pull one mapped project's unresolved issues into the cache. Single-flight per
 * link, honors a stored backoff, and never throws on a GlitchTip failure: the
 * outcome is the returned status (also stored on the link and connection).
 */
export function syncLink(linkId: string): Promise<ConnectionStatus | "skipped"> {
  const running = inflight.get(linkId);
  if (running) return running;
  const p = runSync(linkId).finally(() => inflight.delete(linkId));
  inflight.set(linkId, p);
  return p;
}

async function runSync(linkId: string): Promise<ConnectionStatus | "skipped"> {
  const [link] = await db.select().from(glitchtipProjectLinks).where(eq(glitchtipProjectLinks.id, linkId));
  if (!link) return "skipped";
  const now = clock.now();
  // neither the tick nor a manual sync overrides a stored Retry-After
  if (link.backoffUntil && link.backoffUntil > now) return "skipped";
  const conn = await getConnection(link.workspaceId);
  if (!conn) return "skipped";
  const token = openToken(conn);
  if (!token) {
    await recordLinkResult(link, conn, "token_unreadable");
    return "token_unreadable";
  }
  try {
    const { issues, capped } = await fetchUnresolvedIssues(conn.baseUrl, token, link.orgSlug, link.projectSlug);
    await db.transaction(async (tx) => {
      const ids = issues.map((i) => i.glitchtipId);
      for (const i of issues) await upsertIssue(tx, link, conn.baseUrl, i, now);
      if (!capped) {
        // anything cached as unresolved that GlitchTip no longer lists was resolved there
        await tx
          .update(glitchtipIssues)
          .set({ status: "resolved", updatedAt: now })
          .where(
            and(
              eq(glitchtipIssues.workspaceId, link.workspaceId),
              eq(glitchtipIssues.projectId, link.projectId),
              eq(glitchtipIssues.status, "unresolved"),
              ids.length ? notInArray(glitchtipIssues.glitchtipId, ids) : sql`true`,
            ),
          );
      }
      await tx
        .delete(glitchtipIssues)
        .where(
          and(
            eq(glitchtipIssues.workspaceId, link.workspaceId),
            eq(glitchtipIssues.projectId, link.projectId),
            eq(glitchtipIssues.status, "resolved"),
            isNull(glitchtipIssues.ticketIssueId),
            lt(glitchtipIssues.updatedAt, new Date(now.getTime() - RESOLVED_KEEP_MS)),
          ),
        );
      await tx
        .update(glitchtipProjectLinks)
        .set({ openCount: issues.length, openCapped: capped, lastStatus: "ok", lastSyncedAt: now, backoffUntil: null })
        .where(eq(glitchtipProjectLinks.id, link.id));
    });
    await setConnectionStatus(conn, "ok", now);
    return "ok";
  } catch (e) {
    const status = failureStatus(e);
    const backoff =
      e instanceof GlitchtipApiError && e.kind === "rate_limited"
        ? new Date(now.getTime() + (e.retryAfterSeconds ?? 60) * 1000)
        : null;
    await recordLinkResult(link, conn, status, backoff);
    return status;
  }
}

async function recordLinkResult(link: Link, conn: Connection, status: ConnectionStatus, backoff: Date | null = null) {
  await db
    .update(glitchtipProjectLinks)
    .set({ lastStatus: status, ...(backoff ? { backoffUntil: backoff } : {}) })
    .where(eq(glitchtipProjectLinks.id, link.id));
  // a 404 is one project's slug being wrong, not the whole connection
  if (status !== "not_found") await setConnectionStatus(conn, status, clock.now());
}

async function setConnectionStatus(conn: Connection, status: ConnectionStatus, at: Date) {
  await db
    .update(glitchtipConnections)
    .set({ lastStatus: status, lastCheckedAt: at })
    .where(eq(glitchtipConnections.id, conn.id));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function upsertIssue(tx: Tx, link: Link, baseUrl: string, i: ApiIssue, now: Date) {
  const values = {
    shortId: i.shortId,
    title: i.title,
    culprit: i.culprit,
    level: i.level,
    status: i.status,
    count: i.count,
    userCount: i.userCount,
    firstSeen: i.firstSeen,
    lastSeen: i.lastSeen,
    link: issueLink(baseUrl, link.orgSlug, i.glitchtipId),
    updatedAt: now,
  };
  await tx
    .insert(glitchtipIssues)
    .values({ workspaceId: link.workspaceId, projectId: link.projectId, glitchtipId: i.glitchtipId, ...values })
    .onConflictDoUpdate({ target: [glitchtipIssues.projectId, glitchtipIssues.glitchtipId], set: values });
}

/** Background tick: due links, one at a time. A 429 pauses that workspace for the tick. */
export async function syncDueLinks(): Promise<{ synced: number }> {
  const now = clock.now();
  const due = await db
    .select({ id: glitchtipProjectLinks.id, workspaceId: glitchtipProjectLinks.workspaceId })
    .from(glitchtipProjectLinks)
    .where(
      and(
        or(isNull(glitchtipProjectLinks.lastSyncedAt), lt(glitchtipProjectLinks.lastSyncedAt, new Date(now.getTime() - SYNC_INTERVAL_MS))),
        or(isNull(glitchtipProjectLinks.backoffUntil), lt(glitchtipProjectLinks.backoffUntil, now)),
      ),
    )
    .orderBy(glitchtipProjectLinks.lastSyncedAt)
    .limit(200);
  const paused = new Set<string>();
  let synced = 0;
  for (const l of due) {
    if (paused.has(l.workspaceId)) continue;
    const r = await syncLink(l.id);
    if (r === "ok") synced++;
    if (r === "rate_limited" || r === "auth_failed" || r === "unreachable") paused.add(l.workspaceId);
  }
  return { synced };
}

// ── reads ────────────────────────────────────────────────────────────────

export function issueView(r: CachedIssue) {
  return {
    id: r.id,
    glitchtipId: r.glitchtipId,
    shortId: r.shortId,
    title: r.title,
    culprit: r.culprit,
    level: r.level,
    status: r.status,
    count: r.count,
    userCount: r.userCount,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    link: r.link,
    ticketIssueId: r.ticketIssueId,
  };
}

export type ErrorHealth = Awaited<ReturnType<typeof projectErrorHealth>>;

/** The shape the project page, the MCP tools and the portfolio overview share. */
export async function projectErrorHealth(workspaceId: string, projectId: string) {
  const conn = await getConnection(workspaceId);
  const link = await getLink(workspaceId, projectId);
  if (!conn || !link) {
    return { connected: !!conn, mapped: !!link, status: null, link: null, openCount: 0, openCapped: false, stale: false, lastSyncedAt: null, recent: [] };
  }
  const recent = await db
    .select()
    .from(glitchtipIssues)
    .where(
      and(
        eq(glitchtipIssues.workspaceId, workspaceId),
        eq(glitchtipIssues.projectId, projectId),
        eq(glitchtipIssues.status, "unresolved"),
      ),
    )
    .orderBy(desc(glitchtipIssues.lastSeen))
    .limit(RECENT_LIMIT);
  const now = clock.ms();
  const stale = !link.lastSyncedAt || now - link.lastSyncedAt.getTime() > STALE_AFTER_MS;
  return {
    connected: true,
    mapped: true,
    status: link.lastStatus,
    link: {
      orgSlug: link.orgSlug,
      projectSlug: link.projectSlug,
      url: `${conn.baseUrl}/${encodeURIComponent(link.orgSlug)}`,
      backoffUntil: link.backoffUntil && link.backoffUntil.getTime() > now ? link.backoffUntil : null,
    },
    openCount: link.openCount,
    openCapped: link.openCapped,
    stale,
    lastSyncedAt: link.lastSyncedAt,
    recent: recent.map(issueView),
  };
}

/** Health for every mapped project in the workspace (portfolio overview input). */
export async function workspaceErrorHealth(workspaceId: string) {
  const rows = await db
    .select({ projectId: glitchtipProjectLinks.projectId, name: projects.name })
    .from(glitchtipProjectLinks)
    .innerJoin(projects, and(eq(projects.id, glitchtipProjectLinks.projectId), eq(projects.workspaceId, workspaceId)))
    .where(eq(glitchtipProjectLinks.workspaceId, workspaceId))
    .orderBy(projects.name);
  const out = [];
  for (const r of rows) {
    const h = await projectErrorHealth(workspaceId, r.projectId);
    out.push({ projectId: r.projectId, projectName: r.name, status: h.status, openCount: h.openCount, openCapped: h.openCapped, stale: h.stale, lastSyncedAt: h.lastSyncedAt });
  }
  return out;
}

export async function listIssues(
  workspaceId: string,
  projectId: string,
  opts: { status: "unresolved" | "resolved" | "all"; limit: number },
) {
  const rows = await db
    .select()
    .from(glitchtipIssues)
    .where(
      and(
        eq(glitchtipIssues.workspaceId, workspaceId),
        eq(glitchtipIssues.projectId, projectId),
        opts.status === "all" ? undefined : eq(glitchtipIssues.status, opts.status),
      ),
    )
    .orderBy(desc(glitchtipIssues.lastSeen))
    .limit(opts.limit);
  return rows.map(issueView);
}

async function findCached(workspaceId: string, projectId: string, ref: string): Promise<CachedIssue> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
  const [row] = await db
    .select()
    .from(glitchtipIssues)
    .where(
      and(
        eq(glitchtipIssues.workspaceId, workspaceId),
        eq(glitchtipIssues.projectId, projectId),
        isUuid ? eq(glitchtipIssues.id, ref) : eq(glitchtipIssues.glitchtipId, ref),
      ),
    );
  if (!row) throw new HttpError(404, "NOT_FOUND", "no such error on this project");
  return row;
}

/** Cached issue plus its latest event, refreshed when old; the cache is served when GlitchTip can't answer. */
export async function getIssueDetail(workspaceId: string, projectId: string, ref: string) {
  let row = await findCached(workspaceId, projectId, ref);
  let eventStatus: ConnectionStatus | "cached" = "cached";
  const fresh = row.latestEventAt && clock.ms() - row.latestEventAt.getTime() < EVENT_TTL_MS;
  if (!fresh) {
    const conn = await getConnection(workspaceId);
    const token = conn ? openToken(conn) : null;
    if (conn && token) {
      try {
        const ev = await fetchLatestEvent(conn.baseUrl, token, row.glitchtipId);
        const [updated] = await db
          .update(glitchtipIssues)
          .set({ latestEvent: ev as unknown as Record<string, unknown>, latestEventAt: clock.now() })
          .where(and(eq(glitchtipIssues.id, row.id), eq(glitchtipIssues.workspaceId, workspaceId)))
          .returning();
        row = updated ?? row;
        eventStatus = "ok";
      } catch (e) {
        eventStatus = failureStatus(e);
      }
    } else {
      eventStatus = "token_unreadable";
    }
  }
  return { ...issueView(row), latestEvent: row.latestEvent, latestEventAt: row.latestEventAt, eventStatus };
}

// ── ticket from error ────────────────────────────────────────────────────

export async function createTicketFromError(
  workspaceId: string,
  projectId: string,
  ref: string,
  actor: Actor,
): Promise<{ created: boolean; issue: { id: string; key: string; title: string } }> {
  const row = await findCached(workspaceId, projectId, ref);
  if (row.ticketIssueId) {
    const [existing] = await db
      .select({ id: issues.id, key: issues.key, title: issues.title })
      .from(issues)
      .where(and(eq(issues.id, row.ticketIssueId), eq(issues.workspaceId, workspaceId)));
    if (existing) return { created: false, issue: existing };
  }
  const [project] = await db
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
  let teamId = project?.teamId ?? null;
  if (!teamId) {
    const [t] = await db.select({ id: teams.id }).from(teams).where(eq(teams.workspaceId, workspaceId)).orderBy(teams.createdAt).limit(1);
    teamId = t?.id ?? null;
  }
  if (!teamId) throw new HttpError(409, "NO_TEAM", "this workspace has no team to file the ticket on");
  const description = [
    `GlitchTip error: ${row.link}`,
    "",
    `- Level: ${row.level}`,
    `- Events: ${row.count}, people affected: ${row.userCount}`,
    row.culprit ? `- Culprit: ${row.culprit}` : null,
    row.lastSeen ? `- Last seen: ${row.lastSeen.toISOString()}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  const created = await createIssue({
    workspaceId,
    teamId,
    title: row.title.slice(0, 300),
    description,
    source: "intake",
    creator: actor,
    state: "triage",
  });
  await db
    .update(glitchtipIssues)
    .set({ ticketIssueId: created.id })
    .where(and(eq(glitchtipIssues.id, row.id), eq(glitchtipIssues.workspaceId, workspaceId)));
  return { created: true, issue: { id: created.id, key: created.key, title: created.title } };
}
