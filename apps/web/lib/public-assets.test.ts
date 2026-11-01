import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

// A deleted screenshot once left the login panel with a broken <img>; this
// fails the build when a literal /landing/ or /brand/ reference has no file.
describe("public assets", () => {
  it("every literal /landing/ and /brand/ file reference exists in public/", () => {
    const missing: string[] = [];
    for (const file of [...sources(join(webRoot, "app")), ...sources(join(webRoot, "components"))]) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/["'`](\/(?:landing|brand)\/[\w./-]+\.\w+)["'`]/g)) {
        if (!existsSync(join(webRoot, "public", m[1]!))) missing.push(`${file.slice(webRoot.length + 1)} -> ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
