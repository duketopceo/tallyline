import { describe, expect, it } from "vitest";
import { latestVersion, sendIssuePatch } from "./write-contract";

const reply = (status: number, body: unknown): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
const calls: RequestInit[] = [];

describe("sendIssuePatch", () => {
  it("sends If-Match only when it knows the version", async () => {
    calls.length = 0;
    await sendIssuePatch("ENG-1", { title: "a" }, 4, reply(200, { version: 5 }));
    await sendIssuePatch("ENG-1", { title: "a" }, undefined, reply(200, { version: 5 }));
    expect((calls[0]!.headers as Record<string, string>)["if-match"]).toBe("4");
    expect((calls[1]!.headers as Record<string, string>)["if-match"]).toBeUndefined();
  });

  it("returns the new version on success", async () => {
    expect(await sendIssuePatch("ENG-1", {}, 4, reply(200, { version: 5 }))).toEqual({ kind: "ok", version: 5 });
    expect(await sendIssuePatch("ENG-1", {}, undefined, reply(200, {}))).toEqual({ kind: "ok", version: null });
  });

  it("reads STALE_WRITE as a conflict with the server's version, not an error", async () => {
    const r = await sendIssuePatch("ENG-1", {}, 3, reply(409, { error: { code: "STALE_WRITE", message: "changed" }, issue: { version: 7 } }));
    expect(r).toEqual({ kind: "stale", version: 7, message: "changed" });
  });

  it("any other 409 is a plain error", async () => {
    const r = await sendIssuePatch("ENG-1", {}, 3, reply(409, { error: { code: "INVALID_TRANSITION", message: "no" } }));
    expect(r).toEqual({ kind: "error", message: "no" });
  });

  it("maps a network failure to an error", async () => {
    const r = await sendIssuePatch("ENG-1", {}, 3, (async () => { throw new Error("down"); }) as typeof fetch);
    expect(r).toEqual({ kind: "error", message: "network unreachable" });
  });
});

describe("latestVersion", () => {
  it("prefers the newer known version", () => {
    expect(latestVersion(3, 5)).toBe(5);
    expect(latestVersion(undefined, 5)).toBe(5);
    expect(latestVersion(3, undefined)).toBe(3);
    expect(latestVersion(undefined, undefined)).toBeUndefined();
  });
});
