// Roadmap screenshots: node shoot-roadmap.mjs <outDir> [prefix]
// Needs a stack seeded by seed-push.mjs. Dark and light, desktop and phone.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3100"}`;
const out = process.argv[2];
const prefix = process.argv[3] ?? "";
mkdirSync(out, { recursive: true });
const EMAIL = process.env.SHOOT_EMAIL ?? "demo@tallyline.test";
const PASSWORD = process.env.SHOOT_PASSWORD ?? "demo-password-4242";

const browser = await chromium.launch();
const ctx0 = await browser.newContext({ baseURL: WEB });
const login = await ctx0.request.post("/api/login", { headers: { "sec-fetch-site": "same-origin" }, data: { email: EMAIL, password: PASSWORD } });
if (!login.ok()) throw new Error(`login ${login.status()}`);
const state = await ctx0.storageState();
await ctx0.close();

const screens = [
  ["roadmap", "/roadmap"],
  ["push", "/roadmap?push=1"],
];
const sizes = [["1440", 1440, 900], ["390", 390, 844]];
for (const [name, path] of screens) {
  for (const [sz, w, h] of sizes) {
    for (const theme of ["dark", "light"]) {
      const ctx = await browser.newContext({ baseURL: WEB, viewport: { width: w, height: h }, storageState: state, colorScheme: theme });
      const page = await ctx.newPage();
      await page.goto(path, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForLoadState("load").catch(() => {});
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      // let the stream open and the rings settle
      await page.locator('[data-live="live"]').first().waitFor({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${out}/${prefix}${name}-${sz}-${theme}.png` });
      await ctx.close();
    }
  }
}
await browser.close();
