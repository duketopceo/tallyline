// Client for GlitchTip's Sentry-compatible REST API (the pull side). Everything
// a GlitchTip server returns is untrusted: it is parsed defensively, capped, and
// stripped of user and request data before it is stored. The token only ever
// travels in the Authorization header and is never part of an error message.
import { safeFetchText } from "./net-guard.js";

export const REQUEST_TIMEOUT_MS = 8_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const ISSUE_PAGE_SIZE = 100;
export const DEFAULT_RETRY_SECONDS = 60;
export const MAX_RETRY_SECONDS = 15 * 60;

export type GlitchtipFailure = "auth_failed" | "not_found" | "rate_limited" | "unreachable" | "bad_response";

export class GlitchtipApiError extends Error {
  constructor(
    readonly kind: GlitchtipFailure,
    /** seconds to wait before the next call, set on rate_limited */
    readonly retryAfterSeconds?: number,
  ) {
    super(`glitchtip ${kind}`);
    this.name = "GlitchtipApiError";
  }
}

export interface ApiIssue {
  glitchtipId: string;
  shortId: string | null;
  title: string;
  culprit: string | null;
  level: string;
  status: string;
  count: number;
  userCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
}

export interface TrimmedEvent {
  eventId: string | null;
  occurredAt: string | null;
  message: string | null;
  exception: { type: string | null; value: string | null; frames: { file: string; function: string | null; line: number | null }[] } | null;
  tags: { key: string; value: string }[];
}

const SLUG = /^[A-Za-z0-9._-]{1,100}$/;
export const isSlug = (v: string): boolean => SLUG.test(v);

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, max) : null;
}

function int(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), 2_000_000_000) : 0;
}

function date(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const STATUSES = new Set(["unresolved", "resolved", "ignored"]);
const LEVELS = new Set(["fatal", "error", "warning", "info", "debug"]);

export function parseIssue(raw: unknown): ApiIssue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" || typeof r.id === "number" ? String(r.id) : "";
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(id)) return null;
  const title = clean(r.title, 300);
  if (!title) return null;
  const level = typeof r.level === "string" && LEVELS.has(r.level) ? r.level : "error";
  const status = typeof r.status === "string" && STATUSES.has(r.status) ? r.status : "unresolved";
  return {
    glitchtipId: id,
    shortId: clean(r.shortId, 60),
    title,
    culprit: clean(r.culprit, 500),
    level,
    status,
    count: int(r.count),
    userCount: int(r.userCount),
    firstSeen: date(r.firstSeen),
    lastSeen: date(r.lastSeen),
  };
}

export function parseIssueList(body: string): { issues: ApiIssue[]; dropped: number } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new GlitchtipApiError("bad_response");
  }
  if (!Array.isArray(data)) throw new GlitchtipApiError("bad_response");
  const issues: ApiIssue[] = [];
  let dropped = 0;
  for (const item of data) {
    const parsed = parseIssue(item);
    if (parsed) issues.push(parsed);
    else dropped++;
  }
  return { issues, dropped };
}

/** Keeps exception type/value, a few frames and tags; drops user, request and contexts. */
export function trimEvent(raw: unknown): TrimmedEvent {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  let exception: TrimmedEvent["exception"] = null;
  const entries = Array.isArray(r.entries) ? r.entries : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "exception") continue;
    const data = e.data as Record<string, unknown> | undefined;
    const values = Array.isArray(data?.values) ? (data!.values as unknown[]) : [];
    const last = values[values.length - 1] as Record<string, unknown> | undefined;
    if (!last) continue;
    const st = last.stacktrace as Record<string, unknown> | null | undefined;
    const frames = Array.isArray(st?.frames) ? (st!.frames as unknown[]) : [];
    exception = {
      type: clean(last.type, 200),
      value: clean(last.value, 500),
      frames: frames
        .slice(-8)
        .reverse()
        .flatMap((f) => {
          if (typeof f !== "object" || f === null) return [];
          const fr = f as Record<string, unknown>;
          const file = clean(fr.filename ?? fr.absPath, 300);
          if (!file) return [];
          return [{ file, function: clean(fr.function, 200), line: typeof fr.lineNo === "number" ? int(fr.lineNo) : null }];
        }),
    };
    break;
  }
  const tags = Array.isArray(r.tags)
    ? r.tags.slice(0, 20).flatMap((t) => {
        if (typeof t !== "object" || t === null) return [];
        const tag = t as Record<string, unknown>;
        const key = clean(tag.key, 60);
        const value = clean(tag.value, 200);
        return key && value ? [{ key, value }] : [];
      })
    : [];
  return {
    eventId: clean(r.eventID ?? r.id, 64),
    occurredAt: date(r.dateCreated)?.toISOString() ?? null,
    message: clean(r.message ?? r.title, 500),
    exception,
    tags,
  };
}

function retrySeconds(header: string | null): number {
  const n = header === null ? NaN : Number(header);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETRY_SECONDS;
  return Math.min(Math.max(Math.ceil(n), 1), MAX_RETRY_SECONDS);
}

async function get(baseUrl: string, path: string, token: string): Promise<string> {
  let res: Awaited<ReturnType<typeof safeFetchText>>;
  try {
    res = await safeFetchText(`${baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch {
    // network error, timeout, oversize body, redirect or blocked address:
    // the message could name the host, so none of it is kept
    throw new GlitchtipApiError("unreachable");
  }
  if (res.status === 401 || res.status === 403) throw new GlitchtipApiError("auth_failed");
  if (res.status === 404) throw new GlitchtipApiError("not_found");
  if (res.status === 429) throw new GlitchtipApiError("rate_limited", retrySeconds(res.retryAfter));
  if (res.status >= 500) throw new GlitchtipApiError("unreachable");
  if (res.status < 200 || res.status >= 300) throw new GlitchtipApiError("bad_response");
  return res.body;
}

export async function fetchUnresolvedIssues(
  baseUrl: string,
  token: string,
  orgSlug: string,
  projectSlug: string,
): Promise<{ issues: ApiIssue[]; capped: boolean }> {
  const body = await get(
    baseUrl,
    `/api/0/projects/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}/issues/?query=is%3Aunresolved&limit=${ISSUE_PAGE_SIZE}`,
    token,
  );
  const { issues } = parseIssueList(body);
  // the server may ignore `query`, so only unresolved rows count as open
  const open = issues.filter((i) => i.status === "unresolved");
  return { issues: open, capped: issues.length >= ISSUE_PAGE_SIZE };
}

export async function fetchLatestEvent(baseUrl: string, token: string, glitchtipId: string): Promise<TrimmedEvent> {
  const body = await get(baseUrl, `/api/0/issues/${encodeURIComponent(glitchtipId)}/events/latest/`, token);
  try {
    return trimEvent(JSON.parse(body));
  } catch {
    throw new GlitchtipApiError("bad_response");
  }
}

/** A cheap authenticated call used to validate a new connection. */
export async function probeConnection(baseUrl: string, token: string): Promise<void> {
  await get(baseUrl, "/api/0/organizations/", token);
}

export function issueLink(baseUrl: string, orgSlug: string, glitchtipId: string): string {
  return `${baseUrl}/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(glitchtipId)}`;
}
