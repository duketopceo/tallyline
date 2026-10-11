import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const TITLE = `e2e keymap ${Date.now()}`;

test("@keyboard @a11y ? opens keymap overlay — grouped, searchable, axe-clean", async ({
  page,
}) => {
  await page.goto("/issues");
  await page.waitForSelector("[data-qc-ready]", { timeout: 15_000 });

  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Navigate", { exact: true }),
  ).toBeVisible();

  // searchable: filtering to "review" leaves the g r binding
  await dialog.getByPlaceholder("filter bindings…").fill("review");
  await expect(dialog.getByText("review queue")).toBeVisible();
  await expect(dialog.getByText("move down")).not.toBeVisible();

  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .analyze();
  expect(
    results.violations,
    results.violations.map((v) => v.id).join(", "),
  ).toHaveLength(0);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test(": opens command mode — :comment executes a real mutation", async ({
  page,
}) => {
  await page.goto("/issues");
  await page.waitForSelector("[data-qc-ready]", { timeout: 15_000 });

  // seed an issue via quick-create
  await page.keyboard.press("c");
  const qc = page.getByRole("dialog", { name: "Quick create issue" });
  await qc.getByPlaceholder("Issue title").fill(TITLE);
  await qc.getByRole("button", { name: "Create issue" }).click();
  await expect(qc).not.toBeVisible();

  // learn its key via triage list
  await page.goto("/triage");
  const row = page.getByRole("link", { name: new RegExp(TITLE) });
  await expect(row).toBeVisible();
  const key = (await row.textContent())?.match(/[A-Z0-9]+-\d+/)?.[0];
  expect(key).toBeTruthy();

  // `:` opens the palette straight into command mode. A keypress before the
  // palette's document listener is attached is silently dropped (the cold
  // dev server hydrates /triage late), so wait for the palette's own signal.
  await page.waitForSelector("[data-palette-ready]", { timeout: 15_000 });
  await page.keyboard.press(":");
  const palette = page.getByPlaceholder(
    "Search issues or run a command",
  );
  await expect(palette).toBeVisible();
  await expect(page.getByText(/commands: state done start/)).toBeVisible();

  await palette.fill(`:comment ${key} e2e was here`);
  await palette.press("Enter");
  await expect(page.getByText(`commented on ${key}`)).toBeVisible();
  await page.keyboard.press("Escape");

  // the comment landed on the issue detail
  await page.goto(`/issues/${key}`);
  await expect(page.getByText("e2e was here")).toBeVisible();
});
