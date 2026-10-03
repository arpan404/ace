import { expect, test } from "@playwright/test";

/** Run, Commit and Create PR in the thread header, against the fake daemon's checkouts. */
test("Run starts the project's script in a terminal of the bottom panel", async ({ page }) => {
  await page.goto("/t/thread-replay-cursor");
  await page.getByRole("button", { name: "Run bun run dev:relay" }).click();
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  await expect(
    bottom.getByRole("tablist", { name: "Terminals" }).getByRole("tab", { name: "dev:relay" }),
  ).toBeVisible();
});

test("Commit, then Create PR, opens a pull request for the branch", async ({ page }) => {
  await page.goto("/t/thread-retry-budget");
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  const commit = page.getByRole("dialog", { name: "Commit changes" });
  await commit.getByRole("button", { name: "Commit" }).click();
  await expect(page.getByText("Committed", { exact: true })).toBeVisible();

  await page.goto("/t/thread-sheet-rotate");
  await page.getByRole("button", { name: "Create PR" }).click();
  const dialog = page.getByRole("dialog", { name: "Open a pull request" });
  await dialog.getByRole("button", { name: "Create PR" }).click();
  await expect(page.getByRole("button", { name: /^PR #\d+/ })).toBeVisible();
});
