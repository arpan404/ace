import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  deleteTitle,
  forkTitle,
  scriptedReply,
  settleTitle,
  snoozeTitle,
} from "../src/real-daemon-config.ts";

/**
 * Thread organization against a real apps/daemon (src/real-daemon.ts): settling, snoozing,
 * forking and deleting are daemon commands (ADR 0057), so each one survives a reload. Providers
 * are scripted; no provider CLI runs.
 */
async function connect(page: Page) {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);
  await expect(
    page.getByRole("button", { name: "Account and connection", exact: true }),
  ).toBeAttached();
}

const threads = (page: Page) => page.getByRole("navigation", { name: "Threads" });
const row = (page: Page, title: string) =>
  threads(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: new RegExp(title) }) });

test("a settled thread moves under Settled and comes back when unsettled, across a reload", async ({
  page,
}) => {
  await connect(page);
  // From the thread's ⋯ menu: other journeys reorder the list while this one runs.
  await threads(page)
    .getByRole("link", { name: new RegExp(settleTitle) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: settleTitle })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Settle", exact: true }).click();
  // The toast confirms the daemon accepted it.
  await expect(page.getByText(`Settled · ${settleTitle}`)).toBeVisible();
  await expect(threads(page).getByRole("link", { name: new RegExp(settleTitle) })).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Account and connection", exact: true }),
  ).toBeAttached();
  await expect(threads(page).getByRole("link", { name: new RegExp(settleTitle) })).toHaveCount(0);
  await threads(page)
    .getByRole("button", { name: /^Settled \(\d+\)/ })
    .click();
  await threads(page)
    .getByRole("link", { name: new RegExp(settleTitle) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: settleTitle })).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Unsettle" }).click();
  await expect(page.getByText(`Back in the list · ${settleTitle}`)).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Account and connection", exact: true }),
  ).toBeAttached();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Settle", exact: true })).toBeVisible();
});

test("a snoozed thread shows when it wakes, and Wake now clears it across a reload", async ({
  page,
}) => {
  await connect(page);
  await threads(page)
    .getByRole("link", { name: new RegExp(snoozeTitle) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: snoozeTitle })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Snooze" }).hover();
  await page.getByRole("menuitem", { name: /^Tomorrow/ }).click();
  await expect(page.getByText(/^Snoozed until tomorrow/)).toBeVisible();
  const wake = row(page, snoozeTitle).getByRole("img", { name: /^Snoozed until tomorrow/ });
  await expect(wake).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Snooze" }).hover();
  await page.getByRole("menuitem", { name: "Wake now" }).click();
  await expect(wake).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Account and connection", exact: true }),
  ).toBeAttached();
  await expect(threads(page).getByRole("link", { name: new RegExp(snoozeTitle) })).toBeVisible();
  await expect(wake).toHaveCount(0);
});

test("forking from the last turn opens a new thread with the conversation so far", async ({
  page,
}) => {
  await connect(page);
  await threads(page)
    .getByRole("link", { name: new RegExp(forkTitle) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: forkTitle })).toBeVisible();
  const source = page.url();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Fork from the last turn…" }).click();
  const dialog = page.getByRole("dialog", { name: "Fork from here" });
  await dialog
    .getByRole("textbox", { name: "First message of the fork" })
    .fill("Try a shorter README.");
  await dialog.getByRole("button", { name: "Fork" }).click();

  await expect(page).not.toHaveURL(source);
  const transcript = page.getByRole("feed", { name: "Transcript" });
  await expect(transcript.getByText("Tidy the README.")).toBeVisible();
  await expect(transcript.getByText("Try a shorter README.")).toBeVisible();
  await expect(transcript.getByText(scriptedReply, { exact: true }).last()).toBeVisible();
});

test("a deleted thread leaves the list and stays gone after a reload", async ({ page }) => {
  await connect(page);
  await threads(page)
    .getByRole("link", { name: new RegExp(deleteTitle) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: deleteTitle })).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete thread" }).click();

  // The same delete as Home's: gone at once, sent to the daemon once the Undo window closes.
  const deleted = page.getByRole("dialog", { name: `Deleted · ${deleteTitle}` });
  await expect(deleted).toBeVisible();
  await expect(threads(page).getByRole("link", { name: new RegExp(deleteTitle) })).toHaveCount(0);
  await expect(deleted).toBeHidden({ timeout: 15_000 });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Account and connection", exact: true }),
  ).toBeAttached();
  await expect(
    threads(page)
      .getByRole("link", { name: /on a real daemon/ })
      .first(),
  ).toBeVisible();
  await expect(threads(page).getByRole("link", { name: new RegExp(deleteTitle) })).toHaveCount(0);
});
