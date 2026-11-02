import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { isOriginDown } from "../src/index";

const env = { RETRY_AFTER_SECONDS: "120", ORIGIN_TIMEOUT_MS: "5000" } as unknown as Env;
const html = { accept: "text/html,application/xhtml+xml" };

function run(request: Request, e: Env = env): Promise<Response> {
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], e);
}
const get = (path = "/", headers: Record<string, string> = html) =>
  new Request(`https://tallyline.example${path}`, { headers });

let originFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  originFetch = vi.fn();
  vi.stubGlobal("fetch", originFetch);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pass-through", () => {
  it("returns a healthy origin response untouched", async () => {
    const origin = new Response("hello", { status: 200, headers: { "x-app": "1" } });
    originFetch.mockResolvedValue(origin);
    const res = await run(get());
    expect(res).toBe(origin);
    expect(originFetch).toHaveBeenCalledOnce();
  });

  it.each([301, 400, 401, 404, 429, 500])("does not replace an app %i", async (status) => {
    originFetch.mockResolvedValue(new Response("app error", { status }));
    const res = await run(get());
    expect(res.status).toBe(status);
    expect(await res.text()).toBe("app error");
  });

  it.each([502, 503, 504])("keeps a %i the app itself sent as JSON", async (status) => {
    const body = JSON.stringify({ error: { code: "UPSTREAM", message: "x" } });
    originFetch.mockResolvedValue(new Response(body, { status, headers: { "content-type": "application/json" } }));
    const res = await run(get("/api/me"));
    expect(res.status).toBe(status);
    expect(res.headers.get("x-tallyline-offline")).toBeNull();
    expect(await res.text()).toBe(body);
  });

  it("keeps a 503 event stream", async () => {
    originFetch.mockResolvedValue(new Response("", { status: 503, headers: { "content-type": "text/event-stream" } }));
    expect((await run(get())).headers.get("x-tallyline-offline")).toBeNull();
  });
});

describe("offline page", () => {
  it.each([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])(
    "serves the branded page for origin status %i",
    async (status) => {
      originFetch.mockResolvedValue(new Response("<h1>Bad gateway</h1>", { status, headers: { "content-type": "text/html" } }));
      const res = await run(get("/issues/ABC-1?token=secret"));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("120");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      const body = await res.text();
      expect(body).toContain("Tallyline is offline, back soon");
      expect(body).not.toContain("Bad gateway");
      expect(body).not.toContain("<script");
    },
  );

  it("treats a plain-text 502 (tunnel up, service down) as offline", async () => {
    originFetch.mockResolvedValue(new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } }));
    expect((await run(get())).status).toBe(503);
    expect(isOriginDown(new Response(null, { status: 502 }))).toBe(true);
  });

  it("serves the page when the origin fetch throws", async () => {
    originFetch.mockRejectedValue(new TypeError("Network connection lost."));
    const res = await run(get());
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Tallyline is offline, back soon");
  });

  it("answers HEAD without a body", async () => {
    originFetch.mockResolvedValue(new Response(null, { status: 523 }));
    const res = await run(new Request("https://tallyline.example/", { method: "HEAD", headers: html }));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("");
  });

  it("logs the path without the query string", async () => {
    originFetch.mockResolvedValue(new Response(null, { status: 523 }));
    await run(get("/oauth/consent?code=abc"));
    const line = String(vi.mocked(console.warn).mock.calls[0]?.[0]);
    expect(line).toContain("/oauth/consent");
    expect(line).not.toContain("abc");
  });
});

describe("api clients", () => {
  it("answers non-HTML requests with the JSON error envelope", async () => {
    originFetch.mockResolvedValue(new Response(null, { status: 523 }));
    const res = await run(get("/v1/issues", { accept: "application/json" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("retry-after")).toBe("120");
    expect(await res.json()).toEqual({
      error: { code: "ORIGIN_UNAVAILABLE", message: "Tallyline is offline, back soon" },
    });
  });

  it("never serves the HTML page to a write", async () => {
    originFetch.mockRejectedValue(new TypeError("boom"));
    const req = new Request("https://tallyline.example/api/issues", { method: "POST", headers: html, body: "{}" });
    const res = await run(req);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("timeout", () => {
  it("serves the page when the origin does not answer in time", async () => {
    vi.useFakeTimers();
    originFetch.mockImplementation(
      (_req: Request, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = run(get());
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain("timeout");
  });

  it("stops the timer once headers arrive so streams are not cut", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    originFetch.mockImplementation(async (_req: Request, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response("stream", { status: 200 });
    });
    const res = await run(get());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(false);
    expect(res.status).toBe(200);
  });
});

describe("config", () => {
  it("falls back to defaults for missing or invalid vars", async () => {
    originFetch.mockResolvedValue(new Response(null, { status: 523 }));
    const res = await run(get(), { RETRY_AFTER_SECONDS: "nope" } as unknown as Env);
    expect(res.headers.get("retry-after")).toBe("120");
  });

  it("honours RETRY_AFTER_SECONDS", async () => {
    originFetch.mockResolvedValue(new Response(null, { status: 523 }));
    const res = await run(get(), { RETRY_AFTER_SECONDS: "600", ORIGIN_TIMEOUT_MS: "5000" } as unknown as Env);
    expect(res.headers.get("retry-after")).toBe("600");
    expect(await res.text()).toContain("10 minutes");
  });
});
