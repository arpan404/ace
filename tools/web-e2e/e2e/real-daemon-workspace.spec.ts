import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  scriptOutput,
  workspaceTitle,
} from "../src/real-daemon-config.ts";

/**
 * The thread header and bottom panel against a real apps/daemon (src/real-daemon.ts): the
 * project's script runs in a daemon PTY, a terminal opened from the panel runs a command, and
 * the git control commits the project's uncommitted edit. Providers are scripted; no provider
 * CLI runs.
 */
test("Run, a terminal and Commit work on a real daemon's checkout", async ({ page }) => {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);
  await expect(page.getByRole("status", { name: "Daemon: Connected" })).toBeAttached();
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: new RegExp(workspaceTitle) }).click();
  await expect(page.getByRole("heading", { level: 1, name: workspaceTitle })).toBeVisible();

  // Run: the project's only script, in a new terminal in the bottom panel.
  await page.getByRole("button", { name: "Run npm run 'greet'" }).click();
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  const terminals = bottom.getByRole("tablist", { name: "Terminals" });
  await expect(terminals.getByRole("tab", { name: "greet", selected: true })).toBeVisible();
  await expect(bottom.getByRole("group", { name: "greet terminal" })).toContainText(scriptOutput);

  // A terminal of your own, in the thread's checkout.
  await bottom.getByRole("button", { name: "New terminal" }).click();
  await expect(terminals.getByRole("tab", { name: "Terminal", selected: true })).toBeVisible();
  const shell = bottom.getByRole("group", { name: "Terminal terminal" });
  await shell.getByRole("textbox").focus();
  await page.keyboard.type("echo $((6*7))");
  await page.keyboard.press("Enter");
  await expect(shell).toContainText("42");

  // Commit the uncommitted README edit with a message of our own.
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  await dialog.getByRole("textbox", { name: "Commit message" }).fill("Describe the e2e project");
  await dialog.getByRole("button", { name: "Commit" }).click();
  await expect(page.getByText("Committed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0);
});
