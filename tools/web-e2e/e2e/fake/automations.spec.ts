import { expect, test } from "@playwright/test";

/** Automations in fake mode, over the same automation.* messages a daemon answers. */
test("a new automation is created from its prompt, listed, and runs now with a note", async ({
  page,
}) => {
  await page.goto("/settings/agents");
  // The design's machine runs its automations; turn them off and on again to see the switch work.
  const enabled = page.getByRole("switch", { name: "Run automations" });
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "true");

  await page.getByRole("link", { name: "Back to app" }).click();
  await page.getByRole("button", { name: /, account/ }).click();
  await page.getByRole("menuitem", { name: "Automations", exact: true }).click();
  await page.getByRole("link", { name: "New automation" }).click();
  const prompt = page.getByRole("combobox", { name: "What the agent does each time" });
  await prompt.fill(
    "Weekly flaky-test sweep. Open a thread for each test that failed then passed.",
  );
  await prompt.press("Enter");

  await expect(
    page.getByRole("heading", { level: 2, name: "Weekly flaky-test sweep", exact: true }),
  ).toBeVisible();
  const aside = page.getByRole("complementary", { name: "Automations" });
  await expect(aside.getByRole("link", { name: /Weekly flaky-test sweep/ })).toBeVisible();

  const note = page.getByRole("combobox", { name: "Note for this run" });
  await note.fill("Only the web app this time");
  await note.press("Enter");
  await expect(page.getByRole("main").getByText(/^Working for /)).toBeVisible();
});
