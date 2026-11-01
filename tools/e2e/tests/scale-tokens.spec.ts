import { expect, test } from "@playwright/test";

// U3: the radius and type scales in apps/web/app/globals.css resolve to the DESIGN.md values.
// Only classes already used by the app are compiled, so probes cover those (xl has no user yet).
test("radius and type tokens resolve to the DESIGN.md scale", async ({ page }) => {
  await page.goto("/my-issues");
  await page.waitForSelector("[data-qc-ready]", { timeout: 20_000 });
  const probed = await page.evaluate(() => {
    const out: Record<string, string> = {};
    const probe = (cls: string, prop: "borderTopLeftRadius" | "fontSize") => {
      const el = document.createElement("div");
      el.className = cls;
      document.body.appendChild(el);
      out[cls] = getComputedStyle(el)[prop];
      el.remove();
    };
    for (const c of ["rounded-xs", "rounded-sm", "rounded-md", "rounded-lg"]) probe(c, "borderTopLeftRadius");
    for (const c of ["text-xs", "text-sm"]) probe(c, "fontSize");
    return out;
  });
  expect(probed).toMatchObject({
    "rounded-xs": "4px",
    "rounded-sm": "6px",
    "rounded-md": "8px",
    "rounded-lg": "10px",
    "text-xs": "12px",
    "text-sm": "14px",
  });
});
