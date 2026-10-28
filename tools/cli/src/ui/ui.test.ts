import { describe, expect, it } from "vitest";
import { run, VERSION } from "../cli.js";
import type { CliIo } from "../commands.js";
import { commands } from "../commands.js";
import { setColor } from "../pretty.js";
import { friendlyApiError } from "./errors.js";
import { GROUPS } from "./help.js";
import { greeting, renderHome } from "./home.js";
import { ago, clip } from "./render.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

function jsonFetch(routes: Record<string, unknown | (() => Response)>) {
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const key = u.pathname.replace(/^\/v1\/workspaces\/[^/]+/, "") + (u.searchParams.get("state") ? `?state=${u.searchParams.get("state")}` : "");
    const hit = routes[key];
    if (typeof hit === "function") return (hit as () => Response)();
    if (hit === undefined)
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "nope" } }), { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function tty(argv: string[], fetchImpl: CliIo["fetch"], env: CliIo["env"] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { HOME: "/nonexistent-ui-home", TALLYLINE_API_URL: "https://acme.tallyline.test", TALLYLINE_TOKEN: "tly_pat_x", TALLYLINE_WORKSPACE: "acme", NO_COLOR: "1", ...env },
    cwd: "/nonexistent-ui-cwd",
    fetch: fetchImpl,
    isTTY: true,
  });
  setColor(false);
  return { out: strip(out.join("\n")), err: strip(err.join("\n")), code };
}

const issue = (key: string, state: string, title: string, assigneeId: string | null = null) => ({
  id: key, key, number: 1, title, description: null, state, priority: "none", estimate: null, dueDate: null,
  assigneeType: assigneeId ? "agent" : null, assigneeId, creatorType: "human", creatorId: null, teamId: null,
  cycleId: null, projectId: null, parentId: null, source: "api", createdAt: "2026-10-28T00:00:00Z", updatedAt: new Date().toISOString(),
});

describe("home screen", () => {
  it("shows what needs you and what is running", async () => {
    const r = await tty([], jsonFetch({
      "/agents": { agents: [{ id: "a1", name: "claude" }] },
      "/issues?state=in_review": { issues: [issue("ENG-1", "in_review", "x"), issue("ENG-2", "in_review", "y")], nextCursor: null },
      "/issues?state=triage": { issues: [issue("ENG-3", "triage", "z")], nextCursor: null },
      "/issues?state=in_progress": { issues: [issue("ENG-142", "in_progress", "Fix token refresh race", "a1")], nextCursor: null },
    }));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`tallyline  v${VERSION}`);
    expect(r.out).toContain("connected to acme.tallyline.test");
    expect(r.out).toContain("2 issues waiting for your review");
    expect(r.out).toContain("1 new in triage");
    expect(r.out).toMatch(/ENG-142\s+Fix token refresh race\s+claude/);
    expect(r.out).toContain("tallyline ready");
  });
  it("says so when nothing is waiting", async () => {
    const r = await tty([], jsonFetch({
      "/agents": { agents: [] },
      "/issues?state=in_review": { issues: [], nextCursor: null },
      "/issues?state=triage": { issues: [], nextCursor: null },
      "/issues?state=in_progress": { issues: [], nextCursor: null },
    }));
    expect(r.out).toContain("Nothing waiting");
  });
  it("is honest when the server cannot be reached", async () => {
    const r = await tty([], async () => { throw new Error("ECONNREFUSED"); });
    expect(r.code).toBe(0);
    expect(r.out).toContain("not connected");
    expect(r.err).toContain("tallyline doctor");
    expect(r.out).not.toContain("Nothing waiting");
  });
  it("points a new user at connect", async () => {
    const r = await tty([], jsonFetch({}), { TALLYLINE_TOKEN: "", TALLYLINE_WORKSPACE: "" });
    expect(r.out).toContain("tallyline connect");
    expect(r.out).not.toContain("Needs you");
  });
  it("greets by time of day", () => {
    expect(greeting(8)).toBe("Good morning");
    expect(greeting(14)).toBe("Good afternoon");
    expect(greeting(20)).toBe("Good evening");
    expect(renderHome({ version: "1", server: "http://x", workspace: "w", connected: true, inReview: 0, inTriage: 0, working: [] }, 9)).toContain("Good morning");
  });
});

describe("grouped help", () => {
  it("lists every registered command exactly once", () => {
    const listed = GROUPS.flatMap((g) => g.items.map(([n]) => n));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(Object.keys(commands).sort());
  });
  it("shows groups on a terminal and the full text for `help all`", async () => {
    const f = jsonFetch({});
    const pretty = await tty(["help"], f);
    expect(pretty.out).toContain("Find and file");
    const all = await tty(["help", "all"], f);
    expect(all.out).toContain("exit codes:");
  });
});

describe("friendly errors", () => {
  it("replaces CODE: message on a terminal, with a next step and a reference", async () => {
    const r = await tty(["show", "ENG-1"], jsonFetch({}));
    expect(r.code).toBe(4);
    expect(r.err).toContain("Couldn't find that");
    expect(r.err).toContain("TLY-404-NOT_FOUND");
    expect(r.err).not.toMatch(/^NOT_FOUND:/m);
  });
  it("tells a signed-out user to connect instead of naming env vars", async () => {
    const r = await tty(["list"], jsonFetch({}), { TALLYLINE_TOKEN: "" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("not signed in");
    expect(r.err).not.toContain("TALLYLINE_TOKEN");
  });
  it("network failures point at doctor", () => {
    const f = friendlyApiError(0, "NETWORK", "x");
    expect(f.fix).toBe("tallyline doctor");
  });
  it("--json keeps the machine format even on a terminal", async () => {
    const r = await tty(["show", "ENG-1", "--json"], jsonFetch({}));
    expect(r.err).toBe("NOT_FOUND: nope");
  });
});

describe("helpers", () => {
  it("formats ages and clips text", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(ago("2026-10-28T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-10-28T11:40:00Z", now)).toBe("20 min");
    expect(ago("2026-10-28T06:00:00Z", now)).toBe("6 h");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
  });
});
