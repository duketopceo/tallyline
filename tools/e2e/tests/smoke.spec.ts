import { expect, test } from "@playwright/test";

const TITLE = `e2e smoke ${Date.now()}`;

test("create issue via quick-create → appears in list → opens detail", async ({
  page,
}) => {
  await page.goto("/issues");
  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();

  // wait for the quick-create listener to mount before pressing keys
  await page.waitForSelector("[data-qc-ready]", { timeout: 15_000 });
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "Quick create issue" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Issue title").fill(TITLE);
  await dialog.getByRole("button", { name: "Create issue" }).click();
  await expect(dialog).not.toBeVisible();

  await page.goto("/triage");
  const row = page.getByRole("link", { name: new RegExp(TITLE) });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/issues\/[A-Z0-9]+-\d+/);
  // first visit compiles /issues/[key] under `next dev`: allow for it
  await expect(
    page.getByRole("heading", { name: TITLE }),
  ).toBeVisible({ timeout: 30_000 });
});
