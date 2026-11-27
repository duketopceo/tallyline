import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import { redactUrl } from "./logger.js";

// Self error reporting (GlitchTip / Sentry-compatible).
// Strictly gated on SENTRY_DSN: when unset, initTelemetry is a complete zero-op
// so self-hosted installs send zero telemetry.

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-tallyline-token|x-hub-signature-256|x-slack-signature|sentry-hook-signature)$/i;

const SENSITIVE_KEY_RE =
  /(authorization|cookie|secret|token|password|passwd|api[_-]?key|private[_-]?key|jwt|credential)/i;

const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;

function scrubString(value: string): string {
  return redactUrl(value).replace(BEARER_RE, "$1 [REDACTED]");
}

function scrubRecord(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 6) return obj;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
    } else if (typeof val === "string") {
      out[key] = scrubString(val);
    } else if (Array.isArray(val)) {
      out[key] = val.map((item) =>
        typeof item === "string"
          ? scrubString(item)
          : item && typeof item === "object"
            ? scrubRecord(item as Record<string, unknown>, depth + 1)
            : item,
      );
    } else if (val && typeof val === "object") {
      out[key] = scrubRecord(val as Record<string, unknown>, depth + 1);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    if (event.request.headers) {
      const cleanHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(event.request.headers)) {
        cleanHeaders[k] = SENSITIVE_HEADER_RE.test(k) ? "[REDACTED]" : scrubString(String(v));
      }
      event.request.headers = cleanHeaders;
    }
    if ("cookies" in event.request) {
      delete event.request.cookies;
    }
    if (typeof event.request.url === "string") {
      event.request.url = scrubString(event.request.url);
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = scrubString(`?${event.request.query_string.replace(/^\?/, "")}`).replace(/^\?/, "");
    } else if (event.request.query_string && typeof event.request.query_string === "object") {
      event.request.query_string = scrubRecord(
        event.request.query_string as Record<string, unknown>,
      ) as Record<string, string>;
    }
  }

  if (event.user) {
    delete event.user.email;
    delete event.user.ip_address;
    delete event.user.username;
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      ...(typeof crumb.message === "string" ? { message: scrubString(crumb.message) } : {}),
      ...(crumb.data ? { data: scrubRecord(crumb.data) } : {}),
    }));
  }

  if (event.extra) {
    event.extra = scrubRecord(event.extra);
  }

  if (event.contexts) {
    for (const [ctxKey, ctxVal] of Object.entries(event.contexts)) {
      if (ctxVal && typeof ctxVal === "object") {
        event.contexts[ctxKey] = scrubRecord(ctxVal as Record<string, unknown>);
      }
    }
  }

  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") {
        ex.value = scrubString(ex.value);
      }
    }
  }

  return event;
}

let enabled = false;

export interface TelemetryOptions {
  dsn?: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
}

export function initTelemetry(opts: TelemetryOptions): boolean {
  const dsn = opts.dsn?.trim();
  if (!dsn) {
    enabled = false;
    return false;
  }
  Sentry.init({
    dsn,
    environment: opts.environment || process.env.NODE_ENV || "development",
    release: opts.release || undefined,
    beforeSend: (event) => scrubSentryEvent(event),
  });
  enabled = true;
  return true;
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context) {
      scope.setContext("request", scrubRecord(context));
    }
    Sentry.captureException(err);
  });
}

export async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs);
}
