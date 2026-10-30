import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./cli.js";
import type { CliIo } from "./commands.js";
import { setColor } from "./pretty.js";
import type { TokenStore } from "./secrets.js";
import type { Prompter } from "./ui/prompt.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tly-doc-"));
});
afterEach(async () => {
  setColor(false);
  await rm(home, { recursive: true, force: true });
});

const store = (kind: TokenStore["kind"] = "macos-keychain", tok?: string): TokenStore => ({
  kind,
  get: async () => tok,
  set: async () => undefined,
  remove: async () => undefined,
});

const GOOD = "tly_pat_good";
function api(opts: { health?: number; db?: boolean; down?: boolean } = {}): CliIo["fetch"] {
  return async (req) => {
    if (opts.down) throw new Error("connect ECONNREFUSED");
    const u = new URL(req.url);
    if (u.pathname === "/health") {
      const bad = opts.health === 503 || opts.db === false;
      return new Response(JSON.stringify({ status: bad ? "degraded" : "ok", postgres: !bad }), { status: bad ? 503 : 200 });
    }
    if (u.pathname === "/v1/whoami") {
      return req.headers.get("authorization") === `Bearer ${GOOD}`
        ? new Response(JSON.stringify({ type: "human", id: "u", name: "Ada", scopes: [], workspaceSlug: "acme" }))
        : new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "no" } }), { status: 401 });
    }
    return new Response("nope", { status: 404 });
  };
}

function setup(over: Partial<CliIo> = {}, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { HOME: home, TALLYLINE_API_URL: "https://api.example.test", TALLYLINE_WORKSPACE: "acme", TALLYLINE_KEYCHAIN: "off", ...env },
    cwd: home,
    fetch: api(),
    isTTY: false,
    tokens: store("macos-keychain", GOOD),
    ...over,
  };
  return { io, out, err };
}

describe("doctor", () => {
  it("healthy: every check ok, exit 0, plain lines when piped", async () => {
    const { io, out } = setup();
    expect(await run(["doctor"], io)).toBe(0);
    expect(out).toEqual([
      "ok server/server-reachable: api.example.test is up",
      "ok connection/signed-in: signed in as Ada",
      "ok connection/workspace: workspace is acme",
      expect.stringMatching(/^ok computer\/node: Node /),
      "ok computer/keychain: sign-in is kept in your Mac keychain",
    ]);
  });

  it("--json is a stable shape", async () => {
    const { io, out } = setup();
    await run(["doctor", "--json"], io);
    const j = JSON.parse(out.join(""));
    expect(j.ok).toBe(true);
    expect(j.checks[0]).toEqual({ id: "server-reachable", group: "server", status: "ok", message: "api.example.test is up" });
    expect(Object.keys(j)).toEqual(["ok", "fixed", "checks"]);
  });

  it("server down fails with an address hint, exit 1", async () => {
    const { io, out } = setup({ fetch: api({ down: true }) });
    expect(await run(["doctor", "--json"], io)).toBe(1);
    const j = JSON.parse(out.join(""));
    expect(j.checks.find((c: { id: string }) => c.id === "server-reachable")).toMatchObject({ status: "fail", message: "can't reach api.example.test" });
    expect(j.checks.find((c: { id: string }) => c.id === "signed-in").status).toBe("warn");
  });

  it("database down is named as such", async () => {
    const { io, out } = setup({ fetch: api({ db: false }) });
    expect(await run(["doctor", "--json"], io)).toBe(1);
    expect(JSON.parse(out.join("")).checks[0].message).toContain("database isn't responding");
  });

  it("not signed in points at connect", async () => {
    const { io, out } = setup({ tokens: store("macos-keychain") });
    expect(await run(["doctor", "--json"], io)).toBe(1);
    const c = JSON.parse(out.join("")).checks.find((x: { id: string }) => x.id === "signed-in");
    expect(c).toMatchObject({ status: "fail", fix: "tallyline connect" });
  });

  it("a revoked token is a failure with a fix", async () => {
    const { io, out } = setup({ tokens: store("macos-keychain", "tly_pat_old") });
    expect(await run(["doctor", "--json"], io)).toBe(1);
    const c = JSON.parse(out.join("")).checks.find((x: { id: string }) => x.id === "signed-in");
    expect(c.status).toBe("fail");
    expect(c.fix).toBe("tallyline connect");
  });

  it("warns, without failing, when the token comes from the environment or a file", async () => {
    const { io, out } = setup({ tokens: store("file") }, { TALLYLINE_TOKEN: GOOD });
    expect(await run(["doctor", "--json"], io)).toBe(0);
    const ids = JSON.parse(out.join("")).checks.filter((c: { status: string }) => c.status === "warn").map((c: { id: string }) => c.id);
    expect(ids).toEqual(["token-source", "keychain"]);
  });

  it("old Node fails", async () => {
    const { io, out } = setup({}, { TALLYLINE_DOCTOR_NODE: "18.1.0" });
    expect(await run(["doctor", "--json"], io)).toBe(1);
    expect(JSON.parse(out.join("")).checks.find((c: { id: string }) => c.id === "node").status).toBe("fail");
  });

  it("--fix tightens loose files only after confirming", async () => {
    const dir = join(home, ".config", "tallyline");
    await mkdir(dir, { recursive: true });
    const cfg = join(dir, "config.json");
    await writeFile(cfg, "{}");
    await chmod(cfg, 0o644);

    // non-interactive without --yes: refuses
    const a = setup();
    expect(await run(["doctor", "--fix"], a.io)).toBe(2);
    expect((await stat(cfg)).mode & 0o777).toBe(0o644);

    // terminal, answers no
    const asked: string[] = [];
    const no = { confirm: async (o: { message: string }) => (asked.push(o.message), false) } as unknown as Prompter;
    const b = setup({ isTTY: true, prompter: no });
    await run(["doctor", "--fix"], b.io);
    expect(asked[0]).toContain("private to you");
    expect((await stat(cfg)).mode & 0o777).toBe(0o644);

    // --yes
    const c = setup();
    expect(await run(["doctor", "--fix", "--yes"], c.io)).toBe(0);
    expect((await stat(cfg)).mode & 0o777).toBe(0o600);
    expect(c.out.join("\n")).toContain(`fixed ${cfg}`);
  });

  it("on a terminal it groups results and ends with a summary", async () => {
    const { io, out } = setup({ isTTY: true, tokens: store("macos-keychain") });
    expect(await run(["doctor"], io)).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("Your server");
    expect(text).toContain("Your sign-in");
    expect(text).toContain("This computer");
    expect(text).toContain("1 thing needs attention.");
    expect(text).toContain("tallyline connect");
  });

  it("an unreachable fix never leaks the token", async () => {
    const { io, out } = setup({ fetch: api({ down: true }) });
    await run(["doctor"], io);
    expect(out.join("\n")).not.toContain(GOOD);
  });
});
