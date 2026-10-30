import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../cli.js";
import type { CliIo } from "../commands.js";
import { setColor } from "../pretty.js";
import type { Prompter } from "../ui/prompt.js";
import { Cancelled } from "../ui/prompt.js";
import { VERSION } from "../version.js";
import { parseEnv } from "./home.js";
import { preflight } from "./preflight.js";
import type { RunResult, Sys } from "./sys.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tly-setup-"));
});
afterEach(async () => {
  setColor(false);
  await rm(home, { recursive: true, force: true });
});

interface Fake {
  sys: Sys;
  calls: string[];
  state: { docker: "ready" | "stopped" | "missing"; usedPorts: Set<number>; failUp: boolean; disk: number; mem: number; brew: boolean };
}

function fakeSys(over: Partial<Fake["state"]> = {}): Fake {
  const state: Fake["state"] = { docker: "ready", usedPorts: new Set(), failUp: false, disk: 50e9, mem: 16e9, brew: false, ...over };
  const calls: string[] = [];
  let n = 0;
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const sys: Sys = {
    platform: "darwin",
    totalMemBytes: () => state.mem,
    freeDiskBytes: async () => state.disk,
    portFree: async (p) => !state.usedPorts.has(p),
    randomHex: (b) => `h${++n}`.padEnd(b * 2, "0").slice(0, b * 2),
    randomBase64: (b) => `b${++n}`.padEnd(b + 12, "x"),
    now: () => Date.parse("2026-10-29T12:00:00Z"),
    async run(cmd, args) {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "brew") return args[0] === "--version" ? (state.brew ? ok() : { code: 127, stdout: "", stderr: "" }) : ok();
      if (cmd === "open") {
        state.docker = "ready";
        return ok();
      }
      if (cmd === "docker") {
        if (args[0] === "--version") return state.docker === "missing" ? { code: 127, stdout: "", stderr: "" } : ok("Docker 29");
        if (args[0] === "info") return state.docker === "ready" ? ok() : { code: 1, stdout: "", stderr: "daemon down" };
        if (args.includes("up") && state.failUp) return { code: 1, stdout: "", stderr: "boom\nPOSTGRES_PASSWORD=leak\nport is already allocated" };
        if (args.includes("up")) return ok();
        if (args.includes("cp")) await writeFile(args.at(-1)!, "dump");
        if (args.includes("pull")) return ok();
      }
      return ok();
    },
  };
  return { sys, calls, state };
}

function scripted(answers: Record<string, string | boolean>): { p: Prompter; seen: string[] } {
  const seen: string[] = [];
  const next = (kind: string, message: string) => {
    seen.push(`${kind}: ${message}`);
    for (const [k, v] of Object.entries(answers)) if (message.includes(k)) return v;
    throw new Cancelled();
  };
  const p: Prompter = {
    intro: () => {},
    outro: () => {},
    note: (b) => void seen.push(`note: ${b}`),
    step: (_k, m) => void seen.push(`step: ${m}`),
    text: async (o) => String(next("text", o.message)),
    secret: async () => "",
    confirm: async (o) => Boolean(next("confirm", o.message)),
    select: async <T extends string>(o: { message: string }) => next("select", o.message) as T,
    spin: () => ({ update() {}, succeed: (m) => void seen.push(`ok: ${m}`), fail: (m) => void seen.push(`fail: ${m}`) }),
  };
  return { p, seen };
}

function io(fake: Fake, extra: Partial<CliIo> = {}): { io: CliIo; out: string[]; err: string[]; fetched: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const fetched: string[] = [];
  return {
    out,
    err,
    fetched,
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: { HOME: home },
      cwd: home,
      fetch: async (req) => {
        fetched.push(req.url);
        return new Response("{}", { status: 200 });
      },
      sleep: async () => {},
      sys: fake.sys,
      openUrl: async (u) => (fetched.push(`open ${u}`), true),
      ...extra,
    },
  };
}

const KEYS_ASK = "How would you like to keep a copy?";

describe("tallyline setup", () => {
  it("installs on a clean machine and prints the address, no secrets", async () => {
    const f = fakeSys();
    const { p } = scripted({ [KEYS_ASK]: "done" });
    const t = io(f, { prompter: p });
    expect(await run(["setup"], t.io)).toBe(0);
    const env = parseEnv(await readFile(join(home, ".tallyline/.env"), "utf8"));
    expect(env.JWT_SECRET).toHaveLength(64);
    expect(env.AUTH_SECRET_KEY!.length).toBeGreaterThanOrEqual(32);
    expect(env.AUTH_SECRET_KEY).not.toBe(env.JWT_SECRET);
    expect(env.TALLYLINE_IMAGE_TAG).toBe(VERSION);
    expect((await stat(join(home, ".tallyline/.env"))).mode & 0o777).toBe(0o600);
    expect(f.calls.some((c) => c.includes("compose -p tallyline") && c.endsWith("up -d"))).toBe(true);
    expect(t.fetched).toContain("http://localhost:4000/health");
    expect(t.fetched).toContain("open http://localhost:3100/bootstrap");
    const shown = t.out.join("\n");
    expect(shown).toContain("http://localhost:3100/bootstrap");
    for (const k of ["POSTGRES_PASSWORD", "JWT_SECRET", "AUTH_SECRET_KEY"]) expect(shown).not.toContain(env[k]);
    const state = JSON.parse(await readFile(join(home, ".tallyline/state.json"), "utf8"));
    expect(state.secretsSavedAt).toBeTruthy();
  });

  it("keeps reminding when the keys are not confirmed", async () => {
    const f = fakeSys();
    const { p } = scripted({ [KEYS_ASK]: "later" });
    const t = io(f, { prompter: p });
    await run(["setup"], t.io);
    expect(t.out.join("\n")).toContain("keys are not saved yet");
    const state = JSON.parse(await readFile(join(home, ".tallyline/state.json"), "utf8"));
    expect(state.secretsSavedAt).toBeUndefined();
  });

  it("the keys screen only shows secrets when asked, and does not accept until confirmed", async () => {
    const f = fakeSys();
    const { p, seen } = scripted({ [KEYS_ASK]: "show", "Have you saved them?": true });
    await run(["setup"], io(f, { prompter: p }).io);
    expect(seen.some((s) => s.startsWith("note: ") && s.includes("JWT_SECRET="))).toBe(true);
  });

  it("stops with a plain message when Docker is missing and does not install silently", async () => {
    const f = fakeSys({ docker: "missing" });
    const t = io(f, { prompter: scripted({}).p });
    const code = await run(["setup"], t.io);
    expect(code).not.toBe(0);
    expect(t.err.join("\n")).toContain("isn't installed");
    expect(f.calls.some((c) => c.startsWith("brew install"))).toBe(false);
  });

  it("offers Homebrew install of Docker and only runs it on yes", async () => {
    const f = fakeSys({ docker: "missing", brew: true });
    const { p } = scripted({ "Install Docker Desktop": true });
    await run(["setup"], io(f, { prompter: p }).io);
    expect(f.calls).toContain("brew install --cask docker");
    const g = fakeSys({ docker: "missing", brew: true });
    await run(["setup"], io(g, { prompter: scripted({ "Install Docker Desktop": false }).p }).io);
    expect(g.calls.some((c) => c.startsWith("brew install"))).toBe(false);
  });

  it("starts Docker Desktop for you when it is installed but stopped", async () => {
    const f = fakeSys({ docker: "stopped" });
    const { p } = scripted({ "Start Docker Desktop": true, [KEYS_ASK]: "done" });
    expect(await run(["setup"], io(f, { prompter: p }).io)).toBe(0);
    expect(f.calls).toContain("open -a Docker");
  });

  it("explains a busy port and offers the flag", async () => {
    const f = fakeSys({ usedPorts: new Set([3100]) });
    const t = io(f, { prompter: scripted({}).p });
    expect(await run(["setup"], t.io)).not.toBe(0);
    expect(t.err.join("\n")).toContain("changing anything");
    const pre = await preflight({ sys: f.sys, dir: home, webPort: 3100, apiPort: 4000, portsOwned: false });
    expect(pre.checks.find((c) => c.id === "web-port")?.fix).toContain("--port 3101");
  });

  it("refuses low disk before touching anything", async () => {
    const f = fakeSys({ disk: 1e9 });
    const t = io(f, { prompter: scripted({}).p });
    expect(await run(["setup"], t.io)).not.toBe(0);
    await expect(stat(join(home, ".tallyline"))).rejects.toThrow();
  });

  it("a failed start leaves the folder, hides secrets in the error, and a second run reuses the keys", async () => {
    const f = fakeSys({ failUp: true });
    const t = io(f, { prompter: scripted({}).p });
    expect(await run(["setup"], t.io)).not.toBe(0);
    expect(t.err.join("\n")).toContain("port is already allocated");
    expect(t.err.join("\n")).not.toContain("leak");
    const first = await readFile(join(home, ".tallyline/.env"), "utf8");
    f.state.failUp = false;
    // existing install detected on the second run: choose repair
    const { p } = scripted({ "already set up": "repair", [KEYS_ASK]: "done" });
    expect(await run(["setup"], io(f, { prompter: p }).io)).toBe(0);
    expect(await readFile(join(home, ".tallyline/.env"), "utf8")).toBe(first);
  });

  it("an existing install is never reinstalled: no volume removal is ever issued", async () => {
    const f = fakeSys();
    await run(["setup"], io(f, { prompter: scripted({ [KEYS_ASK]: "done" }).p }).io);
    await run(["setup"], io(f, { prompter: scripted({ "already set up": "repair" }).p }).io);
    expect(f.calls.some((c) => /\bdown\b|-v\b|volume rm|prune/.test(c))).toBe(false);
  });

  it("needs a terminal unless --yes", async () => {
    const f = fakeSys();
    expect(await run(["setup"], io(f).io)).toBe(2);
    expect(await run(["setup", "--yes", "--no-open"], io(f).io)).toBe(0);
  });
});

describe("server care commands", () => {
  async function installed(f: Fake) {
    await run(["setup", "--yes", "--no-open"], io(f).io);
  }

  it("stop pauses without removing anything; resume brings it back", async () => {
    const f = fakeSys();
    await installed(f);
    const t = io(f);
    expect(await run(["stop"], t.io)).toBe(0);
    expect(f.calls.at(-1)).toMatch(/compose .* stop$/);
    expect(await run(["resume"], t.io)).toBe(0);
  });

  it("commands say what to do when nothing is installed", async () => {
    const f = fakeSys();
    const t = io(f);
    expect(await run(["backup"], t.io)).not.toBe(0);
    expect(t.err.join("\n")).toContain("tallyline setup");
  });

  it("backup dumps, copies out, writes the marker, keeps seven", async () => {
    const f = fakeSys();
    await installed(f);
    const t = io(f);
    expect(await run(["backup"], t.io)).toBe(0);
    expect(f.calls.some((c) => c.includes("pg_dump -U postgres -Fc tallyline"))).toBe(true);
    expect(f.calls.some((c) => / cp postgres:\/tmp\/tallyline-.*\.dump /.test(c))).toBe(true);
    expect((await stat(join(home, ".tallyline/backups/.last-backup"))).isFile()).toBe(true);
    expect(t.out.join("\n")).toContain("keys");
    // keep-seven pruning
    for (let i = 1; i <= 9; i++) {
      const name = join(home, `.tallyline/backups/tallyline-2020010${i}T000000Z.dump`);
      await writeFile(name, "x");
      await utimes(name, new Date(), new Date());
    }
    await run(["backup"], io(f).io);
    const left = (await readdir(join(home, ".tallyline/backups"))).filter((n) => n.endsWith(".dump"));
    expect(left).toHaveLength(7);
  });

  it("update backs up, pins the new tag, and records the old one", async () => {
    const f = fakeSys();
    await installed(f);
    expect(await run(["update", "--to", "9.9.9", "--yes"], io(f).io)).toBe(0);
    const env = parseEnv(await readFile(join(home, ".tallyline/.env"), "utf8"));
    expect(env.TALLYLINE_IMAGE_TAG).toBe("9.9.9");
    const st = JSON.parse(await readFile(join(home, ".tallyline/state.json"), "utf8"));
    expect(st.previousVersion).toBe(VERSION);
    const bi = f.calls.findIndex((c) => c.includes("pg_dump"));
    const pi = f.calls.findIndex((c) => c.endsWith(" pull"));
    expect(bi).toBeGreaterThan(-1);
    expect(pi).toBeGreaterThan(bi);
  });

  it("a failed update rolls back to the old tag with a plain message", async () => {
    const f = fakeSys();
    await installed(f);
    const failing: Sys = {
      ...f.sys,
      async run(cmd, args, o) {
        if (cmd === "docker" && args.includes("pull")) return { code: 1, stdout: "", stderr: "manifest unknown" };
        return f.sys.run(cmd, args, o);
      },
    };
    const t = io({ ...f, sys: failing });
    expect(await run(["update", "--to", "9.9.9", "--yes"], t.io)).not.toBe(0);
    expect(t.err.join("\n")).toContain(`Went back to version ${VERSION}`);
    const env = parseEnv(await readFile(join(home, ".tallyline/.env"), "utf8"));
    expect(env.TALLYLINE_IMAGE_TAG).toBe(VERSION);
  });

  it("update to the same version does nothing", async () => {
    const f = fakeSys();
    await installed(f);
    const t = io(f);
    expect(await run(["update", "--yes"], t.io)).toBe(0);
    expect(t.out.join("\n")).toContain("Already on version");
  });
});
