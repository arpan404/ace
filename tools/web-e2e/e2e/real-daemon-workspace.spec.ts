import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  previewTitle,
  scriptOutput,
  seededTitle,
  workspaceName,
  workspaceTitle,
} from "../src/real-daemon-config.ts";
import { openWorkCard, runAction } from "./thread-header.ts";

/**
 * The thread's work card and side panel against a real apps/daemon (src/real-daemon.ts): the
 * project's script runs in a daemon PTY, a terminal opened from the panel runs a command, and
 * the card's git actions commit the project's uncommitted edit. Providers are scripted; no
 * provider CLI runs.
 */
test("running an action, a terminal and Commit work on a real daemon's checkout", async ({
  page,
}) => {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);
  await expect(page.getByRole("button", { name: /, account$/ })).toBeAttached();
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: new RegExp(workspaceTitle) }).click();
  await expect(page.getByRole("heading", { level: 1, name: workspaceTitle })).toBeVisible();

  // The project's only script, run from the work card in a new terminal in the side panel.
  await runAction(page, "npm run 'greet'");
  const panel = page.getByRole("region", { name: "Thread panel" });
  await expect(panel.getByRole("tab", { name: "greet", selected: true })).toBeVisible();
  await expect(panel.getByRole("group", { name: "greet terminal" })).toContainText(scriptOutput);

  // A terminal of your own, in the thread's checkout.
  await panel.getByRole("button", { name: /^Terminal sessions/ }).click();
  await page.getByRole("menuitem", { name: /^New terminal/ }).click();
  await expect(panel.getByRole("tab", { name: "Terminal", selected: true })).toBeVisible();
  const shell = panel.getByRole("group", { name: "Terminal terminal" });
  await shell.getByRole("textbox").focus();
  await page.keyboard.type("echo $((6*7))");
  await page.keyboard.press("Enter");
  await expect(shell).toContainText("42");

  // Closing its tab ends that shell in the daemon, once confirmed; the script's terminal is
  // still listed.
  await panel.getByRole("button", { name: "End session Terminal" }).click();
  await page
    .getByRole("dialog", { name: "End Terminal?" })
    .getByRole("button", { name: "End", exact: true })
    .click();
  await panel.getByRole("tab", { name: "greet" }).click();
  await panel.getByRole("button", { name: /^Terminal sessions/ }).click();
  const sessions = page.getByRole("menu");
  await expect(sessions.getByRole("menuitem", { name: /^greet/ })).toBeVisible();
  await expect(sessions.getByRole("menuitem", { name: /^Terminal/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Commit the uncommitted README edit with a message of our own.
  await (await openWorkCard(page)).getByRole("button", { name: "Git actions" }).click();
  await page.getByRole("menuitem", { name: /^Commit…/ }).click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  await dialog.getByRole("textbox", { name: "Commit message" }).fill("Describe the e2e project");
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(page.getByText("Committed", { exact: true })).toBeVisible();
  // Nothing is left to commit: the card's git actions say so.
  await (await openWorkCard(page)).getByRole("button", { name: "Git actions" }).click();
  const again = page.getByRole("menuitem", { name: /^Commit…/ });
  await expect(again).toBeDisabled();
  await expect(again).toContainText("Nothing uncommitted");
});

test("Open in hands the daemon's validated editor launch to this machine", async ({ page }) => {
  // A browser opens editors through their URL handlers; record instead of leaving the page.
  await page.addInitScript(() => {
    const opened: string[] = [];
    Reflect.set(window, "__opened", opened);
    window.open = (url) => {
      opened.push(String(url));
      return null;
    };
  });
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);
  await expect(page.getByRole("button", { name: /, account$/ })).toBeAttached();
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: new RegExp(seededTitle) }).click();
  await expect(page.getByRole("heading", { level: 1, name: seededTitle })).toBeVisible();

  await (
    await openWorkCard(page)
  )
    .getByRole("region", { name: "Open in" })
    .getByRole("button", { name: /^Open in Zed/ })
    .click();

  await expect(page.getByText("Opened in Zed", { exact: true })).toBeVisible();
  const opened = await page.evaluate(() => Reflect.get(window, "__opened") as string[]);
  expect(opened.at(-1)).toMatch(new RegExp(`^zed://file/.*/${workspaceName}$`));
});

test("Preview points at the Browser, and offers no port preview when the daemon runs no gateway", async ({
  page,
}) => {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);
  await expect(page.getByRole("button", { name: /, account$/ })).toBeAttached();
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: new RegExp(previewTitle) }).click();
  await expect(page.getByRole("heading", { level: 1, name: previewTitle })).toBeVisible();

  await page.getByRole("button", { name: "Right panel" }).click();
  const panel = page.getByRole("region", { name: "Thread panel" });
  // Tools beyond Changes and Agents open from the side panel's + (the new-tab launcher).
  await panel.getByRole("button", { name: "New tab" }).click();
  await panel
    .getByRole("list", { name: "Tools" })
    .getByRole("button", { name: /^Preview/ })
    .click();
  // The e2e daemon, like `ace` itself, starts without a preview gateway (ADR 0008).
  await expect(
    panel.getByText("This daemon runs no preview gateway", { exact: false }),
  ).toBeVisible();
  await expect(panel.getByRole("form", { name: "Preview a dev server" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Open the Browser" })).toBeEnabled();
});

test("⌘P finds a file in a real checkout and opens its source", async ({ page }) => {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);
  await expect(page.getByRole("button", { name: /, account$/ })).toBeAttached();
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: new RegExp(previewTitle) }).click();
  await expect(page.getByRole("heading", { level: 1, name: previewTitle })).toBeVisible();

  // The daemon's path index finds it; the files channel reads it from the thread's checkout.
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("combobox", { name: "Search files" }).fill("package");
  await expect(page.getByRole("option", { name: /package\.json/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("region", { name: "Thread panel" });
  await expect(panel.getByRole("tab", { name: "package.json", selected: true })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Source of package.json" })).toContainText(
    '"name": "e2e-project"',
  );
});
