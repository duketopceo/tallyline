import { OFFLINE_TITLE, offlinePage } from "./page";

const DEFAULT_RETRY_AFTER_SECONDS = 120;
const DEFAULT_ORIGIN_TIMEOUT_MS = 30_000;
const PAGE_REFRESH_SECONDS = 30;

// Cloudflare's own origin-failure statuses (520 to 530, including 523 origin
// unreachable and 530 tunnel/origin DNS errors).
const CLOUDFLARE_ORIGIN_ERRORS = { min: 520, max: 530 };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * True when a response means "the origin is not there", as opposed to the
 * app answering with an error of its own. A 502/503/504 that carries JSON or an
 * event stream came from the app (its bridges return JSON errors), so it is
 * passed through unchanged.
 */
export function isOriginDown(res: Response): boolean {
  const { status } = res;
  if (status >= CLOUDFLARE_ORIGIN_ERRORS.min && status <= CLOUDFLARE_ORIGIN_ERRORS.max) return true;
  if (status !== 502 && status !== 503 && status !== 504) return false;
  const type = res.headers.get("content-type") ?? "";
  return !/application\/json|text\/event-stream/i.test(type);
}

function wantsHtml(request: Request): boolean {
  const safe = request.method === "GET" || request.method === "HEAD";
  return safe && (request.headers.get("accept") ?? "").includes("text/html");
}

function offlineResponse(request: Request, retryAfterSeconds: number): Response {
  const headers = new Headers({
    "retry-after": String(retryAfterSeconds),
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
    "x-tallyline-offline": "1",
    "x-content-type-options": "nosniff",
  });
  if (wantsHtml(request)) {
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    headers.set("x-frame-options", "DENY");
    const body = request.method === "HEAD" ? null : offlinePage({ retryAfterSeconds, refreshSeconds: PAGE_REFRESH_SECONDS });
    return new Response(body, { status: 503, headers });
  }
  // API clients (CLI, apps, webhooks) get the same error envelope the API uses
  headers.set("content-type", "application/json");
  const body = JSON.stringify({ error: { code: "ORIGIN_UNAVAILABLE", message: OFFLINE_TITLE } });
  return new Response(request.method === "HEAD" ? null : body, { status: 503, headers });
}

function logOffline(request: Request, reason: string): void {
  // path only: query strings can carry tokens and codes
  console.warn(JSON.stringify({ event: "origin_offline", reason, method: request.method, path: new URL(request.url).pathname }));
}

export default {
  async fetch(request, env): Promise<Response> {
    const retryAfter = positiveInt(env.RETRY_AFTER_SECONDS, DEFAULT_RETRY_AFTER_SECONDS);
    const timeoutMs = positiveInt(env.ORIGIN_TIMEOUT_MS, DEFAULT_ORIGIN_TIMEOUT_MS);

    // The timer covers only the wait for response headers. It is cleared as
    // soon as the origin answers so long-lived streams (SSE) are never cut.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(request, { signal: controller.signal });
    } catch (err) {
      logOffline(request, controller.signal.aborted ? "timeout" : err instanceof Error ? err.name : "fetch_failed");
      return offlineResponse(request, retryAfter);
    } finally {
      clearTimeout(timer);
    }

    if (isOriginDown(response)) {
      logOffline(request, `status_${response.status}`);
      // release the connection; the body of an error page is not needed
      await response.body?.cancel();
      return offlineResponse(request, retryAfter);
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
