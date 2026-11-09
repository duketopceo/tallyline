import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

// UX_FIRST budget: initial JS < 200kb gz. Measured from the production
// build's rootMainFiles (shared first-load chunks) — not placeholders.
const NEXT_DIR = path.resolve(import.meta.dirname, "../../../apps/web/.next");
const INITIAL_BUDGET = 200 * 1024;
// Total across every chunk, lazy ones included. 750 = the old 600 plus the landing
// hero's three.js chunk (about 125kb gz, fetched after idle and only on "/", never in
// the app). The initial budget above is unchanged.
const TOTAL_BUDGET = 750 * 1024;

const manifest = JSON.parse(
  readFileSync(path.join(NEXT_DIR, "build-manifest.json"), "utf8"),
);
const roots = manifest.rootMainFiles ?? [];
if (roots.length === 0) {
  throw new Error("no rootMainFiles in build manifest — run pnpm build first");
}

let initial = 0;
for (const f of roots) {
  const p = path.join(NEXT_DIR, f);
  initial += gzipSync(readFileSync(p)).length;
}

let total = 0;
const chunksDir = path.join(NEXT_DIR, "static/chunks");
if (existsSync(chunksDir)) {
  for (const f of await readdir(chunksDir, { recursive: true })) {
    const p = path.join(chunksDir, f.toString());
    if (p.endsWith(".js") && statSync(p).isFile()) {
      total += gzipSync(readFileSync(p)).length;
    }
  }
}

const kb = (n) => (n / 1024).toFixed(1);
console.log(
  `bundle budget: initial=${kb(initial)}kb (limit 200) · all chunks=${kb(total)}kb (limit 750)`,
);
if (initial > INITIAL_BUDGET || total > TOTAL_BUDGET) {
  console.error("BUDGET EXCEEDED");
  process.exit(1);
}
