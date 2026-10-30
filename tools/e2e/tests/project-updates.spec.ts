import { expect, test } from "@playwright/test";
import { SAME_ORIGIN } from "./helpers";

const NAME = `e2e status feed ${Date.now()}`;

// U14 web feed: a project's page lists status updates and posts a new one.
test("project page: empty feed, post an update from the form, it leads the feed", async ({ page }) => {
  const made = await page.request.post("/api/projects", { headers: SAME_ORIGIN, data: { name: NAME } });
  expect(made.ok()).toBeTruthy();
  const project = (await made.json()) as { id: string };

  await page.goto(`/projects/${project.id}`);
  // the composer is a client component: let it hydrate before typing
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: NAME, level: 1 })).toBeVisible();
  await expect(page.getByText("No status updates yet")).toBeVisible();

  await page.getByLabel("Health").selectOption("at_risk");
  await page.getByLabel("Update (markdown)").fill("Blocked on **review**, see [notes](https://example.com).");
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/api/projects/${project.id}/updates`));
  await page.getByRole("button", { name: "Post update" }).click();
  expect((await posted).status()).toBe(201);

  const item = page.locator("[data-update-id]").first();
  await expect(item).toContainText("At risk");
  await expect(item.locator("strong")).toHaveText("review");
  await expect(item.getByRole("link", { name: "notes" })).toHaveAttribute("rel", /noopener/);
  await expect(page.getByLabel("Update (markdown)")).toHaveValue("");
});

test("project page: an empty body cannot be posted, a draft loads, projects list links here", async ({ page }) => {
  const made = await page.request.post("/api/projects", { headers: SAME_ORIGIN, data: { name: `${NAME} b` } });
  const project = (await made.json()) as { id: string };
  await page.goto(`/projects/${project.id}`);
  // the composer is a client component: let it hydrate before typing
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Post update" })).toBeDisabled();
  await page.getByRole("button", { name: "Draft from activity" }).click();
  await expect(page.getByRole("status")).not.toBeEmpty();

  await page.goto("/projects");
  await page.getByRole("link", { name: `${NAME} b` }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
});

test("project page: an unknown project shows a not-found state", async ({ page }) => {
  await page.goto("/projects/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("No such project")).toBeVisible();
});
