// Structured JSON logger for the API server.
// Emits one JSON line per event with timestamp, level, optional request_id,
// and redacted URLs/paths so webhook secrets and OAuth tokens never land in logs.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  request_id?: string | undefined;
  [key: string]: unknown;
}

const SENSITIVE_QUERY_KEYS = new Set([
  "code",
  "state",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "api_key",
  "apikey",
  "key",
  "secret",
  "password",
  "signature",
  "sig",
]);

function redactPathname(pathname: string): string {
  return pathname
    // GlitchTip webhook carries its per-integration secret in the path
    .replace(/(\/webhooks\/glitchtip\/)([^/?#]+)/gi, "$1[REDACTED]")
    // Public intake carries a per-project capability key in the path
    .replace(/(\/v1\/intake\/)([^/?#]+)/gi, "$1[REDACTED]")
    // Reporter follow-up handle is a capability token in the path
    .replace(/(\/v1\/reports?\/|\/v1\/reporters\/)([^/?#]+)/gi, "$1[REDACTED]")
    // OAuth token/callback endpoints: redact any trailing token-like segment after /oauth/
    .replace(
      /(\/v1\/auth\/oauth\/[^/?#]+\/(?:callback|token|exchange|link)\/)([^/?#]+)/gi,
      "$1[REDACTED]",
    );
}

/**
 * Redact secrets embedded in URL paths or query strings:
 * - `/webhooks/glitchtip/<secret>` -> `/webhooks/glitchtip/[REDACTED]`
 * - `/v1/intake/<key>` -> `/v1/intake/[REDACTED]`
 * - `/v1/reporters/<token>` -> `/v1/reporters/[REDACTED]`
 * - `/v1/auth/oauth/*` and any URL query params like `code`, `state`, `token`, `access_token`, etc.
 */
export function redactUrl(raw: string): string {
  if (!raw) return raw;
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const isPathOrQuery = raw.startsWith("/") || raw.startsWith("?");
  if (!isAbsolute && !isPathOrQuery) {
    return redactPathname(raw).replace(
      /([?&](?:code|state|token|access_token|refresh_token|id_token|client_secret|api_key|key|secret)=)([^&#\s]+)/gi,
      "$1[REDACTED]",
    );
  }
  try {
    const parsed = new URL(raw, isAbsolute ? undefined : "http://placeholder.invalid");
    const redactedPath = redactPathname(parsed.pathname);
    const isOAuthPath = /\/v1\/auth\/oauth\//i.test(redactedPath) || /^\/oauth\//i.test(redactedPath);

    let search = "";
    if (parsed.search) {
      const params = new URLSearchParams(parsed.search);
      const pairs: string[] = [];
      for (const [k, v] of params.entries()) {
        if (isOAuthPath || SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) {
          pairs.push(`${encodeURIComponent(k)}=[REDACTED]`);
        } else {
          pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        }
      }
      if (pairs.length > 0) search = `?${pairs.join("&")}`;
    }

    const hash = parsed.hash ? (isOAuthPath ? "#[REDACTED]" : parsed.hash) : "";
    if (isAbsolute) {
      const origin = parsed.username || parsed.password
        ? `${parsed.protocol}//[REDACTED]@${parsed.host}`
        : parsed.origin;
      return `${origin}${redactedPath}${search}${hash}`;
    }
    return `${redactedPath}${search}${hash}`;
  } catch {
    return redactPathname(raw).replace(
      /([?&](?:code|state|token|access_token|refresh_token|id_token|client_secret|api_key|key|secret)=)([^&#]+)/gi,
      "$1[REDACTED]",
    );
  }
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error_name: err.name,
      error_message: redactUrl(err.message),
      ...(process.env.NODE_ENV !== "production" && err.stack
        ? { error_stack: err.stack }
        : {}),
    };
  }
  return { error_message: typeof err === "string" ? redactUrl(err) : String(err) };
}

function sanitizeFields(fields?: LogFields): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if ((k === "url" || k === "path" || k === "referer") && typeof v === "string") {
      out[k] = redactUrl(v);
    } else if (v instanceof Error) {
      out[k] = serializeError(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  msg: string;
  request_id?: string;
  [key: string]: unknown;
}

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

let activeSink: LogSink = defaultSink;

/** Override the output sink (primarily for tests). Returns a restore function. */
export function setLogSink(sink: LogSink): () => void {
  const prev = activeSink;
  activeSink = sink;
  return () => {
    activeSink = prev;
  };
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    msg,
    ...sanitizeFields(fields),
  };
  activeSink(level, JSON.stringify(entry));
}

export const logger = {
  debug: (msg: string, fields?: LogFields): void => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => emit("error", msg, fields),
};
