import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import { redactUrl } from "./logger.js";

// Self error reporting (GlitchTip / Sentry-compatible).
// Strictly gated on SENTRY_DSN: when unset, initTelemetry is a complete zero-op
// so self-hosted installs send zero telemetry.

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-tallyline-token|x-hub-signature-256|x-slack-signature|sentry-hook-signature)$/i;

const SENSITIVE_KEY_RE =
  /^(?:authorization|proxy[_-]?authorization|cookie|cookies|set[_-]?cookie|secret|signing[_-]?secret|client[_-]?secret|token|oauth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|api[_-]?key|apikey|private[_-]?key|jwt|credential|dsn)$/i;

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
  const cloned: ErrorEvent = { ...event };
  if (cloned.request) {
    const req = { ...cloned.request };
    if (req.headers) {
      const cleanHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        cleanHeaders[k] = SENSITIVE_HEADER_RE.test(k) ? "[REDACTED]" : scrubString(String(v));
      }
      req.headers = cleanHeaders;
    }
    if ("cookies" in req) {
      delete req.cookies;
    }
    if (typeof req.url === "string") {
      req.url = scrubString(req.url);
    }
    if (typeof req.query_string === "string") {
      req.query_string = scrubString(`?${req.query_string.replace(/^\?/, "")}`).replace(/^\?/, "");
    } else if (req.query_string && typeof req.query_string === "object") {
      req.query_string = scrubRecord(
        req.query_string as Record<string, unknown>,
      ) as Record<string, string>;
    }
    cloned.request = req;
  }

  if (cloned.user) {
    const user = { ...cloned.user };
    delete user.email;
    delete user.ip_address;
    delete user.username;
    cloned.user = user;
  }

  if (cloned.breadcrumbs) {
    cloned.breadcrumbs = cloned.breadcrumbs.map((crumb) => ({
      ...crumb,
      ...(typeof crumb.message === "string" ? { message: scrubString(crumb.message) } : {}),
      ...(crumb.data ? { data: scrubRecord(crumb.data) } : {}),
    }));
  }

  if (cloned.extra) {
    cloned.extra = scrubRecord(cloned.extra);
  }

  if (cloned.contexts) {
    const contexts: Record<string, Record<string, unknown>> = {};
    for (const [ctxKey, ctxVal] of Object.entries(cloned.contexts)) {
      if (ctxVal && typeof ctxVal === "object") {
        contexts[ctxKey] = scrubRecord(ctxVal as Record<string, unknown>);
      }
    }
    cloned.contexts = contexts;
  }

  if (cloned.exception?.values) {
    cloned.exception = {
      ...cloned.exception,
      values: cloned.exception.values.map((ex) =>
        typeof ex.value === "string" ? { ...ex, value: scrubString(ex.value) } : { ...ex },
      ),
    };
  }

  return cloned;
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
