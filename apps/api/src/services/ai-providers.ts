import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../auth/secrets.js";
import { db } from "../db/client.js";
import { aiProviders, aiUsageLedger, events } from "../db/schema.js";
import { config_ } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { assertSafeOutboundUrl, safeFetchText, webhookAllowPrivate } from "../lib/net-guard.js";
import { clock } from "./clock.js";

// The workspace's AI provider: the one seam agent actions call for a model.
// Two kinds today, both speaking the OpenAI chat-completions dialect:
//   openrouter         the owner's OpenRouter key (first-party default)
//   openai_compatible  any base URL: Hermes, a local model server, a gateway
// The ChatGPT-plan provider is deliberately absent until its spike says go.
//
// Rules that hold here, and are tested:
//  - the key is sealed at rest and appears in no response, event or error;
//  - a call past the monthly cap is refused before it is made, in plain words;
//  - every call, including failures, lands in the usage ledger;
//  - egress uses the SSRF policy (https and public addresses; private networks
//    and plain http only when the operator set TALLYLINE_WEBHOOK_ALLOW_PRIVATE).

export type ProviderKind = "openrouter" | "openai_compatible";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_MONTHLY_CAP_CENTS = 1000; // $10
export const MAX_MONTHLY_CAP_CENTS = 1_000_000; // $10,000 sanity bound
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TOKENS_CEILING = 4096;
const DEFAULT_MAX_TOKENS = 512;

export class AiError extends HttpError {}

export interface ResolvedProvider {
  source: "workspace" | "environment";
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  capCents: number | null;
}

export interface ProviderInput {
  kind: ProviderKind;
  label: string;
  baseUrl?: string | undefined;
  model: string;
  /** omitted on update = keep the stored key; "" = remove it */
  apiKey?: string | undefined;
  monthlyCapCents?: number | null | undefined;
}

export function normalizeBaseUrl(kind: ProviderKind, raw: string | undefined): string {
  const base = kind === "openrouter" ? OPENROUTER_BASE : (raw ?? "").trim();
  if (!base) throw new AiError(422, "BASE_URL_REQUIRED", "an OpenAI-compatible provider needs a base URL");
  return base.replace(/\/+$/, "");
}

/** Save-time check; the same policy is enforced again at connect time. */
export async function assertProviderUrl(baseUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AiError(422, "BAD_BASE_URL", "that doesn't look like a web address");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && webhookAllowPrivate())) {
    throw new AiError(
      422,
      "BASE_URL_NOT_HTTPS",
      "the address must start with https:// (plain http is only allowed on servers set up for a private network)",
    );
  }
  try {
    await assertSafeOutboundUrl(baseUrl);
  } catch (e) {
    throw new AiError(422, "BASE_URL_NOT_ALLOWED", e instanceof Error ? e.message : "that address isn't allowed");
  }
}

function sealKey(plain: string): string {
  if (!config_.authSecretKey) {
    throw new AiError(
      503,
      "SECRETS_KEY_MISSING",
      "this server has no AUTH_SECRET_KEY, so it can't store an API key safely; ask whoever runs it to set one",
    );
  }
  return encryptSecret(plain, config_.authSecretKey);
}

export async function resolveProvider(workspaceId: string): Promise<ResolvedProvider | null> {
  const [row] = await db.select().from(aiProviders).where(eq(aiProviders.workspaceId, workspaceId));
  if (row) {
    let apiKey: string | null = null;
    if (row.apiKeyEnc) {
      try {
        apiKey = decryptSecret(row.apiKeyEnc, config_.authSecretKey);
      } catch {
        throw new AiError(
          409,
          "AI_KEY_UNREADABLE",
          "the saved API key can't be read (the server's AUTH_SECRET_KEY changed); enter it again in Settings",
        );
      }
    }
    return {
      source: "workspace",
      kind: row.kind as ProviderKind,
      label: row.label,
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey,
      capCents: row.monthlyCapCents,
    };
  }
  if (config_.llmApiKey) {
    return {
      source: "environment",
      kind: "openrouter",
      label: "Set by the server",
      baseUrl: config_.llmBaseUrl.replace(/\/+$/, ""),
      model: config_.llmModel,
      apiKey: config_.llmApiKey,
      capCents: null,
    };
  }
  return null;
}

/** Everything the Settings screen may show. Never includes the key. */
export interface ProviderView {
  source: "workspace" | "environment";
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  monthlyCapCents: number | null;
  /** environment providers can't be edited or removed here */
  editable: boolean;
}

export function viewOf(p: ResolvedProvider): ProviderView {
  return {
    source: p.source,
    kind: p.kind,
    label: p.label,
    baseUrl: p.baseUrl,
    model: p.model,
    hasKey: p.apiKey !== null,
    monthlyCapCents: p.capCents,
    editable: p.source === "workspace",
  };
}

async function emit(workspaceId: string, actorId: string, action: string, entityId: string, after: Record<string, unknown>) {
  await db.insert(events).values({
    workspaceId,
    actorType: "human",
    actorId,
    action,
    entityType: "ai_provider",
    entityId,
    after,
  });
}

export async function saveProvider(workspaceId: string, actorId: string, input: ProviderInput): Promise<void> {
  const baseUrl = normalizeBaseUrl(input.kind, input.baseUrl);
  await assertProviderUrl(baseUrl);
  const cap =
    input.monthlyCapCents === undefined ? undefined : input.monthlyCapCents;
  if (cap !== undefined && cap !== null && (cap < 0 || cap > MAX_MONTHLY_CAP_CENTS)) {
    throw new AiError(422, "BAD_CAP", "the monthly limit must be between $0 and $10,000");
  }
  const [existing] = await db.select().from(aiProviders).where(eq(aiProviders.workspaceId, workspaceId));
  const apiKeyEnc =
    input.apiKey === undefined
      ? (existing?.apiKeyEnc ?? null)
      : input.apiKey === ""
        ? null
        : sealKey(input.apiKey);
  if (input.kind === "openrouter" && !apiKeyEnc) {
    throw new AiError(422, "API_KEY_REQUIRED", "OpenRouter needs an API key");
  }
  const values = {
    kind: input.kind,
    label: input.label.trim(),
    baseUrl,
    model: input.model.trim(),
    apiKeyEnc,
    monthlyCapCents: cap === undefined ? (existing ? existing.monthlyCapCents : DEFAULT_MONTHLY_CAP_CENTS) : cap,
    updatedAt: clock.now(),
  };
  const safeAfter = {
    kind: values.kind,
    label: values.label,
    baseUrl: values.baseUrl,
    model: values.model,
    hasKey: apiKeyEnc !== null,
    monthlyCapCents: values.monthlyCapCents,
  };
  if (existing) {
    await db.update(aiProviders).set(values).where(eq(aiProviders.id, existing.id));
    await emit(workspaceId, actorId, "ai_provider_changed", existing.id, safeAfter);
  } else {
    const [row] = await db
      .insert(aiProviders)
      .values({ workspaceId, createdBy: actorId, ...values })
      .returning({ id: aiProviders.id });
    await emit(workspaceId, actorId, "ai_provider_connected", row!.id, safeAfter);
  }
}

export async function removeProvider(workspaceId: string, actorId: string): Promise<boolean> {
  const deleted = await db
    .delete(aiProviders)
    .where(eq(aiProviders.workspaceId, workspaceId))
    .returning({ id: aiProviders.id });
  if (!deleted.length) return false;
  await emit(workspaceId, actorId, "ai_provider_disconnected", deleted[0]!.id, {});
  return true;
}

// ── spend ────────────────────────────────────────────────────────────────

const MICROS_PER_CENT = 10_000;

function monthWindow(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export async function monthSpend(workspaceId: string, now = clock.now()) {
  const { start, end } = monthWindow(now);
  const [row] = await db
    .select({
      micros: sql<number>`coalesce(sum(${aiUsageLedger.costMicros}), 0)::float8`,
      calls: sql<number>`count(*)::int`,
      tokensIn: sql<number>`coalesce(sum(${aiUsageLedger.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${aiUsageLedger.tokensOut}), 0)::int`,
    })
    .from(aiUsageLedger)
    .where(
      and(
        eq(aiUsageLedger.workspaceId, workspaceId),
        gte(aiUsageLedger.createdAt, start),
        lt(aiUsageLedger.createdAt, end),
      ),
    );
  return {
    spentCents: Math.round(((row?.micros ?? 0) / MICROS_PER_CENT) * 100) / 100,
    spentMicros: row?.micros ?? 0,
    calls: row?.calls ?? 0,
    tokensIn: row?.tokensIn ?? 0,
    tokensOut: row?.tokensOut ?? 0,
    periodStart: start,
    periodEnd: end,
  };
}

export async function recentUsage(workspaceId: string, limit = 50) {
  return db
    .select({
      action: aiUsageLedger.action,
      model: aiUsageLedger.model,
      tokensIn: aiUsageLedger.tokensIn,
      tokensOut: aiUsageLedger.tokensOut,
      costMicros: aiUsageLedger.costMicros,
      status: aiUsageLedger.status,
      createdAt: aiUsageLedger.createdAt,
    })
    .from(aiUsageLedger)
    .where(eq(aiUsageLedger.workspaceId, workspaceId))
    .orderBy(desc(aiUsageLedger.createdAt))
    .limit(Math.min(limit, 200));
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function assertUnderCap(workspaceId: string, capCents: number | null): Promise<void> {
  if (capCents === null) return;
  const { spentMicros } = await monthSpend(workspaceId);
  if (spentMicros >= capCents * MICROS_PER_CENT) {
    throw new AiError(
      402,
      "AI_CAP_REACHED",
      `This month's AI spending limit (${dollars(capCents)}) has been reached. An admin can raise it in Settings, AI.`,
    );
  }
}

// ── calling the model ────────────────────────────────────────────────────

export type AiFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; body: string }>;

let fetchImpl: AiFetch = (url, init) =>
  safeFetchText(url, { ...init, timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });

/** test hook: replace the network */
export function __setAiFetchForTests(f: AiFetch | null): void {
  fetchImpl =
    f ?? ((url, init) => safeFetchText(url, { ...init, timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES }));
}

export interface CompleteInput {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompleteResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
}

interface ChatBody {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: unknown };
}

async function ledger(workspaceId: string, action: string, model: string, u: Partial<CompleteResult>, status: "ok" | "error") {
  await db.insert(aiUsageLedger).values({
    workspaceId,
    action,
    model,
    tokensIn: u.tokensIn ?? 0,
    tokensOut: u.tokensOut ?? 0,
    costMicros: u.costMicros ?? 0,
    status,
  });
}

/**
 * One model call for a workspace. Refuses before calling when the monthly cap is
 * spent, and always writes a ledger row afterwards. Errors are plain: they name
 * the upstream status but never include the request, the key or the response body.
 */
export async function complete(workspaceId: string, action: string, input: CompleteInput): Promise<CompleteResult> {
  const p = await resolveProvider(workspaceId);
  if (!p) {
    throw new AiError(409, "AI_NOT_CONFIGURED", "No AI provider is connected yet. An admin can connect one in Settings, AI.");
  }
  await assertUnderCap(workspaceId, p.capCents);

  const maxTokens = Math.min(Math.max(1, Math.floor(input.maxTokens ?? DEFAULT_MAX_TOKENS)), MAX_TOKENS_CEILING);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  if (p.kind === "openrouter") {
    headers["http-referer"] = config_.apiBaseUrl;
    headers["x-title"] = "tallyline";
  }
  const body = JSON.stringify({
    model: p.model,
    max_tokens: maxTokens,
    temperature: input.temperature ?? 0.2,
    messages: [
      ...(input.system ? [{ role: "system", content: input.system }] : []),
      { role: "user", content: input.user },
    ],
    // OpenRouter reports the real cost of the call when asked
    ...(p.kind === "openrouter" ? { usage: { include: true } } : {}),
  });

  let res: { status: number; body: string };
  try {
    res = await fetchImpl(`${p.baseUrl}/chat/completions`, { method: "POST", headers, body });
  } catch (e) {
    await ledger(workspaceId, action, p.model, {}, "error");
    const why = e instanceof Error ? p.apiKey ? e.message.replaceAll(p.apiKey, "***") : e.message : "network error";
    throw new AiError(502, "AI_UNREACHABLE", `Couldn't reach ${p.label}: ${why}`);
  }

  let parsed: ChatBody | null = null;
  try {
    parsed = JSON.parse(res.body) as ChatBody;
  } catch {
    parsed = null;
  }
  const tokensIn = Math.max(0, Math.floor(parsed?.usage?.prompt_tokens ?? 0));
  const tokensOut = Math.max(0, Math.floor(parsed?.usage?.completion_tokens ?? 0));
  const costMicros = Math.max(0, Math.round((parsed?.usage?.cost ?? 0) * 1_000_000));

  if (res.status < 200 || res.status >= 300) {
    await ledger(workspaceId, action, p.model, { tokensIn, tokensOut, costMicros }, "error");
    const reason =
      res.status === 401 || res.status === 403
        ? "it didn't accept the API key"
        : res.status === 402
          ? "it says the account is out of credit"
          : res.status === 404
            ? "it doesn't know that model or address"
            : res.status === 429
              ? "it is rate limiting requests"
              : `it answered with an error (${res.status})`;
    throw new AiError(502, "AI_UPSTREAM", `${p.label} didn't complete the request: ${reason}.`);
  }
  const text = typeof parsed?.choices?.[0]?.message?.content === "string" ? parsed.choices[0]!.message!.content.trim() : "";
  if (!text) {
    await ledger(workspaceId, action, p.model, { tokensIn, tokensOut, costMicros }, "error");
    throw new AiError(502, "AI_UPSTREAM", `${p.label} answered with nothing.`);
  }
  await ledger(workspaceId, action, p.model, { tokensIn, tokensOut, costMicros }, "ok");
  return { text, model: p.model, tokensIn, tokensOut, costMicros };
}
