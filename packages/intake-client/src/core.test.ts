import { describe, expect, it } from "vitest";
import {
  createClient,
  init,
  parseRetryAfter,
  report,
  type FetchLike,
  type IntakeEvent,
  type IntakeResponse,
} from "./core.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): IntakeResponse {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

function recorder(steps: Array<IntakeResponse | Error>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step === undefined) throw new Error("no response queued");
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

function sleeping(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

const BUG: IntakeEvent = {
  kind: "bug",
  title: "Checkout hangs",
  body: "Steps:\n1. open cart",
  externalId: "evt_1",
  severity: "error",
  occurredAt: "2026-11-03T12:00:00.000Z",
  payload: { route: "/cart", depth: 2 },
};

describe("report", () => {
  it("posts the event to /v1/intake/:key and reads the created answer", async () => {
    const { fetch, calls } = recorder([
      jsonResponse(201, {
        issueKey: "ENG-42",
        reporterToken: null,
        deduped: false,
      }),
    ]);
    const client = createClient({
      key: "tlintake_abc",
      endpoint: "https://api.example.com",
      fetch,
    });

    const result = await client.report(BUG);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/intake/tlintake_abc",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(BUG);
    expect(result).toEqual({
      status: "sent",
      httpStatus: 201,
      created: true,
      issueKey: "ENG-42",
      reporterToken: null,
      deduped: false,
    });
  });

  it("sends exactly the keys the caller passed and nothing else", async () => {
    const { fetch, calls } = recorder([
      jsonResponse(201, { issueKey: "ENG-7", deduped: false }),
    ]);
    const client = createClient({ key: "k", endpoint: "https://a.test", fetch });

    await client.report({
      kind: "help",
      title: "How do I rotate a key?",
      externalId: "support-123",
    });

    const body: unknown = JSON.parse(calls[0]?.body ?? "{}");
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([
      "externalId",
      "kind",
      "title",
    ]);
    expect((body as Record<string, unknown>)["externalId"]).toBe("support-123");
  });

  it("accepts an endpoint with a trailing slash and a relative endpoint", async () => {
    const { fetch, calls } = recorder([
      jsonResponse(200, { issueKey: "ENG-1", deduped: true }),
      jsonResponse(200, { issueKey: "ENG-1", deduped: true }),
    ]);

    await createClient({ key: "k", endpoint: "https://a.test/", fetch }).report(
      BUG,
    );
    await createClient({ key: "k", fetch }).report(BUG);

    expect(calls.map((call) => call.url)).toEqual([
      "https://a.test/v1/intake/k",
      "/v1/intake/k",
    ]);
  });

  it("reports a replay as deduped and keeps the follow-up token", async () => {
    const { fetch } = recorder([
      jsonResponse(200, { deduped: true, reporterToken: "tlrp_xyz" }),
    ]);
    const client = createClient({ key: "k", fetch });

    const result = await client.report(BUG);

    expect(result).toMatchObject({
      status: "sent",
      httpStatus: 200,
      created: false,
      issueKey: null,
      reporterToken: "tlrp_xyz",
      deduped: true,
    });
  });

  it("returns NETWORK_ERROR instead of throwing when fetch fails", async () => {
    const { fetch } = recorder([new Error("ECONNREFUSED")]);
    const result = await createClient({ key: "k", fetch }).report(BUG);

    expect(result).toEqual({
      status: "failed",
      httpStatus: 0,
      code: "NETWORK_ERROR",
    });
  });

  it("refuses to build without a key", () => {
    expect(() => createClient({ key: "  " })).toThrow(/key is required/);
  });
});

describe("retry", () => {
  it("waits Retry-After seconds on a 429 and then succeeds", async () => {
    const { sleep, waits } = sleeping();
    const { fetch, calls } = recorder([
      jsonResponse(429, {}, { "retry-after": "2" }),
      jsonResponse(201, { issueKey: "ENG-9", deduped: false }),
    ]);
    const client = createClient({ key: "k", fetch, sleep });

    const result = await client.report(BUG);

    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
    expect(result).toMatchObject({ status: "sent", issueKey: "ENG-9" });
  });

  it("reads an HTTP-date Retry-After against the supplied clock", async () => {
    const { sleep, waits } = sleeping();
    const nowMs = Date.parse("2026-11-03T12:00:00.000Z");
    const { fetch, calls } = recorder([
      jsonResponse(429, {}, { "retry-after": "Tue, 03 Nov 2026 12:00:05 GMT" }),
      jsonResponse(201, { issueKey: "ENG-10" }),
    ]);
    const client = createClient({
      key: "k",
      fetch,
      sleep,
      now: () => nowMs,
    });

    await client.report(BUG);

    expect(calls).toHaveLength(2);
    expect(waits).toEqual([5000]);
  });

  it("gives up after maxRetries and returns the last refusal", async () => {
    const { sleep, waits } = sleeping();
    const { fetch, calls } = recorder([
      jsonResponse(429, { error: { code: "RATE_LIMITED" } }, {
        "retry-after": "1",
      }),
    ]);
    const client = createClient({ key: "k", fetch, sleep, maxRetries: 2 });

    const result = await client.report(BUG);

    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 1000]);
    expect(result).toEqual({
      status: "failed",
      httpStatus: 429,
      code: "RATE_LIMITED",
    });
  });

  it("honours maxRetryDelayMs instead of waiting an hour", async () => {
    const { sleep, waits } = sleeping();
    const { fetch } = recorder([
      jsonResponse(429, {}, { "retry-after": "3600" }),
      jsonResponse(201, { issueKey: "ENG-11" }),
    ]);
    const client = createClient({
      key: "k",
      fetch,
      sleep,
      maxRetryDelayMs: 1000,
    });

    await client.report(BUG);

    expect(waits).toEqual([1000]);
  });

  it("does not retry a 429 that carries no Retry-After", async () => {
    const { sleep, waits } = sleeping();
    const { fetch, calls } = recorder([
      jsonResponse(429, {}, { "retry-after": "not-a-delay" }),
    ]);
    const client = createClient({ key: "k", fetch, sleep });

    const result = await client.report(BUG);

    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(result).toMatchObject({ status: "failed", httpStatus: 429 });
  });

  it("does not retry 401 or 410 and surfaces the server code", async () => {
    for (const [status, code] of [
      [401, "INTAKE_KEY_INVALID"],
      [410, "INTAKE_KEY_REVOKED"],
    ] as const) {
      const { sleep } = sleeping();
      const { fetch, calls } = recorder([
        jsonResponse(status, { error: { code, message: "no" } }),
      ]);
      const client = createClient({ key: "k", fetch, sleep });

      const result = await client.report(BUG);

      expect(calls).toHaveLength(1);
      expect(result).toEqual({ status: "failed", httpStatus: status, code });
    }
  });

  it("parses Retry-After as seconds, a date, or not at all", () => {
    expect(parseRetryAfter("2", 0)).toBe(2000);
    expect(parseRetryAfter("  0 ", 0)).toBe(0);
    expect(parseRetryAfter("Tue, 03 Nov 2026 12:00:05 GMT", 0)).toBeGreaterThan(
      0,
    );
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});

describe("beforeSend", () => {
  it("sends what the hook returns, not what the caller passed", async () => {
    const { fetch, calls } = recorder([
      jsonResponse(201, { issueKey: "ENG-12" }),
    ]);
    const client = createClient({
      key: "k",
      fetch,
      beforeSend: (event) => ({ ...event, payload: { route: "/cart" } }),
    });

    await client.report({ ...BUG, payload: { route: "/cart", email: "a@b.c" } });

    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      ...BUG,
      payload: { route: "/cart" },
    });
  });

  it("drops the report when the hook returns null", async () => {
    const { fetch, calls } = recorder([jsonResponse(201, {})]);
    const client = createClient({ key: "k", fetch, beforeSend: () => null });

    const result = await client.report(BUG);

    expect(calls).toEqual([]);
    expect(result).toEqual({ status: "dropped" });
  });

  it("waits for an async hook", async () => {
    const { fetch, calls } = recorder([
      jsonResponse(201, { issueKey: "ENG-13" }),
    ]);
    const client = createClient({
      key: "k",
      fetch,
      beforeSend: async (event) => ({ ...event, title: "scrubbed" }),
    });

    await client.report(BUG);

    expect(JSON.parse(calls[0]?.body ?? "").title).toBe("scrubbed");
  });
});

describe("module-level client", () => {
  it("rejects report() until init() has run", async () => {
    await expect(report(BUG)).rejects.toThrow(/call init/);
  });

  it("uses the last init() call", async () => {
    const { fetch, calls } = recorder([
      jsonResponse(201, { issueKey: "ENG-14" }),
    ]);
    init({ key: "module-key", endpoint: "https://a.test", fetch });

    const result = await report(BUG);

    expect(calls[0]?.url).toBe("https://a.test/v1/intake/module-key");
    expect(result).toMatchObject({ status: "sent", issueKey: "ENG-14" });
  });
});
