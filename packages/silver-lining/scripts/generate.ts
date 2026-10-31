// Writes the checked-in outputs: silver-lining.css, tokens.json, src/tokens.generated.ts
// and the iOS token table in apps/ios.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCss, buildJson, buildSwift, buildTs } from "../src/emit.ts";

export const SWIFT_OUT = "../../apps/ios/Sources/TallylineCore/SilverLiningTokens.generated.swift";
const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
writeFileSync(root("silver-lining.css"), buildCss());
writeFileSync(root("tokens.json"), buildJson());
writeFileSync(root("src/tokens.generated.ts"), buildTs());
writeFileSync(root(SWIFT_OUT), buildSwift());
console.log("silver-lining: wrote silver-lining.css, tokens.json, src/tokens.generated.ts, SilverLiningTokens.generated.swift");
