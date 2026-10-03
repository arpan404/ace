import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  pluginMarketPath,
  pluginName,
} from "../src/real-daemon-config.ts";

/**
 * Deck, automations and skills against a real apps/daemon (src/real-daemon.ts): its conductor,
 * automation service and plugin service, over the wire. No provider CLI runs.
 */
async function connect(page: Page, path: string) {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  const daemon = encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`);
  await page.goto(`${path}#token=${token}&daemon=${daemon}`);
  await expect(page.getByRole("status", { name: "Daemon: Connected" })).toBeAttached();
}

test("a plugin installs from a local marketplace through its review, and its skill reads back", async ({
  page,
}) => {
  await connect(page, "/skills");
  await page.getByRole("button", { name: "Add skill or plugin" }).click();
  const dialog = page.getByRole("dialog", { name: "Install a plugin" });
  await dialog.getByLabel("Repository").fill(pluginMarketPath);
  await dialog.getByLabel("Plugin").fill(pluginName);
  await dialog.getByRole("button", { name: "Review" }).click();

  const review = page.getByRole("dialog", { name: `Review ${pluginName} 1.0.0` });
  await expect(review.getByRole("list", { name: "What it runs" })).toContainText(
    "MCP server notes",
  );
  await review.getByRole("button", { name: "Install" }).click();

  await expect(page.getByRole("heading", { level: 1, name: pluginName })).toBeVisible();
  const catalog = page.getByRole("navigation", { name: "Skills catalog" });
  await catalog.getByRole("link", { name: /greet/ }).click();
  await expect(page.getByText("Say hello to everyone in the thread.")).toBeVisible();

  // The daemon's own default availability, read back in words; then Codex is taken off it.
  const available = page.getByRole("main").locator("p", { hasText: "Claude Code" });
  await expect(available).toContainText("Codex");
  await page.getByRole("button", { name: "Change" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Codex" }).click();
  await page.keyboard.press("Escape");
  await expect(available).not.toContainText("Codex");
});

test("an automation created in the app is stored by the daemon and listed back", async ({
  page,
}) => {
  await connect(page, "/automations/new");
  await page.getByRole("textbox", { name: "Name" }).fill("Nightly e2e audit");
  await page
    .getByRole("textbox", { name: "What should the agent do?" })
    .fill("List the files in this project and report anything unexpected.");
  await page.getByRole("button", { name: "Create automation" }).click();

  await expect(
    page.getByRole("heading", { level: 2, name: "Nightly e2e audit", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("status", { name: "Daemon: Connected" })).toBeAttached();
  const aside = page.getByRole("complementary", { name: "Automations" });
  await expect(aside.getByRole("link", { name: /Nightly e2e audit/ })).toBeVisible();

  // Turned on in Settings, the daemon runs it by hand: a real run on the scripted provider.
  await page.getByRole("link", { name: "Settings" }).click();
  const enabled = page.getByRole("switch", { name: "Run automations" });
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await page.getByRole("link", { name: "Automations" }).click();
  await aside.getByRole("link", { name: /Nightly e2e audit/ }).click();
  await page.getByRole("main").getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Started · Nightly e2e audit")).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("list", { name: "Recent runs" }).getByRole("listitem"),
  ).not.toHaveCount(0);
});

test("a deck the daemon can't run says why instead of pretending to start", async ({ page }) => {
  await connect(page, "/deck");
  await expect(
    page.getByRole("heading", { name: "Deal a goal to a team of agents" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "New deck" }).first().click();
  const form = page.getByRole("form", { name: "New deck" });
  await form
    .getByLabel("Goal")
    .fill("Add a health endpoint to the e2e project and document it in the README.");
  await form.getByRole("button", { name: /Start deck/ }).click();

  await expect(form.getByRole("alert")).toContainText("can't run decks yet");
});
