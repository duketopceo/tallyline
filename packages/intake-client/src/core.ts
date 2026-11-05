// Public intake client. One job: hand the caller's event to
// `POST /v1/intake/:key` unchanged, and say what the server answered.
//
// Nothing is added to the payload. No fingerprints, timestamps, user agent,
// page URL or environment is manufactured here: identity that the server sees
// is identity the caller chose to send, which keeps dedupe and the reporter's
// own tooling in agreement.

export const INTAKE_KINDS = ["error", "bug", "help", "issue"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export const INTAKE_SEVERITIES = ["fatal", "error", "warning", "info"] as const;
export type IntakeSeverity = (typeof INTAKE_SEVERITIES)[number];

export interface IntakeReporter {
  email?: string;
  name?: string;
  followUp?: boolean;
}

/** Mirrors the ingest schema in `apps/api/src/routes/intake-public.ts`. */
export interface IntakeEvent {
  kind: IntakeKind;
  title: string;
  body?: string;
  provider?: string;
  fingerprint?: string;
  externalId?: string;
  url?: string;
  severity?: IntakeSeverity;
  occurredAt?: string;
  payload?: Record<string, unknown>;
  reporter?: IntakeReporter;
}

/** The slice of `fetch` this client needs, so it types without DOM libs. */
export interface IntakeResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<IntakeResponse>;

/** Return `null` to drop the report; return the event to send it. */
export type BeforeSend = (
  event: IntakeEvent,
) => IntakeEvent | null | Promise<IntakeEvent | null>;

export type ReportResult =
  | {
      status: "sent";
      httpStatus: number;
      created: boolean;
      issueKey: string | null;
      reporterToken: string | null;
      deduped: boolean;
    }
  /** `beforeSend` cancelled the report; nothing was sent. */
  | { status: "dropped" }
  | { status: "failed"; httpStatus: number; code: string | null };

export interface ClientOptions {
  /** The per-project intake key (`tlintake_…`). */
  key: string;
  /** Origin of the API, e.g. `https://api.tallyline.app`. Omit in a browser to use the page origin. */
  endpoint?: string;
  /** Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Extra attempts after a 429. Default 2. */
  maxRetries?: number;
  /** Ceiling for one `Retry-After` wait. Default 60 s. */
  maxRetryDelayMs?: number;
  beforeSend?: BeforeSend;
  /** Test seam: how a retry wait is spent. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: the clock used to read an HTTP-date `Retry-After`. */
  now?: () => number;
}

export interface IntakeClient {
  readonly key: string;
  report(event: IntakeEvent): Promise<ReportResult>;
}

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isFetchLike(value: unknown): value is FetchLike {
  return typeof value === "function";
}

function globalFetch(): FetchLike {
  const candidate: unknown = (globalThis as { fetch?: unknown }).fetch;
  if (!isFetchLike(candidate)) {
    throw new Error(
      "intake-client: no global fetch available; pass options.fetch",
    );
  }
  return candidate;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date. Returns `null` when
 * the header is absent or unreadable — in that case there is nothing to honour
 * and the 429 is returned to the caller instead of guessed at.
 */
export function parseRetryAfter(
  header: string | null,
  nowMs: number,
): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

async function readJson(
  response: IntakeResponse,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    // A proxy or a crash can answer with plain text; that is a failed report,
    // not a reason to throw at the caller.
    return null;
  }
}

function stringField(
  body: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = body?.[field];
  return typeof value === "string" ? value : null;
}

function errorCode(body: Record<string, unknown> | null): string | null {
  const error = body?.["error"];
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function createClient(options: ClientOptions): IntakeClient {
  const key = options.key;
  if (key.trim() === "") {
    throw new Error("intake-client: key is required");
  }

  const endpoint = trimTrailingSlash(options.endpoint ?? "");
  const send = options.fetch ?? globalFetch();
  const beforeSend = options.beforeSend;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const url = `${endpoint}/v1/intake/${encodeURIComponent(key)}`;

  return {
    key,
    async report(event: IntakeEvent): Promise<ReportResult> {
      const outgoing = beforeSend ? await beforeSend(event) : event;
      if (outgoing === null) return { status: "dropped" };

      const body = JSON.stringify(outgoing);

      for (let attempt = 0; ; attempt += 1) {
        let response: IntakeResponse;
        try {
          response = await send(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
        } catch {
          return { status: "failed", httpStatus: 0, code: "NETWORK_ERROR" };
        }

        const parsed =
          response.status === 200 || response.status === 201
            ? await readJson(response)
            : null;

        if (response.status === 200 || response.status === 201) {
          return {
            status: "sent",
            httpStatus: response.status,
            created: response.status === 201,
            issueKey: stringField(parsed, "issueKey"),
            reporterToken: stringField(parsed, "reporterToken"),
            deduped: parsed?.["deduped"] === true,
          };
        }

        if (response.status === 429 && attempt < maxRetries) {
          const delay = parseRetryAfter(
            response.headers.get("retry-after"),
            now(),
          );
          if (delay !== null) {
            await sleep(Math.min(delay, maxRetryDelayMs));
            continue;
          }
        }

        return {
          status: "failed",
          httpStatus: response.status,
          code: errorCode(await readJson(response)),
        };
      }
    },
  };
}

// A module-level client, so a snippet is `init(...)` once and `report(...)`
// anywhere — the shape most embedders want from an error reporter.
let defaultClient: IntakeClient | null = null;

export function init(options: ClientOptions): IntakeClient {
  defaultClient = createClient(options);
  return defaultClient;
}

export function report(event: IntakeEvent): Promise<ReportResult> {
  if (defaultClient === null) {
    return Promise.reject(
      new Error("intake-client: call init({ key, endpoint }) before report()"),
    );
  }
  return defaultClient.report(event);
}
