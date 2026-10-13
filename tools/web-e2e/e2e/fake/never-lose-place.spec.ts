import { expect, test } from "@playwright/test";

/*
 * Never losing your place (UX audit W1): the thread you are in is always visible in the
 * sidebar, even while its new row settles into its group. Measured in a real browser, where
 * the list is virtual and only rows in view exist.
 */

test("a new thread's row stays in view in the sidebar while it settles into the list", async ({
  page,
}) => {
  await page.goto("/new");
  const message = page.getByRole("combobox", { name: "Message" });
  await message.click();
  await message.pressSequentially("Zebra unique task title");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/t\/thread-/);
  const threads = page.getByRole("navigation", { name: "Threads" });
  const row = threads.getByRole("link", { name: /^Zebra unique task title/ });
  await expect(row).toBeInViewport({ ratio: 1 });
  // The row moves once the first turn ends; the list follows it until the person scrolls.
  await expect(row).toHaveAccessibleName(/Done/, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await expect(row).toBeInViewport({ ratio: 1 });
});

test("Esc in a subagent's chat goes back to its parent thread", async ({ page }) => {
  await page.goto("/t/thread-resumable-streams/agents/thread-resumable-streams.agent.6");
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Loading…");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/t\/thread-resumable-streams$/);
});
