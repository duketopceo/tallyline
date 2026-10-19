import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, middleware } from "../middleware";

const API_DIR = fileURLToPath(new URL("../app/api", import.meta.url));
const WRITE = /export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|PATCH|DELETE)\b/g;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : /^route\.tsx?$/.test(name) ? [p] : [];
  });
}

const writes = routeFiles(API_DIR).flatMap((file) => {
  const src = readFileSync(file, "utf8");
  const path =
    "/api/" +
    relative(API_DIR, file)
      .split(sep)
      .slice(0, -1)
      .map((s) => s.replace(/^\[.+\]$/, "x"))
      .join("/");
  return [...src.matchAll(WRITE)].map((m) => ({ method: m[1]!, path: path.replace(/\/$/, "") }));
});

const hit = (path: string, method: string, headers: Record<string, string>) =>
  middleware(
    new NextRequest(`https://tallyline.app${path}`, { method, headers: { host: "tallyline.app", ...headers } }),
  );

describe("every web write route is CSRF-guarded", () => {
  it("discovers the write routes (sanity)", () => {
    expect(writes.length).toBeGreaterThan(30);
    expect(writes.map((w) => w.path)).toEqual(
      expect.arrayContaining(["/api/login", "/api/logout", "/api/bootstrap", "/api/issues", "/api/cycles"]),
    );
  });

  it("the middleware matcher covers /api", () => {
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image).*)"]);
  });

  it.each(writes)("$method $path refuses cross-origin and header-less writes", ({ method, path }) => {
    for (const headers of [
      { origin: "https://evil.test" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      {},
    ]) {
      const res = hit(path, method, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.get("x-middleware-next")).toBeNull();
    }
  });

  it.each(writes)("$method $path lets a same-origin browser write through", ({ method, path }) => {
    for (const headers of [{ "sec-fetch-site": "same-origin" }, { origin: "https://tallyline.app" }]) {
      const res = hit(path, method, headers);
      expect(res.status).not.toBe(403);
    }
  });

  it("does not guard reads", () => {
    expect(hit("/api/issues", "GET", { origin: "https://evil.test" }).status).not.toBe(403);
  });
});
