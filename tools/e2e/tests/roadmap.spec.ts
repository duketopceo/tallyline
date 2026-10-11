import { expect, test } from "@playwright/test";

const NAME = `e2e roadmap ${Date.now()}`;

test("roadmap: g p navigates, project form creates a span, j/k + enter work", async ({
  page,
}) => {
  // g-sequence lands on the roadmap
  await page.goto("/issues");
  await page.waitForSelector("[data-qc-ready]", { timeout: 15_000 });
  await page.keyboard.press("g");
  await page.keyboard.press("p");
  await expect(page).toHaveURL(/\/roadmap$/);
  await expect(
    page.getByRole("heading", { name: "Roadmap" }),
  ).toBeVisible();

  // create a dated project through the bottom form → row + bar span render
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("/api/projects"),
    { timeout: 10_000 },
  );
  await page.getByPlaceholder("project name").fill(NAME);
  await page.getByLabel("target date (optional)").fill("2026-12-31");
  await page.getByRole("button", { name: "New project" }).click();
  await created;

  const row = page.getByRole("button", { name: new RegExp(NAME) });
  await expect(row).toBeVisible();
  await expect(row.locator('[data-span="project"]')).toBeVisible();

  // j/k moves the cursor across rows (project rows precede cycle rows)
  const rowCount = await page.locator("[data-index]").count();
  expect(rowCount).toBeGreaterThanOrEqual(1);
  if (rowCount > 1) {
    await page.keyboard.press("j");
    await expect(page.locator('[data-index="1"]')).toHaveClass(/bg-surface-2/);
    await page.keyboard.press("k");
    await expect(page.locator('[data-index="0"]')).toHaveClass(/bg-surface-2/);
  }

  // enter expands the project under the cursor: milestones + issues appear
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Milestones", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Issues \(\d+\)/)).toBeVisible();
  // esc collapses the detail panel
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("Milestones", { exact: true }),
  ).not.toBeVisible();

  // open THIS project's row and add a dated milestone → diamond on its span
  await row.click();
  const MS = `e2e marker ${Date.now()}`;
  const msAdded = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes("/milestones"),
    { timeout: 10_000 },
  );
  await page.getByPlaceholder("milestone title").fill(MS);
  await page.getByLabel("milestone target date").fill("2026-11-15");
  await page.getByRole("button", { name: "add", exact: true }).click();
  await msAdded;
  await expect(
    row.getByLabel(`milestone ${MS}`, { exact: true }),
  ).toBeVisible();
});
