import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { comments, intakeEvents, issues, teams } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { createAssist } from "./assist.js";
import { clock } from "./clock.js";
import { createIssue, type Actor } from "./issues.js";
import { aiEnabledFor } from "./ai-seam.js";

// Normalized automated-input event — GlitchTip errors, GitHub issues,
// request-for-help and bug reports all land in this shape (plan
// 2026-10-16). fingerprint groups repeats onto one issue; externalId gives
// delivery idempotency.
export interface IntakeInput {
  kind: "error" | "bug" | "help" | "issue";
  title: string;
  body?: string | undefined;
  provider?: string | undefined;
  fingerprint?: string | undefined;
  externalId?: string | undefined;
  url?: string | undefined;
  severity?: "fatal" | "error" | "warning" | "info" | undefined;
  occurredAt?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

// Call options that are not part of the event body: the GlitchTip receiver
// routes to a specific team and never feeds untrusted error text to the
// triage ranker.
export interface IntakeOptions {
  teamKey?: string | undefined;
  skipRank?: boolean | undefined;
}

export type IntakeStatus = "created" | "deduped" | "duplicate_delivery";

export interface IntakeResult {
  status: IntakeStatus;
  issue?: {
    key: string;
    title: string;
    state: string;
    source: string;
    occurrenceCount: number;
    triageSuggestion?: unknown;
  };
}

const TITLE_MAX = 500;
const PAYLOAD_MAX = 16_384;

function capPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!payload) return null;
  const s = JSON.stringify(payload);
  if (s.length <= PAYLOAD_MAX) return payload;
  return { truncated: true, bytes: s.length };
}

function describe(event: IntakeInput, provider: string): string | undefined {
  const provenance = [
    `Reported via ${provider} (${event.kind}${event.severity ? `, ${event.severity}` : ""})`,
    event.url,
    event.occurredAt ? `At ${event.occurredAt}` : undefined,
  ].filter(Boolean);
  const parts = [event.body, provenance.length ? `---\n${provenance.join("\n")}` : undefined];
  const text = parts.filter(Boolean).join("\n\n");
  return text || undefined;
}

export async function ingestIntake(
  workspaceId: string,
  event: IntakeInput,
  actor: Actor,
  options: IntakeOptions = {},
): Promise<IntakeResult> {
  const provider = event.provider ?? "generic";

  // 1. delivery idempotency — same (workspace, provider, externalId) is a
  // replay and drops without side effects. The partial unique index
  // backstops the application path.
  const [eventRow] = await db
    .insert(intakeEvents)
    .values({
      workspaceId,
      provider,
      externalId: event.externalId ?? null,
      fingerprint: event.fingerprint ?? null,
      payload: capPayload(event.payload),
    })
    .onConflictDoNothing()
    .returning({ id: intakeEvents.id });
  if (!eventRow) return { status: "duplicate_delivery" };

  // 2. fingerprint dedupe — a fingerprint already on a live issue bumps
  // occurrenceCount and leaves a provenance comment instead of a second
  // issue. Several issues can share a fingerprint (an earlier one was closed
  // and a newer one opened), so prefer a live one, newest first: a done-then-
  // new alert must land on the new issue, never spawn a third. Canceled and
  // duplicate issues still bump when nothing is live (a human verdict stands); done
  // issues never do, so a regression after a fix opens a fresh issue.
  if (event.fingerprint) {
    const [hit] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          eq(issues.intakeFingerprint, event.fingerprint),
        ),
      )
      .orderBy(
        sql`case ${issues.state} when 'done' then 2 when 'canceled' then 1 when 'duplicate' then 1 else 0 end`,
        desc(issues.createdAt),
      )
      .limit(1);
    if (hit && hit.state !== "done") {
      const count = (hit.occurrenceCount ?? 1) + 1;
      await db
        .update(issues)
        .set({ occurrenceCount: count, updatedAt: clock.now() })
        .where(eq(issues.id, hit.id));
      await db.insert(comments).values({
        workspaceId,
        issueId: hit.id,
        actorType: actor.type,
        actorId: actor.id,
        body: `New occurrence via ${provider}${event.url ? ` — ${event.url}` : ""} (total ${count})`,
        via: provider,
      });
      await db
        .update(intakeEvents)
        .set({ status: "deduped", issueId: hit.id })
        .where(eq(intakeEvents.id, eventRow.id));
      return {
        status: "deduped",
        issue: {
          key: hit.key,
          title: hit.title,
          state: hit.state,
          source: hit.source,
          occurrenceCount: count,
        },
      };
    }
  }

  // 3. intake lands on the requested team, else the workspace's first team,
  // as a triage issue
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(
      options.teamKey
        ? and(
            eq(teams.workspaceId, workspaceId),
            eq(teams.key, options.teamKey),
          )
        : eq(teams.workspaceId, workspaceId),
    )
    .orderBy(teams.key)
    .limit(1);
  if (!team) {
    throw new HttpError(
      422,
      "NO_TEAM",
      options.teamKey
        ? `team ${options.teamKey} not found for automated intake`
        : "workspace has no team to receive automated intake",
    );
  }

  const issue = await createIssue({
    workspaceId,
    teamId: team.id,
    title: event.title.slice(0, TITLE_MAX),
    description: describe(event, provider),
    source: "intake",
    state: "triage",
    creator: actor,
    intakeFingerprint: event.fingerprint,
  });
  await db
    .update(intakeEvents)
    .set({ issueId: issue.id })
    .where(eq(intakeEvents.id, eventRow.id));

  // 4. rank — best effort. Malformed model output or a down provider never
  // blocks intake; the issue stands and the suggestion stays null (plan U4:
  // never auto-transition).
  let suggestion:
    | { action: "accept" | "decline"; reason: string; at: string }
    | undefined;
  if (!options.skipRank && (await aiEnabledFor(workspaceId))) {
    try {
      const s = await createAssist().suggestTriage(workspaceId, issue.key);
      suggestion = {
        action: s.action,
        reason: s.reason,
        at: clock.now().toISOString(),
      };
      await db
        .update(issues)
        .set({ triageSuggestion: suggestion })
        .where(eq(issues.id, issue.id));
    } catch {
      // leave triageSuggestion null — ranked or not, intake succeeded
    }
  }

  return {
    status: "created",
    issue: {
      key: issue.key,
      title: issue.title,
      state: issue.state,
      source: issue.source,
      occurrenceCount: 1,
      ...(suggestion ? { triageSuggestion: suggestion } : {}),
    },
  };
}
