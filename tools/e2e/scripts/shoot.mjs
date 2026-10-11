// Screenshot every core screen: node shoot.mjs <outDir> [prefix]
// Needs the stack from seed-demo.mjs. Both themes, 1440x900 and 390x844.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3100"}`;
const out = process.argv[2];
const prefix = process.argv[3] ?? "";
mkdirSync(out, { recursive: true });
const EMAIL = process.env.SHOOT_EMAIL ?? "luke@tallyline.test";
const PASSWORD = process.env.SHOOT_PASSWORD ?? "demo-password-4242";
const only = process.env.SHOOT_ONLY?.split(",");

const browser = await chromium.launch();
const ctx0 = await browser.newContext({ baseURL: WEB });
const login = await ctx0.request.post("/api/login", { data: { email: EMAIL, password: PASSWORD } });
if (!login.ok()) throw new Error(`login ${login.status()}`);
const state = await ctx0.storageState();
await ctx0.close();

const screens = [
  ["my-issues", "/my-issues"], ["issues", "/issues"], ["board", "/board"], ["issue", `/issues/${process.env.SHOOT_ISSUE ?? "TLY-37"}`],
  ["triage", "/triage"], ["review", "/review"], ["cycle", "/cycle"], ["roadmap", "/roadmap"],
  ["insights", "/insights"], ["activity", "/activity"],
  ["landing", "/", "out"], ["login", "/login", "out"],
];
const sizes = [["1440", 1440, 900], ["390", 390, 844]];
for (const [name, path, kind] of screens) {
  if (only && !only.includes(name)) continue;
  for (const [sz, w, h] of sizes) {
    for (const theme of ["dark", "light"]) {
      const ctx = await browser.newContext({
        baseURL: WEB, viewport: { width: w, height: h },
        ...(kind === "out" ? {} : { storageState: state }),
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      await page.goto(path, { waitUntil: "networkidle" }).catch(() => {});
      await page.evaluate((t) => {
        document.documentElement.classList.remove("light", "dark");
        document.documentElement.classList.add(t);
      }, theme);
      await page.waitForTimeout(500);
      const full = name === "landing";
      await page.screenshot({ path: `${out}/${prefix}${name}-${sz}-${theme}.png`, fullPage: full });
      await ctx.close();
    }
  }
}
await browser.close();
