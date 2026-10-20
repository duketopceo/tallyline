// Product screenshots for the landing page: node landing-shots.mjs <outDir>
// Real captures of the seeded demo workspace (seed-demo.mjs), dark and light.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3100"}`;
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const c0 = await browser.newContext({ baseURL: WEB });
const login = await c0.request.post("/api/login", { data: { email: "luke@tallyline.test", password: "demo-password-4242" } });
if (!login.ok()) throw new Error("login failed");
const state = await c0.storageState();
await c0.close();

const shots = [
  ["issue", `/issues/${process.env.SHOOT_ISSUE ?? "TLY-37"}`, async (p) => { await p.waitForSelector("#sessions"); }],
  ["review", "/review", async (p) => { await p.waitForSelector('[aria-label="Evidence"]'); await p.waitForTimeout(800); }],
  ["list", "/issues?group=state", async (p) => { await p.locator("[data-issue-row]:visible").nth(2).hover(); await p.keyboard.press("Space"); await p.waitForSelector('[aria-label^="Peek"]'); await p.waitForTimeout(800); }],
];
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 }, storageState: state, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const [name, path, prep] of shots) {
    await page.goto(path, { waitUntil: "load" });
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.waitForSelector("[data-qc-ready]", { timeout: 90000 });
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await prep(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${name}-${theme}.png` });
  }
  await ctx.close();
}
await browser.close();
