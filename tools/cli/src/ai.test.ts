import { describe, expect, it } from "vitest";
import { run } from "./cli.js";
import type { CliIo } from "./commands.js";

// S3-U3: `tallyline ai`. The fake server records every request so the tests
// can prove the key only ever travels in a request body from stdin, and the
// headless OpenRouter flow passes the sealed state back untouched.

const ENV = {
  HOME: "/nonexistent-ai-home",
  TALLYLINE_API_URL: "http://ai.test",
  TALLYLINE_TOKEN: "tly_pat_ai",
  TALLYLINE_WORKSPACE: "acme",
};

const VIEW = {
  source: "workspace",
  kind: "openrouter",
  label: "OpenRouter",
  baseUrl: null,
  model: "google/gemini-2.5-flash-lite",
  hasKey: true,
  monthlyCapCents: 1000,
  editable: true,
};

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function server(routes: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fetch = async (req: Request) => {
    const path = new URL(req.url).pathname.replace("/v1/workspaces/acme", "");
    const text = await req.text();
    seen.push({ method: req.method, path, body: text ? (JSON.parse(text) as Record<string, unknown>) : null });
    const r = routes[`${req.method} ${path}`];
    if (!r) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetch };
}

async function exec(argv: string[], over: Partial<CliIo>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: ENV,
    cwd: "/nonexistent-ai-cwd",
    fetch: async () => new Response("{}"),
    isTTY: false,
    ...over,
  };
  const code = await run(argv, io);
  return { out, err, code };
}

describe("tallyline ai", () => {
  it("status describes the provider and this month's spend", async () => {
    const s = server({
      "GET /ai/provider": {
        body: { provider: VIEW, defaultMonthlyCapCents: 1000, usage: { periodStart: "", periodEnd: "", spentCents: 37, calls: 4 } },
      },
    });
    const r = await exec(["ai", "status"], { fetch: s.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "provider: OpenRouter",
      "model:    google/gemini-2.5-flash-lite",
      "key:      stored, sealed",
      "month:    $0.37 of $10.00, 4 calls",
    ]);
  });

  it("connect openrouter runs headless PKCE: URL on stderr, pasted code, sealed state returned as-is", async () => {
    const s = server({
      "POST /ai/openrouter/start": {
        body: { authUrl: "https://openrouter.ai/auth?code_challenge=abc&code_challenge_method=S256", state: "SEALED", expiresAt: "" },
      },
      "POST /ai/openrouter/complete": { body: { provider: VIEW } },
    });
    const r = await exec(["ai", "connect", "openrouter", "--cap", "5"], {
      fetch: s.fetch,
      stdin: async () => "  one-time-code  \n",
    });
    expect(r.code).toBe(0);
    expect(s.seen[0]).toMatchObject({ path: "/ai/openrouter/start", body: { mode: "headless", monthlyCapCents: 500 } });
    expect(s.seen[1]).toMatchObject({ path: "/ai/openrouter/complete", body: { code: "one-time-code", state: "SEALED" } });
    expect(r.err.join("\n")).toContain("https://openrouter.ai/auth?code_challenge=abc");
    expect(r.out[0]).toContain("OpenRouter connected");
  });

  it("connect openrouter with no code stops before calling complete", async () => {
    const s = server({
      "POST /ai/openrouter/start": { body: { authUrl: "https://openrouter.ai/auth", state: "S", expiresAt: "" } },
    });
    const r = await exec(["ai", "connect", "openrouter"], { fetch: s.fetch, stdin: async () => "" });
    expect(r.code).toBe(2);
    expect(s.seen.map((x) => x.path)).toEqual(["/ai/openrouter/start"]);
  });

  it("connect compatible reads the key from stdin and never echoes it", async () => {
    const KEY = ["sk", "local", "0042"].join("-");
    const s = server({ "PUT /ai/provider": { body: { ...VIEW, kind: "openai_compatible", label: "Ollama", baseUrl: "https://llm.example.com/v1", model: "qwen3" } } });
    const r = await exec(
      ["ai", "connect", "compatible", "--base-url", "https://llm.example.com/v1", "--model", "qwen3", "--label", "Ollama"],
      { fetch: s.fetch, stdin: async () => `${KEY}\n` },
    );
    expect(r.code).toBe(0);
    expect(s.seen[0]!.body).toMatchObject({ kind: "openai_compatible", baseUrl: "https://llm.example.com/v1", model: "qwen3", apiKey: KEY });
    expect([...r.out, ...r.err].join("\n")).not.toContain(KEY);
  });

  it("refuses a key passed as an argument", async () => {
    const r = await exec(["ai", "connect", "compatible", "--base-url", "https://x/v1", "--model", "m", "--api-key", "sk-nope"], {});
    expect(r.code).toBe(2);
    expect([...r.out, ...r.err].join("\n")).not.toContain("sk-nope");
  });

  it("--no-key saves a keyless local endpoint without reading stdin", async () => {
    const s = server({ "PUT /ai/provider": { body: { ...VIEW, hasKey: false } } });
    let read = false;
    const r = await exec(["ai", "connect", "compatible", "--base-url", "https://x/v1", "--model", "m", "--no-key"], {
      fetch: s.fetch,
      stdin: async () => {
        read = true;
        return "";
      },
    });
    expect(r.code).toBe(0);
    expect(read).toBe(false);
    expect(s.seen[0]!.body).not.toHaveProperty("apiKey");
  });

  it("test exits 1 with the provider's plain-words reason", async () => {
    const s = server({ "POST /ai/provider/test": { body: { ok: false, code: "AI_CAP_REACHED", message: "monthly limit reached", ms: 3 } } });
    const r = await exec(["ai", "test"], { fetch: s.fetch });
    expect(r.code).toBe(1);
    expect(r.out).toContain("failed: monthly limit reached");
  });

  it("disconnect --json", async () => {
    const s = server({ "DELETE /ai/provider": { body: { ok: true } } });
    const r = await exec(["ai", "disconnect", "--json"], { fetch: s.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['{"disconnected":true}']);
  });
});
