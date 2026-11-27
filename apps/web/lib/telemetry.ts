// Lightweight zero-dependency browser error reporter for GlitchTip / Sentry.
// Strictly gated on NEXT_PUBLIC_SENTRY_DSN: zero-op when unset so self-hosters
// send zero telemetry and bundle size stays minimal.

export interface WebErrorEvent {
  event_id?: string;
  timestamp?: string;
  platform?: string;
  level?: string;
  environment?: string;
  request?: {
    url?: string;
    query_string?: string;
    cookies?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  user?: {
    id?: string;
    email?: string;
    ip_address?: string;
    username?: string;
  };
  breadcrumbs?: Array<{
    message?: string;
    data?: Record<string, unknown>;
  }>;
  extra?: Record<string, unknown>;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
    }>;
  };
}

export interface ParsedDsn {
  storeUrl: string;
  publicKey: string;
}

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-tallyline-token)$/i;

const SENSITIVE_KEY_RE =
  /^(?:authorization|proxy[_-]?authorization|cookie|cookies|set[_-]?cookie|secret|signing[_-]?secret|client[_-]?secret|token|oauth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|api[_-]?key|apikey|private[_-]?key|jwt|credential|dsn)$/i;

const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;

export function parseSentryDsn(rawDsn: string | undefined): ParsedDsn | null {
  const trimmed = rawDsn?.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const publicKey = u.username;
    const segments = u.pathname.split("/").filter(Boolean);
    const projectId = segments.pop();
    if (!publicKey || !projectId) return null;
    const basePath = segments.length > 0 ? `/${segments.join("/")}` : "";
    const storeUrl = `${u.protocol}//${u.host}${basePath}/api/${encodeURIComponent(projectId)}/store/?sentry_key=${encodeURIComponent(publicKey)}&sentry_version=7`;
    return { storeUrl, publicKey };
  } catch {
    return null;
  }
}

export function redactBrowserUrl(raw: string): string {
  return raw
    .replace(/(\/webhooks\/glitchtip\/)([^/?#]+)/gi, "$1[REDACTED]")
    .replace(/(\/v1\/intake\/)([^/?#]+)/gi, "$1[REDACTED]")
    .replace(/(\/v1\/reports?\/|\/v1\/reporters\/)([^/?#]+)/gi, "$1[REDACTED]")
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

export function scrubBrowserEvent(event: WebErrorEvent): WebErrorEvent {
  const cloned: WebErrorEvent = { ...event };
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
      req.query_string = scrubString(
        `?${req.query_string.replace(/^\?/, "")}`,
      ).replace(/^\?/, "");
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

let activeDsn: ParsedDsn | null = null;
let listenersAttached = false;

export function initWebTelemetry(dsn = process.env.NEXT_PUBLIC_SENTRY_DSN): boolean {
  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    activeDsn = null;
    return false;
  }
  activeDsn = parsed;
  if (!listenersAttached && typeof window !== "undefined") {
    listenersAttached = true;
    window.addEventListener("error", (ev) => {
      captureWebException(ev.error ?? ev.message);
    });
    window.addEventListener("unhandledrejection", (ev) => {
      captureWebException(ev.reason);
    });
  }
  return true;
}

export function isWebTelemetryEnabled(): boolean {
  return activeDsn !== null;
}

function buildPayload(err: unknown): WebErrorEvent {
  const e = err instanceof Error ? err : null;
  const href = typeof window !== "undefined" ? window.location.href : undefined;
  return scrubBrowserEvent({
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level: "error",
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    ...(href ? { request: { url: href } } : {}),
    exception: {
      values: [
        {
          type: e ? e.name : "Error",
          value: e ? e.message : String(err),
        },
      ],
    },
  });
}

export function captureWebException(err: unknown): void {
  if (!activeDsn || typeof fetch !== "function") return;
  const payload = buildPayload(err);
  void fetch(activeDsn.storeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    // Telemetry must never surface a secondary unhandled error.
  });
}
