import { expect, test } from "@playwright/test";
import { openWorkCard, runAction, workCard } from "../thread-header.ts";

/** Running scripts, Commit and Create PR from the thread's work card, against the fake daemon. */

test("running a script an agent already runs shows the agent's shell, not a second empty copy", async ({
  page,
}) => {
  await page.goto("/t/thread-replay-cursor");
  await expect(
    page.getByRole("group", { name: "Background task bun run dev:relay" }),
  ).toContainText("Running in background");
  const card = await openWorkCard(page);
  // The card says so before it is run.
  const run = card.getByRole("button", {
    name: "Run bun run dev:relay, running: shows its terminal",
  });
  await run.click();
  await expect(card).toHaveCount(0);
  const panel = page.getByRole("region", { name: "Thread panel" });
  await expect(panel.getByRole("tab", { name: "dev:relay", selected: true })).toBeVisible();
  await expect(panel.getByText("Agent shell")).toBeVisible();
  await expect(panel.getByRole("log", { name: "dev:relay output" })).toContainText(
    "relay listening on ws://127.0.0.1:8787",
  );
  await expect(panel.getByRole("tab", { name: /dev:relay/ })).toHaveCount(1);
});

test("running another script opens a terminal tab of its own, printing as it runs", async ({
  page,
}) => {
  await page.goto("/t/thread-replay-cursor");
  await runAction(page, "bun run test");
  const panel = page.getByRole("region", { name: "Thread panel" });
  await expect(panel.getByRole("tab", { name: "test", selected: true })).toBeVisible();
  await expect(panel.getByRole("group", { name: "test terminal" })).toContainText("8 pass");
});

test("Commit, then Create PR, opens a pull request for the branch", async ({ page }) => {
  await page.goto("/t/thread-retry-budget");
  const card = await openWorkCard(page);
  await card.getByRole("button", { name: "Commit & push" }).click();
  // The form steps in front of the card.
  await expect(workCard(page)).toHaveCount(0);
  const commit = page.getByRole("dialog", { name: "Commit changes" });
  await commit.getByRole("checkbox", { name: "Push after committing" }).uncheck();
  await commit.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(page.getByText("Committed", { exact: true })).toBeVisible();

  await page.goto("/t/thread-sheet-rotate");
  await (
    await openWorkCard(page)
  )
    .getByRole("region", { name: "Changes and branch" })
    .getByRole("button", { name: "Create PR" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Open a pull request" });
  await dialog.getByRole("button", { name: "Create PR" }).click();
  await expect(page.getByText(/^Pull request #\d+ opened$/)).toBeVisible();
  await expect(
    (await openWorkCard(page))
      .getByRole("region", { name: "Pull requests" })
      .getByRole("button", { name: /^Pull request #\d+/ }),
  ).toBeVisible();
});

test("toasts stand in the main pane's bottom-right corner, above the composer and clear of the right panel", async ({
  page,
}) => {
  await page.goto("/t/thread-retry-budget");
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  await page.getByRole("button", { name: "Right panel" }).click();
  const panel = page.getByRole("region", { name: "Thread panel" });
  await panel.waitFor();
  // Beside the panel the column is narrow: the work card still opens from the header.
  await (await openWorkCard(page)).getByRole("button", { name: "Commit & push" }).click();
  const commit = page.getByRole("dialog", { name: "Commit changes" });
  await commit.getByRole("checkbox", { name: "Push after committing" }).uncheck();
  await commit.getByRole("button", { name: "Commit", exact: true }).click();
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
