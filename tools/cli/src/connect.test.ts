import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./cli.js";
import type { CliIo } from "./commands.js";
import { resolveConfig, saveProfile } from "./config.js";
import { normalizeServer, tokenPageUrl } from "./connect.js";
import { FileStore, openTokenStore, type Runner, type TokenStore } from "./secrets.js";
import { setColor } from "./pretty.js";
import { Cancelled, type Prompter } from "./ui/prompt.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tly-cli-"));
});
afterEach(async () => {
  setColor(false);
  await rm(home, { recursive: true, force: true });
});

class MemoryStore implements TokenStore {
  readonly kind = "file" as const;
  data = new Map<string, string>();
  async get(s: string) { return this.data.get(s.replace(/\/+$/, "")); }
  async set(s: string, t: string) { this.data.set(s.replace(/\/+$/, ""), t); }
  async remove(s: string) { this.data.delete(s.replace(/\/+$/, "")); }
}

const GOOD = "tly_pat_good";
function server(): CliIo["fetch"] {
  return async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/v1/whoami") {
      if (req.headers.get("authorization") !== `Bearer ${GOOD}`)
        return new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "no" } }), { status: 401 });
      return new Response(JSON.stringify({ type: "human", id: "u1", name: "Luke", scopes: ["read", "write"], workspaceSlug: "acme", role: "owner" }), { status: 200 });
    }
    return new Response("<html>not tallyline</html>", { status: 200 });
  };
}

function scripted(answers: unknown[]): Prompter & { log: string[] } {
  const log: string[] = [];
  const next = (): unknown => {
    const a = answers.shift();
    if (a === "CANCEL") throw new Cancelled();
    return a;
  };
  return {
    log,
    intro: (t) => log.push(`intro:${t}`),
    outro: (t) => log.push(`outro:${t}`),
    note: (b, t) => log.push(`note:${t ?? ""}:${b}`),
    step: (k, m) => log.push(`${k}:${m}`),
    text: async () => next() as string,
    secret: async () => next() as string,
    confirm: async () => next() as boolean,
    select: async () => next() as never,
    spin: (m) => ({ update: () => undefined, succeed: (x) => log.push(`ok:${x}`), fail: (x) => log.push(`fail:${x}`), ...(void log.push(`spin:${m}`), {}) }),
  };
}

function ioFor(over: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { HOME: home, TALLYLINE_KEYCHAIN: "off" },
    cwd: home,
    fetch: server(),
    isTTY: false,
    tokens: new MemoryStore(),
    ...over,
  };
  return { io, out, err };
}

describe("addresses", () => {
  it("accepts plain hosts, adds https, keeps local http", () => {
    expect(normalizeServer("acme.tallyline.app")).toBe("https://acme.tallyline.app");
    expect(normalizeServer("localhost:4000/")).toBe("http://localhost:4000");
    expect(normalizeServer("https://x.test/api/")).toBe("https://x.test/api");
    expect(() => normalizeServer("ftp://x")).toThrow();
    expect(() => normalizeServer(" ")).toThrow();
  });
  it("guesses the token page", () => {
    expect(tokenPageUrl("https://api.tallyline.app")).toBe("https://tallyline.app/settings/tokens");
    expect(tokenPageUrl("http://localhost:4000")).toBe("http://localhost:3100/settings/tokens");
    expect(tokenPageUrl("https://tally.example.com")).toBeUndefined();
  });
});

describe("connect in scripts", () => {
  it("reads the token from stdin, saves it to the store, never to config.json", async () => {
    const { io, out } = ioFor({ stdin: async () => `${GOOD}\n` });
    const code = await run(["connect", "--server", "https://api.example.test", "--token-stdin"], io);
    expect(code).toBe(0);
    expect(out.join("")).toContain("connected to https://api.example.test as Luke (acme)");
    expect(await io.tokens!.get("https://api.example.test")).toBe(GOOD);
    const cfg = await readFile(join(home, ".config", "tallyline", "config.json"), "utf8");
    expect(cfg).not.toContain(GOOD);
    expect(JSON.parse(cfg)).toMatchObject({ apiUrl: "https://api.example.test", workspace: "acme" });
    expect((await stat(join(home, ".config", "tallyline", "config.json"))).mode & 0o777).toBe(0o600);
  });
  it("rejects a bad token without saving anything", async () => {
    const { io, err } = ioFor({ stdin: async () => "tly_pat_bad" });
    const code = await run(["connect", "--server", "https://api.example.test", "--token-stdin"], io);
    expect(code).toBe(3);
    expect(err.join("")).toContain("UNAUTHENTICATED");
    expect(await io.tokens!.get("https://api.example.test")).toBeUndefined();
  });
  it("refuses something that is not a Tallyline server", async () => {
    const { io, err } = ioFor({ stdin: async () => GOOD, fetch: async () => new Response("<html/>", { status: 200 }) });
    const code = await run(["connect", "--server", "https://example.org", "--token-stdin"], io);
    expect(code).toBe(1);
    expect(err.join("")).toContain("did not answer like a Tallyline server");
  });
  it("needs a server and a token", async () => {
    const a = ioFor({ stdin: async () => GOOD });
    expect(await run(["connect", "--token-stdin"], a.io)).toBe(2);
    const b = ioFor({ stdin: async () => "" });
    expect(await run(["connect", "--server", "x.test", "--token-stdin"], b.io)).toBe(2);
  });
  it("does not accept the token as an argument", async () => {
    const { io } = ioFor();
    expect(await run(["connect", "--server", "x.test", "--token-stdin", "extra"], { ...io, stdin: async () => GOOD })).toBe(0);
    // a global --token is parsed but connect ignores it: only stdin counts
    const { io: io2 } = ioFor({ stdin: async () => "" });
    expect(await run(["connect", "--server", "x.test", "--token", GOOD], io2)).toBe(2);
  });
});

describe("connect on a terminal", () => {
  it("walks through server, token, check and saves", async () => {
    const p = scripted(["https://api.example.test", GOOD]);
    const { io } = ioFor({ isTTY: true, prompter: p });
    const code = await run(["connect"], io);
    expect(code).toBe(0);
    const log = p.log.join("\n");
    expect(log).toContain("Signed in as Luke (acme)");
    expect(log).toContain("saved in a private file");
    expect(log).toContain("You're connected.");
    expect(await io.tokens!.get("https://api.example.test")).toBe(GOOD);
  });
  it("Esc leaves everything untouched", async () => {
    const p = scripted(["CANCEL"]);
    const { io } = ioFor({ isTTY: true, prompter: p });
    expect(await run(["connect"], io)).toBe(0);
    expect(p.log.join("\n")).toContain("No changes made");
    await expect(stat(join(home, ".config", "tallyline", "config.json"))).rejects.toThrow();
  });
  it("a wrong token ends with a plain-language message", async () => {
    const p = scripted(["https://api.example.test", "tly_pat_nope"]);
    const { io, err } = ioFor({ isTTY: true, prompter: p });
    const code = await run(["connect"], io);
    expect(code).toBe(3);
    expect(err.join("\n")).toContain("didn't accept your sign-in");
  });
});

describe("saved sign-in is used by other commands", () => {
  it("resolveConfig falls back to the store, but env and files win", async () => {
    const store = new MemoryStore();
    await store.set("http://golden.test", "from-store");
    await saveProfile({ HOME: home }, { apiUrl: "http://golden.test", workspace: "acme" });
    const a = await resolveConfig({ env: { HOME: home }, cwd: home, tokens: store });
    expect(a.config.token).toBe("from-store");
    const b = await resolveConfig({ env: { HOME: home, TALLYLINE_TOKEN: "from-env" }, cwd: home, tokens: store });
    expect(b.config.token).toBe("from-env");
  });
  it("saveProfile keeps unknown keys and drops any token", async () => {
    const dir = join(home, ".config", "tallyline");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({ agentId: "claude", custom: 1, token: "old" }));
    await saveProfile({ HOME: home }, { workspace: "acme" });
    const v = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    expect(v).toEqual({ agentId: "claude", custom: 1, workspace: "acme" });
  });
});

describe("status, disconnect, config", () => {
  it("status says who you are, and is machine readable with --json", async () => {
    const { io, out } = ioFor({ env: { HOME: home, TALLYLINE_KEYCHAIN: "off", TALLYLINE_API_URL: "https://api.example.test", TALLYLINE_TOKEN: GOOD, TALLYLINE_WORKSPACE: "acme" } });
    expect(await run(["status"], io)).toBe(0);
    expect(out.join("")).toContain("as Luke");
    const j = ioFor({ env: io.env });
    await run(["status", "--json"], j.io);
    expect(JSON.parse(j.out.join(""))).toMatchObject({ connected: true, user: "Luke", workspace: "acme" });
  });
  it("status when signed out", async () => {
    const { io, out } = ioFor();
    expect(await run(["status"], io)).toBe(0);
    expect(out.join("")).toBe("not connected");
  });
  it("disconnect forgets the token and asks first on a terminal", async () => {
    const store = new MemoryStore();
    await store.set("http://localhost:4000", GOOD);
    const p = scripted([false]);
    const a = ioFor({ isTTY: true, prompter: p, tokens: store });
    await run(["disconnect"], a.io);
    expect(await store.get("http://localhost:4000")).toBe(GOOD);
    const b = ioFor({ tokens: store });
    await run(["disconnect"], b.io);
    expect(await store.get("http://localhost:4000")).toBeUndefined();
  });
  it("config get/set/path", async () => {
    const a = ioFor();
    expect(await run(["config", "set", "workspace", "acme"], a.io)).toBe(0);
    const b = ioFor();
    await run(["config", "get", "workspace"], b.io);
    expect(b.out.join("")).toBe("acme");
    const c = ioFor();
    await run(["config", "path"], c.io);
    expect(c.out.join("")).toBe(join(home, ".config", "tallyline", "config.json"));
    expect(await run(["config", "set", "nope", "x"], ioFor().io)).toBe(2);
  });
  it("config on a terminal edits through prompts", async () => {
    const p = scripted(["workspace", "newspace", "done"]);
    const { io } = ioFor({ isTTY: true, prompter: p });
    await run(["config"], io);
    const v = JSON.parse(await readFile(join(home, ".config", "tallyline", "config.json"), "utf8"));
    expect(v.workspace).toBe("newspace");
  });
});

describe("token stores", () => {
  it("file store is private", async () => {
    const f = new FileStore(join(home, "c", "credentials.json"));
    await f.set("https://a.test/", "t1");
    expect(await f.get("https://a.test")).toBe("t1");
    expect((await stat(join(home, "c", "credentials.json"))).mode & 0o777).toBe(0o600);
    await f.remove("https://a.test");
    expect(await f.get("https://a.test")).toBeUndefined();
  });
  it("macOS keychain gets the token on stdin, never in argv", async () => {
    const calls: { cmd: string; args: string[]; stdin?: string | undefined }[] = [];
    const run: Runner = async (cmd, args, stdin) => {
      calls.push({ cmd, args, stdin });
      return { code: 0, stdout: "" };
    };
    const s = await openTokenStore({ HOME: home }, run, "darwin");
    expect(s.kind).toBe("macos-keychain");
    await s.set("https://a.test", "SECRET-TOKEN");
    const add = calls.find((c) => c.args[0] === "-i")!;
    expect(add.args.join(" ")).not.toContain("SECRET-TOKEN");
    expect(add.stdin).toContain("SECRET-TOKEN");
  });
  it("libsecret gets the token on stdin, never in argv", async () => {
    const calls: { args: string[]; stdin?: string | undefined }[] = [];
    const run: Runner = async (_c, args, stdin) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: "" };
    };
    const s = await openTokenStore({ HOME: home }, run, "linux");
    expect(s.kind).toBe("libsecret");
    await s.set("https://a.test", "SECRET-TOKEN");
    const store = calls.find((c) => c.args[0] === "store")!;
    expect(store.args.join(" ")).not.toContain("SECRET-TOKEN");
    expect(store.stdin).toBe("SECRET-TOKEN");
  });
  it("falls back to a file when there is no keychain tool", async () => {
    const run: Runner = async () => ({ code: 127, stdout: "" });
    expect((await openTokenStore({ HOME: home }, run, "linux")).kind).toBe("file");
    expect((await openTokenStore({ HOME: home, TALLYLINE_KEYCHAIN: "off" }, async () => ({ code: 0, stdout: "" }), "darwin")).kind).toBe("file");
  });
});
