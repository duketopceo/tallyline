import * as Sentry from "@sentry/browser";
import type { ErrorEvent } from "@sentry/browser";

// Browser self error reporting (GlitchTip / Sentry-compatible).
// Strictly gated on NEXT_PUBLIC_SENTRY_DSN: zero-op when unset so self-hosters
// send zero telemetry.

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-tallyline-token)$/i;

const SENSITIVE_KEY_RE =
  /(authorization|cookie|secret|token|password|passwd|api[_-]?key|private[_-]?key|jwt|credential)/i;

const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redactBrowserUrl(raw: string): string {
  return raw
    .replace(/(\/webhooks\/glitchtip\/)([^/?#]+)/gi, "$1[REDACTED]")
    .replace(/(\/v1\/intake\/)([^/?#]+)/gi, "$1[REDACTED]")
    .replace(/(\/v1\/reporters\/)([^/?#]+)/gi, "$1[REDACTED]")
    .replace(
      /([?&](?:code|state|token|access_token|refresh_token|id_token|client_secret|api_key|key|secret)=)([^&#]+)/gi,
      "$1[REDACTED]",
    );
}

function scrubString(value: string): string {
  return redactBrowserUrl(value).replace(BEARER_RE, "$1 [REDACTED]");
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

export function scrubBrowserEvent(event: ErrorEvent): ErrorEvent {
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
      event.request.query_string = scrubString(
        `?${event.request.query_string.replace(/^\?/, "")}`,
      ).replace(/^\?/, "");
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
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") {
        ex.value = scrubString(ex.value);
      }
    }
  }
  return event;
}

let initialized = false;

export function initWebTelemetry(dsn = process.env.NEXT_PUBLIC_SENTRY_DSN): boolean {
  const trimmed = dsn?.trim();
  if (!trimmed) {
    initialized = false;
    return false;
  }
  if (initialized) return true;
  Sentry.init({
    dsn: trimmed,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    beforeSend: (event) => scrubBrowserEvent(event),
  });
  initialized = true;
  return true;
}

export function isWebTelemetryEnabled(): boolean {
  return initialized;
}

export function captureWebException(err: unknown): void {
  if (!initialized) return;
  Sentry.captureException(err);
}
