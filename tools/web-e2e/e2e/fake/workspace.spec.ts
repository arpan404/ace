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

test("toasts stand in the main pane's bottom-right corner, above the composer and clear of the right panel", async ({
  page,
}) => {
  await page.goto("/t/thread-retry-budget");
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  await page.getByRole("button", { name: "Right panel" }).click();
  const panel = page.getByRole("region", { name: "Thread panel" });
  await panel.waitFor();
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Commit changes" })
    .getByRole("button", { name: "Commit" })
    .click();
  const toast = page.getByRole("dialog", { name: "Committed" });
  await expect(toast).toBeVisible();

  const main = await page.locator("main#main").boundingBox();
  const side = await panel.boundingBox();
  const composer = await page.getByRole("combobox", { name: "Message" }).boundingBox();
  if (!main || !side || !composer) throw new Error("missing layout");
  // Once its entrance settles: 12px in from the pane's right edge, left of the panel, above
  // the composer.
  await expect
    .poll(async () => {
      const box = await toast.boundingBox();
      return box && Math.round(main.x + main.width - (box.x + box.width));
    })
    .toBe(12);
  const box = await toast.boundingBox();
  if (!box) throw new Error("toast gone");
  expect(box.x + box.width).toBeLessThanOrEqual(side.x);
  expect(box.y + box.height).toBeLessThan(composer.y);
});
