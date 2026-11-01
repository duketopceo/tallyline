// pnpm lint:design - token-only styling gate (docs/design/silver-lining.md section 13).
//   1. postcss scan of apps/web CSS (raw colours, off-scale font-size). Stylelint was
//      dropped: it pulls braces@3.0.3 (GHSA-vfj7-8cjw-p6xm, no patched release), which
//      fails the dependency-review gate.
//   2. ESLint rules silver-lining/no-raw-color + no-offscale-font + no-palette-color over apps/web component code
// ESLint violations are counted per file against apps/web/lint-design-allowlist.json.
// The allowlist is a ratchet: a file may never exceed its count, and when a file
// drops below it the allowlist must be lowered in the same change.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import postcss from "postcss";
import { ratchetFailures, type Entry } from "./ratchet.ts";

const here = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const repoRoot = resolve(here("."), "../..");
const allowlistPath = resolve(repoRoot, "apps/web/lint-design-allowlist.json");
const update = process.argv.includes("--update-allowlist");

interface Allowlist {
  _comment?: string;
  files: Record<string, Entry>;
}

let failed = false;

// 1. CSS: raw colours and off-scale font-size (postcss; zero tolerance, no allowlist)
const FONT_SCALE = [11, 12, 13, 14, 15, 17, 24];
const cssFiles: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith(".css")) cssFiles.push(full);
  }
};
walk(resolve(repoRoot, "apps/web"));
let cssViolations = 0;
for (const file of cssFiles) {
  const root = postcss.parse(readFileSync(file, "utf8"), { from: file });
  root.walkDecls((decl) => {
    const value = decl.value.replace(/url\([^)]*\)/g, "");
    const rel = relative(repoRoot, file);
    const report = (msg: string) => {
      cssViolations++;
      console.error(`${rel}:${decl.source?.start?.line ?? 0}  ${msg} (${decl.prop}: ${decl.value})`);
    };
    if (/#[0-9a-fA-F]{3,8}\b/.test(value) || /\b(?:rgba?|hsla?)\(/.test(value)) {
      report("raw colour: use a Silver Lining token (var(--sl-*))");
    }
    if (decl.prop === "font-size") {
      const m = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
      if (m && !FONT_SCALE.includes(Number(m[1]))) report("font-size off the type scale");
      else if (/^[\d.]+(rem|em|pt)$/.test(value.trim())) report("font-size must be a scale px or var()");
    }
  });
}
console.log(`css lint: ${cssFiles.length} files, ${cssViolations} violations`);
if (cssViolations > 0) failed = true;

// 2. ESLint design rules
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: here("eslint/design.config.mjs"),
  ignore: false,
});
const results = await eslint.lintFiles([
  "apps/web/app/**/*.{ts,tsx}",
  "apps/web/components/**/*.{ts,tsx}",
  "apps/web/lib/**/*.{ts,tsx}",
]);
const counts = new Map<string, number>();
const lines: string[] = [];
for (const r of results) {
  const rel = relative(repoRoot, r.filePath);
  if (/\.test\.tsx?$/.test(rel)) continue;
  for (const m of r.messages) {
    if (m.fatal) {
      console.error(`${rel}:${m.line} parse error: ${m.message}`);
      failed = true;
      continue;
    }
    counts.set(rel, (counts.get(rel) ?? 0) + 1);
    lines.push(`${rel}:${m.line}:${m.column}  ${m.message}`);
  }
}

const allow: Allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const total = [...counts.values()].reduce((a, b) => a + b, 0);
const allowedTotal = Object.values(allow.files).reduce((a, e) => a + e.count, 0);

if (update) {
  const next: Allowlist = { ...(allow._comment ? { _comment: allow._comment } : {}), files: {} };
  for (const [f, n] of [...counts].sort()) {
    next.files[f] = { count: n, tracking: allow.files[f]?.tracking ?? "U4 migration (frontend polish plan)" };
  }
  writeFileSync(allowlistPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`allowlist rewritten: ${total} violations in ${counts.size} files`);
  process.exit(0);
}

console.log(`\nlint:design violations (${total} total, allowlisted ${allowedTotal}):`);
const byFile = new Map<string, string[]>();
for (const l of lines) {
  const f = l.split(":")[0]!;
  byFile.set(f, [...(byFile.get(f) ?? []), l]);
}
for (const [f, ls] of byFile) {
  const a = allow.files[f]?.count ?? 0;
  console.log(`  ${f}: ${ls.length} (allowed ${a})`);
}
if (process.env.LINT_DESIGN_VERBOSE) for (const l of lines) console.log(`    ${l}`);

for (const f of ratchetFailures(counts, allow.files)) {
  failed = true;
  console.error(f);
  const file = /^FAIL (\S+):/.exec(f)?.[1];
  if (file && (counts.get(file) ?? 0) > (allow.files[file]?.count ?? 0)) {
    for (const l of byFile.get(file) ?? []) console.error(`    ${l}`);
  }
}
console.log(`lint:design ${failed ? "FAILED" : "ok"}: ${total} allowlisted violations remaining`);
process.exit(failed ? 1 : 0);
