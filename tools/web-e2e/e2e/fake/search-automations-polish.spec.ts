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

test("phone file triggers can be created, and a run's answer and thread stay reachable", async ({
  page,
}) => {
  await page.goto("/automations/new");
  await page.getByRole("button", { name: /^When: / }).click();
  const when = page.getByRole("dialog", { name: "When it runs" });
  await when.getByRole("radio", { name: "When files change", exact: true }).click();
  await when.getByRole("textbox", { name: "Files, one glob per line" }).fill("src/**/*.test.ts");
  await page.keyboard.press("Escape");
  const prompt = page.getByRole("combobox", { name: "What the agent does each time" });
  await prompt.fill("Watch test changes. Review each changed test.");
  await prompt.press("Enter");
  await expect(
    page.getByRole("heading", { level: 2, name: "Watch test changes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Run now", exact: true }).click();
  await expect(page.getByRole("main").getByText(/^Working for /)).toBeVisible();
  await page.goto("/automations/auto-pr-review");
  const run = page.getByRole("article").filter({ hasText: "Approved #212 with one note" });
  await expect(run).toBeVisible();
  await run.getByRole("link", { name: "Open run", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48", exact: true }),
  ).toBeVisible();
});
