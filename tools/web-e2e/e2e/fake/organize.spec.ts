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
      .getByRole("link", { name: /Install page for the daemon, rewritten/ }),
  ).toHaveAccessibleName(/Pinned/);
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
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Snooze/ }).hover();
  await page.getByRole("menuitem", { name: /^Tomorrow/ }).click();

  // The list holds its order while the menu has keyboard focus. Leaving it lets Snooze sink.
  await page.getByRole("combobox", { name: "Message" }).focus();
  await page.mouse.move(900, 700);
  const threads = page.getByRole("navigation", { name: "Threads" });
  const snoozed = threads.getByRole("link", { name: /^Partial refunds double-count tax/ });
  await scrollToRow(page, snoozed);
  await expect(snoozed).toHaveAccessibleName(/Snoozed until tomorrow/);
});
