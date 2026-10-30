// pnpm test:token-parity - hash of the generated CSS must equal the checked-in
// CSS and the vendored open-computer copy (docs/design/silver-lining.md section 13/14).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCss, buildSwift } from "../src/emit.ts";

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const here = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const repoRoot = resolve(here("."), "../..");

const generated = sha(buildCss());
const checkedIn = sha(readFileSync(here("silver-lining.css")));
// Default vendored path; open-computer's sync script drops its copy here, or
// point OPEN_COMPUTER_SILVER_LINING_CSS at open-computer's checkout.
const vendoredPath = resolve(
  process.env.OPEN_COMPUTER_SILVER_LINING_CSS ?? `${repoRoot}/vendor/open-computer/silver-lining.css`,
);
const require = process.env.PARITY_REQUIRE_VENDORED === "1";

let failed = false;
console.log(`generated      sha256 ${generated}`);
console.log(`checked-in     sha256 ${checkedIn}`);
if (generated !== checkedIn) {
  console.error("FAIL: packages/silver-lining/silver-lining.css is stale; run `pnpm --filter @tallyline/silver-lining generate`");
  failed = true;
}
const swiftPath = resolve(repoRoot, "apps/ios/Sources/TallylineCore/SilverLiningTokens.generated.swift");
const swiftGenerated = sha(buildSwift());
const swiftCheckedIn = existsSync(swiftPath) ? sha(readFileSync(swiftPath)) : "missing";
console.log(`ios swift      sha256 ${swiftCheckedIn}`);
if (swiftGenerated !== swiftCheckedIn) {
  console.error("FAIL: apps/ios SilverLiningTokens.generated.swift is stale; run `pnpm --filter @tallyline/silver-lining generate`");
  failed = true;
}
if (existsSync(vendoredPath)) {
  const vendored = sha(readFileSync(vendoredPath));
  console.log(`vendored       sha256 ${vendored}  (${vendoredPath})`);
  if (vendored !== generated) {
    console.error("FAIL: open-computer's vendored silver-lining.css differs from Tallyline's build output; re-run the sync script");
    failed = true;
  }
} else if (require) {
  console.error(`FAIL: no vendored copy at ${vendoredPath} (PARITY_REQUIRE_VENDORED=1)`);
  failed = true;
} else {
  console.log(`vendored       none at ${vendoredPath}: open-computer parity NOT checked (set PARITY_REQUIRE_VENDORED=1 to require it)`);
}
process.exit(failed ? 1 : 0);
