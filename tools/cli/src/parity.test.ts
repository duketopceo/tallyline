import { describe, expect, it } from "vitest";
import { run } from "./cli.js";
import type { CliIo } from "./commands.js";

// move-team and link against an HTTP stub (no database, no live calls).

const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";
const baseIssue = {
  id: "i1",
  key: "ENG-7",
  number: 7,
  title: "t",
  teamId: TEAM_A,
  updatedAt: "2026-11-05T10:00:00.000Z",
  version: 4,
  children: [],
  labels: [],
};

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

function harness(opts: { url?: string | null; patch?: () => Response; issue?: Record<string, unknown> } = {}) {
  const seen: Seen[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch: CliIo["fetch"] = async (req) => {
    const u = new URL(req.url);
    const text = await req.text();
    seen.push({ method: req.method, path: u.pathname, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    if (u.pathname.endsWith("/teams")) {
      return Response.json({
        teams: [
          { id: TEAM_A, key: "ENG", name: "Engineering" },
          { id: TEAM_B, key: "OPS", name: "Operations" },
        ],
      });
    }
    if (req.method === "PATCH") {
      return opts.patch ? opts.patch() : Response.json({ ...baseIssue, key: "OPS-3", teamId: TEAM_B });
    }
    if (opts.issue) return Response.json(opts.issue);
    return Response.json(opts.url === null ? baseIssue : { ...baseIssue, url: opts.url ?? "https://app.example.test/issues/ENG-7" });
  };
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { TALLYLINE_API_URL: "https://api.example.test", TALLYLINE_WORKSPACE: "acme", TALLYLINE_TOKEN: "tly_pat_x", TALLYLINE_KEYCHAIN: "off", HOME: "/nonexistent-home" },
    cwd: "/nonexistent-cwd",
    fetch,
    isTTY: false,
  };
  return { io, out, err, seen };
}

describe("tallyline move-team", () => {
  it("resolves the team, patches teamId with write headers, prints the new key", async () => {
    const h = harness();
    expect(await run(["move-team", "eng-7", "ops"], h.io)).toBe(0);
    expect(h.out).toEqual(["OPS-3"]);
    const patch = h.seen.find((s) => s.method === "PATCH");
    expect(patch?.path).toBe("/v1/workspaces/acme/issues/ENG-7");
    expect(patch?.body).toEqual({ teamId: TEAM_B });
    expect(patch?.headers.get("idempotency-key")).toMatch(/^cli-[0-9a-f-]{36}$/);
    expect(patch?.headers.get("if-match")).toBe("4");
  });

  it("sends no If-Match when the server has no issue version", async () => {
    const { version: _v, ...unversioned } = baseIssue;
    const h = harness({ issue: unversioned });
    expect(await run(["move-team", "ENG-7", "OPS"], h.io)).toBe(0);
    expect(h.seen.find((s) => s.method === "PATCH")?.headers.get("if-match")).toBeNull();
  });

  it("matches a team by name", async () => {
    const h = harness();
    expect(await run(["move-team", "ENG-7", "Operations"], h.io)).toBe(0);
    expect(h.seen.find((s) => s.method === "PATCH")?.body).toEqual({ teamId: TEAM_B });
  });

  it("unknown team exits 4 and lists the keys", async () => {
    const h = harness();
    expect(await run(["move-team", "ENG-7", "nope"], h.io)).toBe(4);
    expect(h.err.join("\n")).toContain("ENG, OPS");
  });

  it("already on that team is a no-op that prints the key", async () => {
    const h = harness();
    expect(await run(["move-team", "ENG-7", "ENG"], h.io)).toBe(0);
    expect(h.out).toEqual(["ENG-7"]);
    expect(h.seen.some((s) => s.method === "PATCH")).toBe(false);
  });

  it("--json prints the issue as one JSON document", async () => {
    const h = harness();
    expect(await run(["move-team", "ENG-7", "OPS", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ key: "OPS-3", teamId: TEAM_B });
  });

  const stale = () =>
    Response.json(
      { error: { code: "STALE_WRITE", message: "changed" }, issue: { ...baseIssue, teamId: TEAM_B, version: 5 } },
      { status: 409 },
    );

  it("STALE_WRITE exits 6 and prints the server's current value", async () => {
    const h = harness({ patch: stale });
    expect(await run(["move-team", "ENG-7", "OPS"], h.io)).toBe(6);
    expect(h.err.join("\n")).toContain("STALE_WRITE");
    expect(h.err.join("\n")).toContain(TEAM_B);
  });

  it("STALE_WRITE with --json keeps stdout machine-readable", async () => {
    const h = harness({ patch: stale });
    expect(await run(["move-team", "ENG-7", "OPS", "--json"], h.io)).toBe(6);
    const j = JSON.parse(h.out.join(""));
    expect(j.error.code).toBe("STALE_WRITE");
    expect(j.current.teamId).toBe(TEAM_B);
  });

  it("other 409s keep the generic conflict exit code 5", async () => {
    const h = harness({ patch: () => Response.json({ error: { code: "IDEMPOTENCY_IN_FLIGHT", message: "wait" } }, { status: 409 }) });
    expect(await run(["move-team", "ENG-7", "OPS"], h.io)).toBe(5);
  });
});

describe("tallyline link", () => {
  it("prints exactly the url field", async () => {
    const h = harness();
    expect(await run(["link", "ENG-7"], h.io)).toBe(0);
    expect(h.out).toEqual(["https://app.example.test/issues/ENG-7"]);
  });

  it("--json carries key and url", async () => {
    const h = harness();
    expect(await run(["link", "ENG-7", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({ key: "ENG-7", url: "https://app.example.test/issues/ENG-7" });
  });

  it("a server without url exits non-zero with a clear message", async () => {
    const h = harness({ url: null });
    expect(await run(["link", "ENG-7"], h.io)).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("did not return a link");
  });
});
