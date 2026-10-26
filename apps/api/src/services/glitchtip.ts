import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { glitchtipIntegrations, teams } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import {
  parseGlitchtipAlert,
  renderBody,
  type GlitchtipItem,
} from "../lib/glitchtip.js";
import { clock } from "./clock.js";
import { ingestIntake, type IntakeResult } from "./intake.js";
import { hashToken } from "./tokens.js";

export type GlitchtipIntegration = typeof glitchtipIntegrations.$inferSelect;

export const TOKEN_PREFIX = "tly_gt_";

export function generateGlitchtipToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export async function findIntegrationByToken(
  token: string,
): Promise<GlitchtipIntegration | undefined> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) return undefined;
  const [row] = await db
    .select()
    .from(glitchtipIntegrations)
    .where(eq(glitchtipIntegrations.tokenHash, hashToken(token)))
    .limit(1);
  return row && row.enabled ? row : undefined;
}

export function webhookPath(token: string): string {
  return `/webhooks/glitchtip/${token}`;
}

// lowercased GlitchTip project name -> team key; the payload carries the
// project name, not its slug
export function normalizeProjectMap(
  map: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, team] of Object.entries(map)) {
    const k = name.trim().toLowerCase();
    if (k) out[k] = team.trim().toUpperCase();
  }
  return out;
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
  item: GlitchtipItem,
): string | undefined {
  const mapped = item.projectName
    ? integration.projectMap[item.projectName.toLowerCase()]
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

export async function ingestGlitchtipAlert(
  integration: GlitchtipIntegration,
  rawBody: string,
  body: unknown,
): Promise<AlertOutcome> {
  const parsed = parseGlitchtipAlert(body, integration.glitchtipHost);
  if (parsed.items.length === 0) {
    return { ignored: true, dropped: parsed.dropped, results: [] };
  }

  // decide every destination before ingesting anything so a batch never
  // half-lands
  const destinations = parsed.items.map((item) => ({
    item,
    teamKey: teamFor(integration, item),
  }));
  const unmapped = destinations.filter((d) => !d.teamKey);
  if (unmapped.length > 0) {
    const names = [
      ...new Set(unmapped.map((d) => d.item.projectName ?? "(no project)")),
    ].slice(0, 10);
    throw new HttpError(
      422,
      "UNMAPPED_PROJECT",
      `no team mapped for GlitchTip project ${names.join(", ")} and no default team is set`,
    );
  }
  const keys = [...new Set(destinations.map((d) => d.teamKey!))];
  const found = await db
    .select({ key: teams.key })
    .from(teams)
    .where(
      and(eq(teams.workspaceId, integration.workspaceId), inArray(teams.key, keys)),
    );
  const missing = keys.filter((k) => !found.some((t) => t.key === k));
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "UNKNOWN_TEAM",
      `mapped team not found: ${missing.join(", ")}`,
    );
  }

  await db
    .update(glitchtipIntegrations)
    .set({
      lastReceivedAt: clock.now(),
      ...(integration.glitchtipHost ? {} : { glitchtipHost: parsed.items[0]!.host }),
    })
    .where(eq(glitchtipIntegrations.id, integration.id));

  const results: AlertResult[] = [];
  for (const [i, { item, teamKey }] of destinations.entries()) {
    const r = await ingestIntake(
      integration.workspaceId,
      {
        kind: "error",
        title: item.title,
        body: renderBody(item),
        provider: "glitchtip",
        fingerprint: item.fingerprint,
        externalId: externalIdFor(rawBody, i),
        url: item.url,
        severity: item.severity,
        occurredAt: clock.now().toISOString(),
        payload: {
          project: item.projectName ?? null,
          culprit: item.culprit ?? null,
          fields: item.fields,
        },
      },
      { type: "system", id: null },
      { teamKey: teamKey!, skipRank: true },
    );
    results.push({
      status: r.status,
      teamKey: teamKey!,
      ...(r.issue
        ? { issueKey: r.issue.key, occurrenceCount: r.issue.occurrenceCount }
        : {}),
    });
  }
  return { ignored: false, dropped: parsed.dropped, results };
}
