import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./cli.js";
import type { CliIo } from "./commands.js";
import { isOpenableUrl, startDevice, waitForDeviceToken } from "./device.js";
import { setColor } from "./pretty.js";
import type { TokenStore } from "./secrets.js";
import { Cancelled, type Prompter } from "./ui/prompt.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tly-dev-"));
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

const TOKEN = "tly_pat_from_browser";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Fake {
  fetch: CliIo["fetch"];
  polls: number;
  startBody: unknown;
  /** answers for successive /device/token calls; the last one repeats */
  answers: Response[];
  noDevice?: boolean;
}
function fake(answers: Response[], over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    polls: 0,
    startBody: undefined,
    answers,
    ...over,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/v1/auth/device/code") {
        if (f.noDevice) return json(404, { error: { code: "NOT_FOUND", message: "no" } });
        f.startBody = await req.json();
        return json(200, {
          device_code: "d".repeat(40),
          user_code: "BCDF-GHJK",
          verification_uri: "https://app.example.test/device",
          verification_uri_complete: "https://app.example.test/device?code=BCDF-GHJK",
          expires_in: 600,
          interval: 5,
        });
      }
      if (u.pathname === "/v1/auth/device/token") {
        const body = (await req.json()) as { deviceCode: string };
        expect(body.deviceCode).toBe("d".repeat(40));
        const a = f.answers[Math.min(f.polls, f.answers.length - 1)]!;
        f.polls++;
        return a.clone();
      }
      if (u.pathname === "/v1/whoami") {
        return req.headers.get("authorization") === `Bearer ${TOKEN}`
          ? json(200, { type: "human", id: "u1", name: "Luke", scopes: ["read", "write"], workspaceSlug: "acme", role: "owner" })
          : json(401, { error: { code: "UNAUTHENTICATED", message: "no" } });
      }
      return new Response("<html/>", { status: 200 });
    },
  };
  return f;
}
const pending = () => json(400, { error: "authorization_pending" });
const approved = () => json(200, { access_token: TOKEN, token_type: "Bearer", scope: "read write" });

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
    spin: (m) => {
      log.push(`spin:${m}`);
      return { update: () => undefined, succeed: (x) => log.push(`ok:${x}`), fail: (x) => log.push(`fail:${x}`) };
    },
  };
}

function ioFor(f: Fake, over: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { HOME: home, TALLYLINE_KEYCHAIN: "off" },
    cwd: home,
    fetch: f.fetch,
    isTTY: false,
    tokens: new MemoryStore(),
    sleep: async (ms) => void sleeps.push(ms),
    openUrl: async (u) => (opened.push(u), true),
    hostname: "kate-mbp",
    ...over,
  };
  return { io, out, err, sleeps, opened };
}

describe("device flow client", () => {
  it("only opens web addresses", () => {
    expect(isOpenableUrl("https://x.test/device")).toBe(true);
    expect(isOpenableUrl("http://localhost:3100/device")).toBe(true);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "app.tallyline.ios:/x", "not a url", ""]) {
      expect(isOpenableUrl(bad)).toBe(false);
    }
  });
  it("refuses a server that answers with a non-web verification address", async () => {
    const f = async () => json(200, { device_code: "x".repeat(20), user_code: "A", verification_uri: "file:///etc/passwd", expires_in: 1, interval: 1 });
    await expect(startDevice("https://s.test", "cli", f)).rejects.toThrow(/not a web address/);
  });
  it("waits through pending and slow_down, growing the interval", async () => {
    const f = fake([pending(), json(400, { error: "slow_down", interval: 10 }), pending(), approved()]);
    const sleeps: number[] = [];
    const start = await startDevice("https://s.test", "cli", f.fetch);
    const token = await waitForDeviceToken({ server: "https://s.test", start, fetch: f.fetch, sleep: async (ms) => void sleeps.push(ms) });
    expect(token).toBe(TOKEN);
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
  });
  it("turns denial and expiry into plain messages", async () => {
    for (const [answer, msg] of [
      [json(400, { error: "access_denied" }), /chose Deny/],
      [json(400, { error: "expired_token" }), /expired/],
      [json(500, { error: { code: "X", message: "boom" } }), /stopped unexpectedly/],
    ] as const) {
      const f = fake([answer]);
      const start = await startDevice("https://s.test", "cli", f.fetch);
      await expect(waitForDeviceToken({ server: "https://s.test", start, fetch: f.fetch, sleep: async () => undefined })).rejects.toThrow(msg);
    }
  });
  it("gives up when the code's lifetime has passed even if the server keeps saying pending", async () => {
    const f = fake([pending()]);
    const start = await startDevice("https://s.test", "cli", f.fetch);
    await expect(waitForDeviceToken({ server: "https://s.test", start, fetch: f.fetch, sleep: async () => undefined })).rejects.toThrow(/expired/);
    expect(f.polls).toBeLessThan(200);
  });
});

describe("connect --browser", () => {
  it("shows the code on stderr, saves the token, keeps stdout to the result", async () => {
    const f = fake([pending(), approved()]);
    const { io, out, err, opened } = ioFor(f);
    const code = await run(["connect", "--browser", "--server", "https://api.example.test"], io);
    expect(code).toBe(0);
    expect(err.join("\n")).toContain("BCDF-GHJK");
    expect(err.join("\n")).toContain("https://app.example.test/device");
    expect(opened).toEqual(["https://app.example.test/device?code=BCDF-GHJK"]);
    expect(out.join("")).toContain("connected to https://api.example.test as Luke (acme)");
    expect(out.join("")).not.toContain(TOKEN);
    expect(err.join("")).not.toContain(TOKEN);
    expect(await io.tokens!.get("https://api.example.test")).toBe(TOKEN);
    expect((f.startBody as { clientName: string }).clientName).toBe("Tallyline CLI on kate-mbp");
    const cfg = await readFile(join(home, ".config", "tallyline", "config.json"), "utf8");
    expect(cfg).not.toContain(TOKEN);
    expect((await stat(join(home, ".config", "tallyline", "config.json"))).mode & 0o777).toBe(0o600);
  });
  it("--json prints one machine-readable line and no token", async () => {
    const f = fake([approved()]);
    const { io, out } = ioFor(f);
    expect(await run(["connect", "--browser", "--json", "--server", "https://api.example.test"], io)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ server: "https://api.example.test", workspace: "acme", user: "Luke" });
    expect(out.join("")).not.toContain(TOKEN);
  });
  it("denied in the browser: exit 1, nothing saved", async () => {
    const f = fake([json(400, { error: "access_denied" })]);
    const { io, err } = ioFor(f);
    expect(await run(["connect", "--browser", "--server", "https://api.example.test"], io)).toBe(1);
    expect(err.join("\n")).toContain("chose Deny");
    expect(await io.tokens!.get("https://api.example.test")).toBeUndefined();
  });
  it("an older server without browser sign-in points at the token path", async () => {
    const f = fake([], { noDevice: true });
    const { io, err } = ioFor(f);
    expect(await run(["connect", "--browser", "--server", "https://api.example.test"], io)).toBe(1);
    expect(err.join("\n")).toContain("--token-stdin");
  });
  it("works when no browser can be opened", async () => {
    const f = fake([approved()]);
    const { io, err } = ioFor(f, { openUrl: async () => false });
    expect(await run(["connect", "--browser", "--server", "https://api.example.test"], io)).toBe(0);
    expect(err.join("\n")).toContain("Open this page in your browser");
  });
});

describe("connect on a terminal", () => {
  it("defaults to the browser and never asks for a token", async () => {
    const f = fake([pending(), approved()]);
    const p = scripted(["https://api.example.test", "browser"]);
    const { io, opened } = ioFor(f, { isTTY: true, prompter: p });
    expect(await run(["connect"], io)).toBe(0);
    const log = p.log.join("\n");
    expect(log).toContain("BCDF-GHJK");
    expect(log).toContain("Approved in the browser");
    expect(log).toContain("Signed in as Luke (acme)");
    expect(log).not.toContain("Paste your token");
    expect(opened).toHaveLength(1);
    expect(await io.tokens!.get("https://api.example.test")).toBe(TOKEN);
  });
  it("falls back to pasting when the server has no browser sign-in", async () => {
    const f = fake([], { noDevice: true });
    const p = scripted(["https://api.example.test", "browser", TOKEN]);
    const { io } = ioFor(f, { isTTY: true, prompter: p });
    expect(await run(["connect"], io)).toBe(0);
    expect(p.log.join("\n")).toContain("Let's use a token instead");
    expect(await io.tokens!.get("https://api.example.test")).toBe(TOKEN);
  });
  it("--paste skips the choice", async () => {
    const f = fake([]);
    const p = scripted(["https://api.example.test", TOKEN]);
    const { io } = ioFor(f, { isTTY: true, prompter: p });
    expect(await run(["connect", "--paste"], io)).toBe(0);
    expect(f.polls).toBe(0);
  });
  it("Esc while choosing leaves everything untouched", async () => {
    const f = fake([]);
    const p = scripted(["https://api.example.test", "CANCEL"]);
    const { io } = ioFor(f, { isTTY: true, prompter: p });
    expect(await run(["connect"], io)).toBe(0);
    expect(p.log.join("\n")).toContain("No changes made");
    expect(await io.tokens!.get("https://api.example.test")).toBeUndefined();
  });
});
