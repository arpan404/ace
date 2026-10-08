import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  scriptedReply,
  workspaceName,
} from "../src/real-daemon-config.ts";

/**
 * Thread journeys against a real apps/daemon with scripted providers (src/real-daemon.ts): New
 * thread on the local checkout opens the thread the daemon's receipt names, and the thread's
 * organization (rename, pin) is the daemon's, so it survives a reload.
 */
async function connect(page: Page) {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);
  await expect(page.getByRole("button", { name: /, account$/ })).toBeAttached();
}

test("a new thread opens from the daemon's receipt and its organization survives a reload", async ({
  page,
}) => {
  await connect(page);
  await page.getByRole("link", { name: /^New thread/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
  // The seeded project is the only one, so it is chosen, and named rather than shown by id.
  await expect(
    page.getByRole("heading", { level: 2, name: `What should we work on in ${workspaceName}?` }),
  ).toBeVisible();

  // The local checkout, so the journey doesn't depend on preparing a worktree.
  await page.getByRole("button", { name: /^Environment:/ }).click();
  await page.getByRole("radio", { name: /^Local checkout/ }).click();

  const ask = "Summarise the README for the journey.";
  const message = page.getByRole("combobox", { name: "Message" });
  await message.fill(ask);
  await message.press("Enter");

  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const transcript = page.getByRole("feed", { name: "Transcript" });
  await expect(transcript.getByText(ask)).toBeVisible();
  await expect(transcript.getByText(scriptedReply, { exact: true })).toHaveCount(1);

  const title = `Journey ${Date.now()}`;
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /^Rename/ }).click();
  const field = page.getByRole("textbox", { name: "Thread title" });
  await field.fill(title);
  await field.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /^Pin/ }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Threads" })
      .getByRole("link", { name: new RegExp(title) })
      .getByRole("img", { name: "Pinned" }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Unpin" })).toBeVisible();
});
