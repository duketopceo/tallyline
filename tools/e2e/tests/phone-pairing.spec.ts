import { expect, request, test } from "@playwright/test";
import { SAME_ORIGIN } from "./helpers";

test("a signed-in person can create and redeem a phone pairing code", async ({ page }) => {
  await page.goto("/settings/devices");
  await page.getByRole("button", { name: "Create pairing code" }).click();
  const reveal = page.getByRole("status", { name: "pairing code created" });
  await expect(reveal).toBeVisible();
  // the QR carries the same tallyline://pair URL the app's scanner reads
  await expect(page.getByTestId("pairing-qr").locator("svg")).toBeVisible();
  const code = await reveal.getByTestId("secret-value").textContent();
  expect(code).toMatch(/^tlpair_/);

  const web = `http://localhost:${process.env.E2E_WEB_PORT ?? "3110"}`;
  const api = `http://localhost:${process.env.E2E_API_PORT ?? "4100"}`;
  // newContext() inherits the suite's signed-in storageState, so the denial
  // check needs an explicitly empty jar: no session cookie, no minting.
  const anon = await request.newContext({ baseURL: web, storageState: { cookies: [], origins: [] } });
  try {
    const denied = await anon.post("/api/settings/devices/pairing", { headers: SAME_ORIGIN });
    expect(denied.status()).toBe(401);
    const redeemed = await anon.post(`${api}/v1/auth/pair/redeem`, {
      data: { code, deviceName: "Test phone", platform: "ios" },
    });
    expect(redeemed.status()).toBe(200);
    const again = await anon.post(`${api}/v1/auth/pair/redeem`, {
      data: { code, deviceName: "Test phone", platform: "ios" },
    });
    expect(again.status()).toBe(400);
  } finally {
    await anon.dispose();
  }
});
