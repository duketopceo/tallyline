import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { glitchtipIntegrations, teams, workspaces } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import {
  parseGlitchtipAlert,
  type GlitchtipItem,
} from "../lib/glitchtip.js";
import { clock } from "./clock.js";
import { ingestIntake, type IntakeInput, type IntakeResult } from "./intake.js";
import {
  normalizeGlitchtipItem,
  normalizeSentryAlert,
} from "./intake-normalize.js";
import { hashToken } from "./tokens.js";

export type GlitchtipIntegration = typeof glitchtipIntegrations.$inferSelect;

export const TOKEN_PREFIX = "tly_gt_";

export function generateGlitchtipToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

// a fresh secret plus the only two forms of it that are ever stored
export function mintGlitchtipToken(): {
  token: string;
  tokenHash: string;
  tokenLast4: string;
} {
  const token = generateGlitchtipToken();
  return { token, tokenHash: hashToken(token), tokenLast4: token.slice(-4) };
}

// team keys from `keys` that do not exist in the workspace
export async function missingTeamKeys(
  workspaceId: string,
  keys: string[],
): Promise<string[]> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({ key: teams.key })
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), inArray(teams.key, unique)));
  return unique.filter((k) => !rows.some((r) => r.key === k));
}

export async function findIntegrationByToken(
  token: string,
): Promise<GlitchtipIntegration | undefined> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) return undefined;
  // a workspace pending deletion is closed: its URL answers like an unknown one
  const [row] = await db
    .select({ integration: glitchtipIntegrations })
    .from(glitchtipIntegrations)
    .innerJoin(workspaces, eq(workspaces.id, glitchtipIntegrations.workspaceId))
    .where(
      and(
        eq(glitchtipIntegrations.tokenHash, hashToken(token)),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  return row?.integration.enabled ? row.integration : undefined;
}

export function webhookPath(token: string): string {
  return `/webhooks/glitchtip/${token}`;
}

// lowercased GlitchTip project name -> team key; the payload carries the
// project name, not its slug
export function normalizeProjectMap(
  map: Record<string, string>,
): Record<string, string> {
  // fromEntries defines own properties, so a project named "__proto__" stays data
  return Object.fromEntries(
    Object.entries(map)
      .map(([name, team]) => [name.trim().toLowerCase(), team.trim().toUpperCase()] as const)
      .filter(([name]) => name),
  );
}

export interface AlertResult {
  status: IntakeResult["status"];
  issueKey?: string;
  teamKey: string;
  occurrenceCount?: number;
}

export interface AlertOutcome {
  ignored: boolean;
  dropped: number;
  results: AlertResult[];
}

function teamFor(
  integration: GlitchtipIntegration,
  item: { projectName: string | undefined },
): string | undefined {
  // own-property lookup: a project called "constructor" must not hit Object.prototype
  const name = item.projectName?.toLowerCase();
  const mapped =
    name !== undefined && Object.hasOwn(integration.projectMap, name)
      ? integration.projectMap[name]
      : undefined;
  return mapped ?? integration.defaultTeamKey ?? undefined;
}

// externalId per attachment: GlitchTip sends no delivery id and never
// retries, so an identical body inside the same minute is treated as a
// duplicate delivery while a later identical alert reaches the fingerprint
// path and bumps the occurrence count.
function externalIdFor(rawBody: string, index: number): string {
  const digest = createHash("sha256")
    .update(`${rawBody}:${index}`)
    .digest("hex");
  return `${digest}:${Math.floor(clock.ms() / 60_000)}`;
}

// One delivery path for every error source: the sender-specific parser has
// produced IntakeInputs, and only the routing and idempotency stay here.
interface ErrorEntry {
  input: IntakeInput;
  projectName: string | undefined;
}

async function deliverErrorItems(
  integration: GlitchtipIntegration,
  rawBody: string,
  entries: ErrorEntry[],
  dropped: number,
): Promise<AlertOutcome> {
  // decide every destination before ingesting anything so a batch never
  // half-lands
  const destinations: { entry: ErrorEntry; teamKey: string }[] = [];
  const unmapped: ErrorEntry[] = [];
  for (const entry of entries) {
    const teamKey = teamFor(integration, entry);
    if (teamKey) destinations.push({ entry, teamKey });
    else unmapped.push(entry);
  }
  if (unmapped.length > 0) {
    const names = [
      ...new Set(unmapped.map((entry) => entry.projectName ?? "(no project)")),
    ].slice(0, 10);
    throw new HttpError(
      422,
      "UNMAPPED_PROJECT",
      `no team mapped for project ${names.join(", ")} and no default team is set`,
    );
  }
  const missing = await missingTeamKeys(
    integration.workspaceId,
    destinations.map((d) => d.teamKey),
  );
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "UNKNOWN_TEAM",
      `mapped team not found: ${missing.join(", ")}`,
    );
  }

  await db
    .update(glitchtipIntegrations)
    .set({ lastReceivedAt: clock.now() })
    .where(eq(glitchtipIntegrations.id, integration.id));

  const results: AlertResult[] = [];
  for (const [i, { entry, teamKey }] of destinations.entries()) {
    const r = await ingestIntake(
      integration.workspaceId,
      // a sender that carries its own delivery id (Sentry's event_id) keeps
      // it; GlitchTip has none, so the body hash stands in
      {
        ...entry.input,
        externalId: entry.input.externalId ?? externalIdFor(rawBody, i),
      },
      { type: "system", id: null },
      { teamKey, skipRank: true },
    );
    results.push({
      status: r.status,
      teamKey,
      ...(r.issue
        ? { issueKey: r.issue.key, occurrenceCount: r.issue.occurrenceCount }
        : {}),
    });
  }
  return { ignored: false, dropped, results };
}

export async function ingestGlitchtipAlert(
  integration: GlitchtipIntegration,
  rawBody: string,
  body: unknown,
): Promise<AlertOutcome> {
  const parsed = parseGlitchtipAlert(body, integration.glitchtipHost);
  if (parsed.items.length === 0) {
    return { ignored: true, dropped: parsed.dropped, results: [] };
  }
  const outcome = await deliverErrorItems(
    integration,
    rawBody,
    parsed.items.map((item: GlitchtipItem) => ({
      input: normalizeGlitchtipItem(item, clock.now().toISOString()),
      projectName: item.projectName,
    })),
    parsed.dropped,
  );
  // remember the host so later deliveries can reject foreign issue links
  if (!integration.glitchtipHost) {
    await db
      .update(glitchtipIntegrations)
      .set({ glitchtipHost: parsed.items[0]!.host })
      .where(eq(glitchtipIntegrations.id, integration.id));
  }
  return outcome;
}

/**
 * Sentry webhook -> intake. The payload's signature is verified by the route
 * before this runs; from here it is the same delivery path as GlitchTip.
 */
export async function ingestSentryAlert(
  integration: GlitchtipIntegration,
  rawBody: string,
  body: unknown,
): Promise<AlertOutcome> {
  const parsed = normalizeSentryAlert(body);
  if (parsed.items.length === 0) {
    return { ignored: true, dropped: parsed.dropped, results: [] };
  }
  return deliverErrorItems(
    integration,
    rawBody,
    parsed.items.map((input) => ({
      input,
      projectName:
        typeof input.payload?.project === "string"
          ? input.payload.project
          : undefined,
    })),
    parsed.dropped,
  );
}
