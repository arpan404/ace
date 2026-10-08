import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 900 } });

test("phone search keeps Project and Date usable beside the kind filters", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
  await page.keyboard.press("Meta+Shift+K");
  await page.getByRole("combobox", { name: "Search every thread" }).fill("replay");
  const results = page.getByRole("listbox", { name: "Results" });
  await expect(results.getByRole("option")).toHaveCount(6);
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option", { name: "relay", exact: true }).click();
  await page.getByRole("combobox", { name: "Date" }).click();
  await page.getByRole("option", { name: "Past day", exact: true }).click();
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(
    results.getByText("bun run test apps/server --filter replay", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Threads", exact: true }).click();
  await page.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option", { name: "All projects", exact: true }).click();
  await page.getByRole("combobox", { name: "Date" }).click();
  await page.getByRole("option", { name: "Any time", exact: true }).click();
  await page.getByRole("combobox", { name: "Search every thread" }).fill("codex");
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(results.getByText("Bump Codex app-server to 0.48", { exact: true })).toBeVisible();
});

test("phone file triggers can be created and Edit, Run now and run output remain reachable", async ({
  page,
}) => {
  await page.goto("/automations/new");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Watch test changes");
  await page
    .getByRole("textbox", { name: "What should the agent do?" })
    .fill("Review changed tests.");
  await page.getByRole("combobox", { name: "When it runs" }).click();
  await expect(page.getByRole("option", { name: "By hand", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "On file change", exact: true }).click();
  await page.getByRole("textbox", { name: "File globs, one per line" }).fill("src/**/*.test.ts");
  await page.getByRole("button", { name: "Create automation", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Watch test changes", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Recent runs" }).getByText("Running…", { exact: true }),
  ).toBeVisible();
  await page.goto("/automations/auto-pr-review");
  await page
    .getByRole("button", { name: "Open the run #212 · approved with 1 note", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Run output" })).toContainText(
    "#212 · approved with 1 note",
  );
  await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(1);
  await page.getByRole("link", { name: "Open thread", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48", exact: true }),
  ).toBeVisible();
});
