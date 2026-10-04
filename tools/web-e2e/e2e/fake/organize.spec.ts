import { expect, test } from "@playwright/test";
import { scrollToRow } from "./thread-list.ts";

/** Thread organization in fake mode: the fake daemon answers the same commands as apps/daemon. */
test("renaming and pinning from the ⋯ menu show in the header and the list", async ({ page }) => {
  await page.goto("/t/thread-install-page");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /^Rename/ }).click();
  const field = page.getByRole("textbox", { name: "Thread title" });
  await field.fill("Install page for the daemon, rewritten");
  await field.press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: "Install page for the daemon, rewritten" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /^Pin/ }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Threads" })
      .getByRole("link", { name: /Install page for the daemon, rewritten/ })
      .getByRole("img", { name: "Pinned" }),
  ).toBeVisible();
});

test("an archived thread leaves the list, and Undo brings it back", async ({ page }) => {
  await page.goto("/t/thread-install-page");
  const threads = page.getByRole("navigation", { name: "Threads" });
  await expect(threads.getByRole("link", { name: /Rewrite the install page/ })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /^Archive/ }).click();

  await expect(threads.getByRole("link", { name: /Rewrite the install page/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  // Archiving left the thread for the top of the list; the restored row is back in its place.
  await scrollToRow(page, threads.getByRole("link", { name: /Rewrite the install page/ }));
});

test("snoozing from a row shows when the thread wakes", async ({ page }) => {
  await page.goto("/t/thread-retry-budget");
  const row = page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: /Partial refunds double-count tax/ }) });
  await row.hover();
  await page.getByRole("button", { name: "Snooze Partial refunds double-count tax" }).click();
  await page.getByRole("menuitem", { name: /^Tomorrow/ }).click();

  // A snoozed thread sinks below the working ones until it wakes.
  await expect(page.getByText(/^Snoozed until tomorrow/)).toBeVisible();
  await expect(row).toHaveCount(0);
});
