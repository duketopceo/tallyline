// Parser for GlitchTip's own alert webhook body (generic "webhook" and "slack"
// recipient types). Shape per glitchtip-backend apps/alerts/webhooks.py
// (WebhookPayload.to_dict): {text, attachments:[{title, title_link, text,
// color, fields:[{title, value, short}], mrkdown_in}]}. There is no signature
// and no delivery id. Everything here treats the payload as untrusted input.

export const MAX_ATTACHMENTS = 25;
const TITLE_MAX = 300;
const CULPRIT_MAX = 500;
const FIELD_MAX = 200;
const MAX_FIELDS = 20;

export type GlitchtipSeverity = "error" | "warning" | "info";

export interface GlitchtipItem {
  title: string;
  culprit: string | undefined;
  url: string;
  fingerprint: string;
  host: string;
  projectName: string | undefined;
  severity: GlitchtipSeverity;
  fields: { title: string; value: string }[];
}

export interface ParsedAlert {
  items: GlitchtipItem[];
  // attachments that carried an issue link but were not accepted (foreign
  // host, non-https, over the per-delivery cap)
  dropped: number;
}

// error and fatal share one color in GlitchTip, so fatal is unreachable
const COLOR_SEVERITY: Record<string, GlitchtipSeverity> = {
  "#e52b50": "error",
  "#e9b949": "warning",
  "#4b60b4": "info",
};

export function severityFromColor(color: unknown): GlitchtipSeverity {
  return typeof color === "string"
    ? (COLOR_SEVERITY[color.trim().toLowerCase()] ?? "error")
    : "error";
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, max) : undefined;
}

// <GLITCHTIP_URL>/<org-slug>/issues/<pk> (Issue.get_detail_url)
export function parseIssueUrl(
  raw: unknown,
): { url: string; host: string; org: string; pk: string } | undefined {
  if (typeof raw !== "string" || raw.length > 2000) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:") return undefined;
  const segs = u.pathname.split("/").filter(Boolean);
  const n = segs.length;
  if (n < 3 || segs[n - 2] !== "issues") return undefined;
  const pk = segs[n - 1]!;
  const org = segs[n - 3]!;
  if (!/^\d{1,18}$/.test(pk)) return undefined;
  return { url: `${u.origin}${u.pathname}`, host: u.host.toLowerCase(), org, pk };
}

interface RawAttachment {
  title?: unknown;
  title_link?: unknown;
  text?: unknown;
  color?: unknown;
  fields?: unknown;
}

export function parseGlitchtipAlert(
  body: unknown,
  expectedHost: string | null,
): ParsedAlert {
  const out: ParsedAlert = { items: [], dropped: 0 };
  if (!body || typeof body !== "object") return out;
  const attachments = (body as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return out;

  let host = expectedHost?.toLowerCase() ?? null;
  for (const a of attachments as RawAttachment[]) {
    if (!a || typeof a !== "object") continue;
    const link = parseIssueUrl(a.title_link);
    if (!link) continue; // uptime alerts and test pings carry no issue link
    if (host && link.host !== host) {
      out.dropped++;
      continue;
    }
    if (out.items.length >= MAX_ATTACHMENTS) {
      out.dropped++;
      continue;
    }
    host ??= link.host;
    const title = clean(a.title, TITLE_MAX) ?? `GlitchTip issue ${link.pk}`;
    const fields: { title: string; value: string }[] = [];
    let projectName: string | undefined;
    if (Array.isArray(a.fields)) {
      for (const f of a.fields.slice(0, MAX_FIELDS)) {
        if (!f || typeof f !== "object") continue;
        const t = clean((f as { title?: unknown }).title, 60);
        const v = clean((f as { value?: unknown }).value, FIELD_MAX);
        if (!t || !v) continue;
        if (t === "Project") projectName = v;
        else fields.push({ title: t, value: v });
      }
    }
    out.items.push({
      title,
      culprit: clean(a.text, CULPRIT_MAX),
      url: link.url,
      fingerprint: `glitchtip:${link.host}/${link.org}/${link.pk}`,
      host: link.host,
      projectName,
      severity: severityFromColor(a.color),
      fields,
    });
  }
  return out;
}

// plain, escaped-ish text: no markdown fences, links or mentions from the
// payload become structure in the issue body
export function renderBody(item: GlitchtipItem): string {
  const noTicks = (s: string) => s.replace(/[`<>@]/g, "'");
  const lines = [
    item.projectName ? `Project: ${noTicks(item.projectName)}` : undefined,
    ...item.fields.map((f) => `${noTicks(f.title)}: ${noTicks(f.value)}`),
    item.culprit ? `Culprit: ${noTicks(item.culprit)}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}
