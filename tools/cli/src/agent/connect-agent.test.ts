import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../cli.js";
import type { CliIo } from "../commands.js";
import { setColor } from "../pretty.js";
import {
  HARNESSES,
  connectAgent,
  setJsonEntry,
  setTomlTable,
  undoAgent,
} from "./connect-agent.js";

const API = "https://tally.example.test";
const URL_ = `${API}/mcp`;

let home: string;
let proj: string;
let bin: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tly-agent-"));
  proj = join(home, "proj");
  bin = join(home, "bin");
  await mkdir(proj, { recursive: true });
  await mkdir(bin, { recursive: true });
});
afterEach(async () => {
  setColor(false);
  await rm(home, { recursive: true, force: true });
});

async function install(name: string) {
  const p = join(bin, name);
  await writeFile(p, "#!/bin/sh\n");
  await chmod(p, 0o755);
}

const env = () => ({ HOME: home, PATH: bin, TALLYLINE_KEYCHAIN: "off", TALLYLINE_API_URL: API });

function ioFor(over: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: env(),
    cwd: proj,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return new Response(JSON.stringify({ resource: URL_, scopes_supported: ["read", "write"] }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    },
    isTTY: false,
    ...over,
  };
  return { io, out, err };
}

describe("JSON merge", () => {
  it("adds only the tallyline entry and keeps everything else", () => {
    const before = JSON.stringify(
      { theme: "dark", mcpServers: { github: { url: "https://gh.example/mcp", headers: { x: "1" } } }, extra: [1, 2] },
      null,
      4,
    );
    const { text, previous } = setJsonEntry(before, "mcpServers", { url: URL_ });
    const doc = JSON.parse(text);
    expect(previous).toBeUndefined();
    expect(doc.theme).toBe("dark");
    expect(doc.extra).toEqual([1, 2]);
    expect(doc.mcpServers.github).toEqual({ url: "https://gh.example/mcp", headers: { x: "1" } });
    expect(doc.mcpServers.tallyline).toEqual({ url: URL_ });
    expect(text).toContain('\n    "theme"'); // indentation kept
  });

  it("refuses a file with comments instead of rewriting it", () => {
    expect(() => setJsonEntry('{ // mine\n "mcpServers": {} }', "mcpServers", { url: URL_ })).toThrow(/not plain JSON/);
  });

  it("refuses when the servers key is not an object", () => {
    expect(() => setJsonEntry('{"mcp": []}', "mcp", { url: URL_ })).toThrow(/not an object/);
  });
});

describe("TOML table edit", () => {
  const before = [
    "# my codex config",
    'model = "gpt-5"',
    "",
    "[mcp_servers.github]",
    'url = "https://gh.example/mcp" # keep me',
    "",
    "[mcp_servers.tallyline]",
    'url = "https://old.example/mcp"',
    "",
    "[mcp_servers.tallyline.http_headers]",
    'X = "1"',
    "",
    "[profiles.fast]",
    'model = "gpt-5-mini"',
    "",
  ].join("\n");

  it("replaces our table and its sub-tables, leaving the rest byte for byte", () => {
    const { text, previous } = setTomlTable(before, [`url = "${URL_}"`, 'scopes = ["read", "write"]']);
    expect(previous).toContain('url = "https://old.example/mcp"');
    expect(previous).toContain("[mcp_servers.tallyline.http_headers]");
    expect(text).toContain("# my codex config\nmodel = \"gpt-5\"");
    expect(text).toContain('url = "https://gh.example/mcp" # keep me');
    expect(text).toContain("[profiles.fast]\nmodel = \"gpt-5-mini\"");
    expect(text).not.toContain("old.example");
    expect(text).not.toContain("http_headers");
    expect(text.trimEnd().endsWith('scopes = ["read", "write"]')).toBe(true);
    expect(text).not.toMatch(/review/);
  });

  it("matches quoted table names", () => {
    const { previous } = setTomlTable('[mcp_servers."tallyline"]\nurl = "x"\n', undefined);
    expect(previous).toContain('url = "x"');
  });

  it("refuses dotted or inline definitions it can't edit safely", () => {
    expect(() => setTomlTable('mcp_servers.tallyline.url = "x"\n', ["a = 1"])).toThrow(/won't rewrite/);
    expect(() => setTomlTable('[mcp_servers]\ntallyline = { url = "x" }\n', ["a = 1"])).toThrow(/won't rewrite/);
  });
});

describe("connect and undo", () => {
  it("backs up, writes, and undo restores only the old entry", async () => {
    const path = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    const original = JSON.stringify({ mcpServers: { tallyline: { url: "https://old/mcp" }, other: { url: "o" } } }, null, 2);
    await writeFile(path, original);

    const r = await connectAgent({ harness: HARNESSES.cursor, scope: "global", apiUrl: API, env: env(), cwd: proj });
    expect(r.replaced).toBe(true);
    expect(r.backup).toBeDefined();
    expect(await readFile(r.backup!, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.tallyline).toEqual({ url: URL_ });

    // the person adds another server afterwards; undo must keep it
    const now = JSON.parse(await readFile(path, "utf8"));
    now.mcpServers.later = { url: "l" };
    await writeFile(path, JSON.stringify(now, null, 2));

    const u = await undoAgent({ harness: HARNESSES.cursor, env: env() });
    expect(u?.removedFile).toBe(false);
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.mcpServers).toEqual({ tallyline: { url: "https://old/mcp" }, other: { url: "o" }, later: { url: "l" } });
    expect(await undoAgent({ harness: HARNESSES.cursor, env: env() })).toBeUndefined();
  });

  it("removes a file it created when undo leaves it empty", async () => {
    const r = await connectAgent({ harness: HARNESSES.claude, scope: "project", apiUrl: API, env: env(), cwd: proj });
    expect(r.created).toBe(true);
    expect(JSON.parse(await readFile(join(proj, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { tallyline: { type: "http", url: URL_ } },
    });
    const u = await undoAgent({ harness: HARNESSES.claude, env: env() });
    expect(u?.removedFile).toBe(true);
    expect(await readdir(proj)).toEqual([]);
  });

  it("codex: undo puts the old table back", async () => {
    const path = join(home, ".codex", "config.toml");
    await mkdir(join(home, ".codex"));
    await writeFile(path, '[mcp_servers.tallyline]\nurl = "https://old/mcp"\n\n[mcp_servers.gh]\nurl = "g"\n');
    await connectAgent({ harness: HARNESSES.codex, scope: "global", apiUrl: API, env: env(), cwd: proj });
    const mid = await readFile(path, "utf8");
    expect(mid).toContain(`url = "${URL_}"`);
    expect(mid).toContain('[mcp_servers.gh]\nurl = "g"');
    await undoAgent({ harness: HARNESSES.codex, env: env() });
    const after = await readFile(path, "utf8");
    expect(after).toContain('url = "https://old/mcp"');
    expect(after).toContain('[mcp_servers.gh]\nurl = "g"');
    expect(after).not.toContain(URL_);
  });

  it("a second connect with the same address changes nothing", async () => {
    await connectAgent({ harness: HARNESSES.opencode, scope: "global", apiUrl: API, env: env(), cwd: proj });
    const again = await connectAgent({ harness: HARNESSES.opencode, scope: "global", apiUrl: API, env: env(), cwd: proj });
    expect(again.changed).toBe(false);
    const doc = JSON.parse(await readFile(join(home, ".config", "opencode", "opencode.json"), "utf8"));
    expect(doc.mcp.tallyline).toEqual({ type: "remote", url: URL_, enabled: true });
  });
});

describe("tallyline agent", () => {
  it("not installed: plain instructions, nothing written", async () => {
    const { io, out } = ioFor();
    expect(await run(["agent", "connect", "codex"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/isn't on this computer yet/);
    expect(out.join("\n")).toContain("[mcp_servers.tallyline]");
    await expect(readFile(join(home, ".codex", "config.toml"), "utf8")).rejects.toThrow();
  });

  it("installed: writes the entry and says how to sign in", async () => {
    await install("codex");
    const { io, out } = ioFor();
    expect(await run(["agent", "connect", "codex"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/Added tallyline in/);
    expect(text).toContain("codex mcp login tallyline");
    const toml = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toBe(`[mcp_servers.tallyline]\nurl = "${URL_}"\nscopes = ["read", "write"]\n`);
  });

  it("--dry-run shows the file and writes nothing", async () => {
    await install("cursor");
    const { io, out } = ioFor();
    expect(await run(["agent", "connect", "cursor", "--dry-run"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/Would write/);
    await expect(readFile(join(home, ".cursor", "mcp.json"), "utf8")).rejects.toThrow();
  });

  it("--json list reports each agent", async () => {
    await install("opencode");
    const { io, out } = ioFor();
    expect(await run(["agent", "list", "--json"], io)).toBe(0);
    const v = JSON.parse(out.join("\n")) as { server: string; agents: { agent: string; installed: boolean }[] };
    expect(v.server).toBe(URL_);
    expect(v.agents.find((a) => a.agent === "opencode")?.installed).toBe(true);
    expect(v.agents.find((a) => a.agent === "claude")?.installed).toBe(false);
  });

  it("warns when the server doesn't answer, but still writes", async () => {
    await install("claude");
    const { io, err } = ioFor({ fetch: async () => new Response("down", { status: 502 }) });
    expect(await run(["agent", "connect", "claude"], io)).toBe(0);
    expect(err.join("\n")).toMatch(/did not answer as a Tallyline server/);
    expect(JSON.parse(await readFile(join(proj, ".mcp.json"), "utf8")).mcpServers.tallyline.url).toBe(URL_);
  });

  it("unknown agent and missing name are usage errors", async () => {
    const { io } = ioFor();
    expect(await run(["agent", "connect", "vim"], io)).toBe(2);
    expect(await run(["agent", "connect"], io)).toBe(2);
    expect(await run(["agent", "undo"], io)).toBe(2);
  });

  it("asks before writing when someone is at the keyboard", async () => {
    await install("cursor");
    let asked = "";
    const { io, out } = ioFor({
      prompter: {
        intro: () => undefined,
        outro: () => undefined,
        note: () => undefined,
        step: () => undefined,
        text: async () => "",
        secret: async () => "",
        confirm: async (o) => {
          asked = o.message;
          return false;
        },
        select: async () => "cursor" as never,
        spin: () => ({ update: () => undefined, succeed: () => undefined, fail: () => undefined }),
      },
    });
    expect(await run(["agent", "connect", "cursor"], io)).toBe(0);
    expect(asked).toMatch(/backup is kept/);
    expect(out.join("\n")).toMatch(/Nothing was changed/);
    await expect(readFile(join(home, ".cursor", "mcp.json"), "utf8")).rejects.toThrow();
  });
});
