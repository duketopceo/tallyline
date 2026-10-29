import { stat } from "node:fs/promises";
import { readEnv } from "@tallyline/types";
import { count, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agents, authProviders, issues, workspaceMembers } from "../db/schema.js";
import { config_ } from "../env.js";
import { clock } from "./clock.js";
import { AiError, resolveProvider, viewOf, type ProviderView } from "./ai-providers.js";

// S2-U3: what an operator needs to see to know the install is healthy, in one
// call. Nothing here is a secret: every field is a yes/no, a name, a count, or
// the public URLs the instance already advertises. Admin only (the route gates it).

export type Level = "ok" | "attention" | "off";

export interface SystemStatus {
  /** release the operator says is running (TALLYLINE_VERSION), if set */
  version: string | null;
  /** git commit of the build (TALLYLINE_REVISION, set by ops/deploy.sh through compose), if set */
  revision: string | null;
  checkedAt: string;
  database: { ok: boolean; latencyMs: number | null };
  backup: {
    state: "not_configured" | "none_yet" | "ok" | "stale";
    lastBackupAt: string | null;
    ageHours: number | null;
  };
  signIn: { password: boolean; providers: { key: string; type: string; label: string; source: "env" | "database" }[] };
  ai: {
    configured: boolean;
    provider: Pick<ProviderView, "source" | "kind" | "label" | "model" | "hasKey" | "monthlyCapCents"> | null;
    /** set when a provider is saved but cannot be used, e.g. AI_KEY_UNREADABLE after AUTH_SECRET_KEY changed */
    problem: string | null;
  };
  email: { transport: string; configured: boolean };
  publicUrl: { webUrl: string; apiBaseUrl: string; issues: string[] };
  workspace: { members: number; agents: number; issues: number };
}

/** A backup older than this is "stale" (nightly timer plus a day of slack). */
export const BACKUP_STALE_HOURS = 48;

/** The API only learns about backups through a marker file the backup job touches. */
export const BACKUP_MARKER_ENV = "TALLYLINE_BACKUP_MARKER";

function buildInfo(): { version: string | null; revision: string | null } {
  return {
    version: readEnv(process.env, "TALLYLINE_VERSION") ?? null,
    revision: readEnv(process.env, "TALLYLINE_REVISION") ?? null,
  };
}

export function urlIssues(webUrl: string, apiBaseUrl: string): string[] {
  const out: string[] = [];
  for (const [label, raw] of [["web address", webUrl], ["API address", apiBaseUrl]] as const) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      out.push(`The ${label} is not a valid address.`);
      continue;
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
    if (loopback) out.push(`The ${label} points at this computer, so nobody else can reach it.`);
    else if (u.protocol !== "https:") out.push(`The ${label} is not https, so sign-in cookies and tokens travel unprotected.`);
  }
  return out;
}

export function emailState(): { transport: string; configured: boolean } {
  const t = config_.mailTransport;
  const configured =
    (t === "smtp" && config_.smtpUrl !== "") ||
    (t === "cloudflare" && config_.cloudflareAccountId !== "" && config_.cloudflareEmailApiToken !== "");
  return { transport: t, configured };
}

async function backupState(now: Date): Promise<SystemStatus["backup"]> {
  const path = readEnv(process.env, BACKUP_MARKER_ENV);
  if (!path) return { state: "not_configured", lastBackupAt: null, ageHours: null };
  try {
    const s = await stat(path);
    const ageHours = Math.max(0, Math.round(((now.getTime() - s.mtime.getTime()) / 3_600_000) * 10) / 10);
    return {
      state: ageHours > BACKUP_STALE_HOURS ? "stale" : "ok",
      lastBackupAt: s.mtime.toISOString(),
      ageHours,
    };
  } catch {
    return { state: "none_yet", lastBackupAt: null, ageHours: null };
  }
}

async function signInState(): Promise<SystemStatus["signIn"]> {
  const fromEnv: SystemStatus["signIn"]["providers"] = [];
  if (config_.githubClientId) fromEnv.push({ key: "github", type: "github", label: "GitHub", source: "env" });
  if (config_.googleClientId) fromEnv.push({ key: "google", type: "google", label: "Google", source: "env" });
  if (config_.oidcIssuer && config_.oidcClientId) {
    fromEnv.push({ key: "oidc", type: "oidc", label: config_.oidcDisplayName || "SSO", source: "env" });
  }
  const rows = await db
    .select({ key: authProviders.key, type: authProviders.type, label: authProviders.label })
    .from(authProviders)
    .where(eq(authProviders.enabled, true));
  const taken = new Set(fromEnv.map((p) => p.key));
  return {
    password: !config_.authDisablePassword,
    providers: [
      ...fromEnv,
      ...rows.filter((r) => !taken.has(r.key)).map((r) => ({ ...r, source: "database" as const })),
    ],
  };
}

export async function buildSystemStatus(workspaceId: string): Promise<SystemStatus> {
  const now = clock.now();
  const t0 = Date.now();
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }
  const latencyMs = dbOk ? Date.now() - t0 : null;
  if (!dbOk) {
    return {
      ...buildInfo(),
      checkedAt: now.toISOString(),
      database: { ok: false, latencyMs: null },
      backup: await backupState(now),
      signIn: { password: !config_.authDisablePassword, providers: [] },
      ai: { configured: false, provider: null, problem: null },
      email: emailState(),
      publicUrl: { webUrl: config_.webUrl, apiBaseUrl: config_.apiBaseUrl, issues: urlIssues(config_.webUrl, config_.apiBaseUrl) },
      workspace: { members: 0, agents: 0, issues: 0 },
    };
  }
  const [signIn, provider, members, agentCount, issueCount] = await Promise.all([
    signInState(),
    resolveProvider(workspaceId).catch((e: unknown) => {
      // a saved provider that cannot be read is a finding for the checklist, not a failed request
      if (e instanceof AiError) return { problem: e.code } as const;
      throw e;
    }),
    db.select({ n: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
    db.select({ n: count() }).from(agents).where(eq(agents.workspaceId, workspaceId)),
    db.select({ n: count() }).from(issues).where(eq(issues.workspaceId, workspaceId)),
  ]);
  const problem = provider && "problem" in provider ? provider.problem : null;
  const view = provider && !("problem" in provider) ? viewOf(provider) : null;
  return {
    ...buildInfo(),
    checkedAt: now.toISOString(),
    database: { ok: true, latencyMs },
    backup: await backupState(now),
    signIn,
    ai: {
      configured: view !== null,
      provider: view
        ? { source: view.source, kind: view.kind, label: view.label, model: view.model, hasKey: view.hasKey, monthlyCapCents: view.monthlyCapCents }
        : null,
      problem,
    },
    email: emailState(),
    publicUrl: { webUrl: config_.webUrl, apiBaseUrl: config_.apiBaseUrl, issues: urlIssues(config_.webUrl, config_.apiBaseUrl) },
    workspace: { members: members[0]?.n ?? 0, agents: agentCount[0]?.n ?? 0, issues: issueCount[0]?.n ?? 0 },
  };
}
