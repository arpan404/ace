import { expect, test } from "@playwright/test";

/** Automations in fake mode, over the same automation.* messages a daemon answers. */
test("a new automation is created, listed, and runs by hand once automations are on", async ({
  page,
}) => {
  await page.goto("/settings/general");
  // The design's machine runs its automations; turn them off and on again to see the switch work.
  const enabled = page.getByRole("switch", { name: "Run automations" });
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "true");

  await page.getByRole("link", { name: "Automations" }).click();
  await page.getByRole("link", { name: "New automation" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Weekly flaky-test sweep");
  await page
    .getByRole("textbox", { name: "What should the agent do?" })
    .fill("Find tests that failed then passed this week and open a thread for each.");
  await page.getByRole("button", { name: "Create automation" }).click();

  await expect(
    page.getByRole("heading", { level: 2, name: "Weekly flaky-test sweep", exact: true }),
  ).toBeVisible();
  const aside = page.getByRole("complementary", { name: "Automations" });
  await expect(aside.getByRole("link", { name: /Weekly flaky-test sweep/ })).toBeVisible();

  await page.getByRole("main").getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Started · Weekly flaky-test sweep")).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("list", { name: "Recent runs" }).getByText("Running…"),
  ).toBeVisible();
});
