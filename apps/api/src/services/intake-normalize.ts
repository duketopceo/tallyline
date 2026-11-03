// One normaliser for every error source. A first-party report posted to
// /v1/intake/:key, a GlitchTip alert and a Sentry webhook all arrive as
// different payloads; each becomes the same IntakeInput before it reaches
// ingestIntake. Everything here treats its input as untrusted.

import { renderBody, type GlitchtipItem } from "../lib/glitchtip.js";
import type { IntakeInput } from "./intake.js";

export const FIRST_PARTY_PROVIDER = "intake";

const TITLE_MAX = 500;
const BODY_MAX = 100_000;
const TAG_VALUE_MAX = 200;
const MAX_TAGS = 20;

export type IntakeSeverity = NonNullable<IntakeInput["severity"]>;

/** The body shape POST /v1/intake/:key accepts (routes/intake-public.ts). */
export interface FirstPartyReport {
  kind: IntakeInput["kind"];
  title: string;
  body?: string | undefined;
  provider?: string | undefined;
  fingerprint?: string | undefined;
  externalId?: string | undefined;
  url?: string | undefined;
  severity?: IntakeSeverity | undefined;
  occurredAt?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

const SEVERITIES = new Set<string>(["fatal", "error", "warning", "info"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // control characters never survive into an issue body
  const flat = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat ? flat.slice(0, max) : undefined;
}

// body text keeps its line breaks; only control characters are dropped
function cleanMultiline(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .trim();
  return text ? text.slice(0, max) : undefined;
}

function httpsUrl(value: unknown): string | undefined {  const raw = clean(value, 2_000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isoTime(value: unknown): string | undefined {
  // Sentry sends `datetime` as ISO and `timestamp` as epoch seconds
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? undefined : new Date(at).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1_000;
    return new Date(ms).toISOString();
  }
  return undefined;
}

function severityOf(value: unknown): IntakeSeverity {
  // Sentry's `debug` is below info; anything unknown is an error
  if (value === "debug") return "info";
  return typeof value === "string" && SEVERITIES.has(value)
    ? (value as IntakeSeverity)
    : "error";
}

/**
 * First-party path: apply defaults and caps, nothing else. The caller has
 * already scoped fingerprint and externalId to its credential.
 */
export function normalizeFirstPartyReport(report: FirstPartyReport): IntakeInput {
  return {
    kind: report.kind,
    title: clean(report.title, TITLE_MAX) ?? report.title.slice(0, TITLE_MAX),
    body: cleanMultiline(report.body, BODY_MAX),
    provider: report.provider ?? FIRST_PARTY_PROVIDER,
    fingerprint: report.fingerprint,
    externalId: report.externalId,
    url: httpsUrl(report.url),
    severity: report.severity,
    occurredAt: isoTime(report.occurredAt),
    payload: report.payload,
  };
}

/** A Sentry webhook (issue alert or the legacy "webhook" integration). */
export function isSentryAlert(body: unknown): boolean {
  const b = asRecord(body);
  if (!b) return false;
  if (asRecord(asRecord(b.data)?.event)) return true;
  if (asRecord(b.event)) return true;
  // an event delivered bare (no envelope)
  return typeof b.event_id === "string" && (b.title !== undefined || b.message !== undefined);
}

export interface NormalizedSentryAlert {
  items: IntakeInput[];
  dropped: number;
}

function sentryTags(value: unknown): { title: string; value: string }[] {
  const out: { title: string; value: string }[] = [];
  const push = (key: unknown, val: unknown) => {
    const t = clean(key, 60);
    const v = clean(val, TAG_VALUE_MAX);
    if (t && v && out.length < MAX_TAGS) out.push({ title: t, value: v });
  };
  if (Array.isArray(value)) {
    for (const pair of value) {
      if (Array.isArray(pair)) push(pair[0], pair[1]);
      else {
        const r = asRecord(pair);
        if (r) push(r.key, r.value);
      }
    }
  } else {
    const r = asRecord(value);
    if (r) for (const [k, v] of Object.entries(r)) push(k, v);
  }
  return out;
}

/**
 * Sentry -> IntakeInput. Only "triggered" and "created" actions are new or
 * repeat errors; resolved/assigned/ignored notifications are acknowledgements
 * and map to nothing.
 */export function normalizeSentryAlert(body: unknown): NormalizedSentryAlert {
  const b = asRecord(body);
  if (!b) return { items: [], dropped: 0 };

  const action = typeof b.action === "string" ? b.action : undefined;
  if (action !== undefined && action !== "triggered" && action !== "created") {
    return { items: [], dropped: 0 };
  }

  const data = asRecord(b.data) ?? {};
  const issue = asRecord(data.issue);
  // data.event is the issue-alert envelope; b itself is a bare event
  const event = asRecord(data.event) ?? asRecord(b.event) ?? b;
  if (!event) return { items: [], dropped: 0 };

  const eventId = clean(event.event_id, 64) ?? clean(b.event_id, 64);
  const issueId =
    clean(event.issue_id, 64) ??
    (issue?.id !== undefined ? clean(String(issue.id), 64) : undefined) ??
    eventId;

  const projectRecord = asRecord(event.project);
  const project =
    clean(event.project_name, 100) ??
    clean(projectRecord?.name, 100) ??
    clean(event.project, 100) ??
    clean(asRecord(issue?.project)?.slug, 100) ??
    clean(asRecord(issue?.project)?.name, 100);

  const title =
    clean(event.title, TITLE_MAX) ??
    clean(event.message, TITLE_MAX) ??
    clean(issue?.title, TITLE_MAX) ??
    `Sentry error${eventId ? ` ${eventId}` : ""}`;

  const tags = sentryTags(event.tags);
  const culprit = clean(event.culprit, 500);
  const platform = clean(event.platform, 60);
  const release = clean(asRecord(event.release)?.version ?? event.release, 100);
  const lines = [
    project ? `Project: ${project}` : undefined,
    culprit ? `Culprit: ${culprit}` : undefined,
    platform ? `Platform: ${platform}` : undefined,
    release ? `Release: ${release}` : undefined,
    ...tags.map((t) => `${t.title}: ${t.value}`),
  ].filter((l): l is string => Boolean(l));

  return {
    items: [
      {
        kind: "error",
        title,
        body: lines.length > 0 ? lines.join("\n").slice(0, BODY_MAX) : undefined,
        provider: "sentry",
        // the Sentry issue is the repeat unit; the event is the delivery unit
        fingerprint: issueId ? `sentry:${project ? `${project}/` : ""}${issueId}` : undefined,
        externalId: eventId ? `sentry:${eventId}` : undefined,
        url: httpsUrl(event.web_url ?? event.permalink ?? issue?.web_url),
        severity: severityOf(event.level),
        occurredAt: isoTime(event.datetime ?? event.timestamp),
        payload: {
          project: project ?? null,
          culprit: culprit ?? null,
          platform: platform ?? null,
          tags: tags.length > 0 ? tags : null,
        },
      },
    ],
    dropped: 0,
  };
}

/**
 * GlitchTip -> IntakeInput. The GlitchTip parser (lib/glitchtip.ts) has
 * already validated and capped the fields; this is only the mapping into the
 * shared intake shape.
 */
export function normalizeGlitchtipItem(
  item: GlitchtipItem,
  occurredAt: string,
): IntakeInput {
  return {
    kind: "error",
    title: clean(item.title, TITLE_MAX) ?? item.title.slice(0, TITLE_MAX),
    body: renderBody(item).slice(0, BODY_MAX) || undefined,
    provider: "glitchtip",
    fingerprint: item.fingerprint,
    url: item.url,
    severity: item.severity,
    occurredAt,
    payload: {
      project: item.projectName ?? null,
      culprit: item.culprit ?? null,
      fields: item.fields,
    },
  };
}
