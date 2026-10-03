import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  scriptedReply,
  seededTitle,
} from "../src/real-daemon-config.ts";

/**
 * Smoke test against a real apps/daemon whose providers are scripted adapters from
 * @ace/adapter-testkit (src/real-daemon.ts): no provider CLI runs and no prompt leaves the box.
 */
test("the app connects to a real daemon, opens a thread and gets a reply to a message", async ({
  page,
}) => {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);

  await expect(page.getByRole("status", { name: "Daemon: Connected" })).toBeAttached();
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: new RegExp(seededTitle) }).click();

  await expect(page.getByRole("heading", { level: 1, name: seededTitle })).toBeVisible();
  const transcript = page.getByRole("feed", { name: "Transcript" });
  await expect(transcript.getByText("Say hello from the scripted provider.")).toBeVisible();
  await expect(transcript.getByText(scriptedReply, { exact: true })).toHaveCount(1);

  const message = page.getByRole("combobox", { name: "Message" });
  await message.fill("And once more, please.");
  await message.press("Enter");

  await expect(transcript.getByText("And once more, please.")).toBeVisible();
  await expect(transcript.getByText(scriptedReply, { exact: true })).toHaveCount(2);
});
