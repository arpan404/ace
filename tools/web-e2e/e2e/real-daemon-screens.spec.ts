import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  screensTitle,
  scriptedReply,
  seededTitle,
} from "../src/real-daemon-config.ts";

/**
 * Every screen wired to the daemon's request/response services, against a real apps/daemon with
 * scripted providers (src/real-daemon.ts). No provider CLI runs; the daemon has no signed-in
 * accounts and no model catalog, so those screens show their real empty states.
 */
async function connect(page: Page, path = "/") {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  const daemon = encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`);
  await page.goto(`${path}#token=${token}&daemon=${daemon}`);
  await expect(
    page.getByRole("button", { name: "Account and connection", exact: true }),
  ).toBeAttached();
}

async function openThread(page: Page) {
  await connect(page);
  await page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("link", { name: new RegExp(screensTitle) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: screensTitle })).toBeVisible();
}

test("Usage & accounts shows what the daemon's accounts service reports", async ({ page }) => {
  await connect(page, "/more/accounts");
  await expect(page.getByRole("heading", { level: 1, name: "Usage & accounts" })).toBeVisible();
  await expect(page.getByText("No accounts found yet")).toBeVisible();
  await expect(page.getByText("Accounts unavailable")).toHaveCount(0);
});

test("search finds a message across threads and Enter opens its thread", async ({ page }) => {
  await connect(page, "/more/search");
  // Only the seeded thread's first message says this.
  await page.getByRole("combobox", { name: "Search every thread" }).fill("say hello");
  const results = page.getByRole("listbox", { name: "Results" });
  await expect(results.getByRole("option").filter({ hasText: seededTitle }).first()).toBeVisible();
  await page.getByRole("combobox", { name: "Search every thread" }).press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: seededTitle })).toBeVisible();
});

test("a daemon setting is stored by the daemon and read back by a new session", async ({
  page,
}) => {
  await connect(page, "/settings/general");
  const toggle = page.getByRole("switch", { name: "Settle when the PR merges" });
  await expect(toggle).toBeVisible();
  const before = await toggle.getAttribute("aria-checked");
  const after = before === "true" ? "false" : "true";
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", after);

  // A fresh page is a fresh client: the value can only come from the daemon.
  await connect(page, "/settings/general");
  await expect(page.getByRole("switch", { name: "Settle when the PR merges" })).toHaveAttribute(
    "aria-checked",
    after,
  );
});

test("Providers lists the CLIs the daemon discovered", async ({ page }) => {
  await connect(page, "/settings/providers");
  const providers = page.getByRole("region", { name: "Providers" });
  await expect(providers.getByText("Claude Code")).toBeVisible();
  await expect(
    providers.getByText("Not installed · ace looks for claude on your PATH"),
  ).toBeVisible();
});

test("the composer offers the daemon's slash commands and the project's files", async ({
  page,
}) => {
  await openThread(page);
  const message = page.getByRole("combobox", { name: "Message" });

  await message.fill("/rev");
  const commands = page.getByRole("listbox", { name: "Commands" });
  await expect(commands.getByRole("option", { name: /\/review/ })).toBeVisible();
  await message.press("Escape");

  await message.fill("Look at @READ");
  const files = page.getByRole("listbox", { name: "Files" });
  await expect(files.getByRole("option", { name: /README\.md/ })).toBeVisible();
  await message.press("Escape");
});

test("a file uploaded through the context service goes out with the next message", async ({
  page,
}) => {
  await openThread(page);
  await page.getByLabel("Files to attach").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Restart budget: 6 attempts in 5 minutes.\n"),
  });
  const chips = page.getByRole("list", { name: "Attachments" });
  await expect(chips.getByText("notes.txt")).toBeVisible();
  await expect(chips.getByRole("status")).toHaveCount(0);

  const transcript = page.getByRole("feed", { name: "Transcript" });
  const replies = await transcript.getByText(scriptedReply, { exact: true }).count();
  await page.getByRole("combobox", { name: "Message" }).fill("Here are my notes.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(transcript.getByText("Here are my notes.")).toBeVisible();
  await expect(transcript.getByText(scriptedReply, { exact: true })).toHaveCount(replies + 1);
});

test("New thread starts a thread on the provider's default model when there is no catalog", async ({
  page,
}) => {
  await connect(page, "/new");
  await expect(page.getByRole("button", { name: /^Model: Claude Code · Default/ })).toBeVisible();
  const request = "Summarise the README";
  await page.getByRole("combobox", { name: "Message" }).fill(request);
  await page.getByRole("combobox", { name: "Message" }).press("Enter");

  // The daemon created the thread from the request, and the app opened it.
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const transcript = page.getByRole("feed", { name: "Transcript" });
  await expect(transcript.getByText(request)).toBeVisible();
  await expect(transcript.getByText(scriptedReply, { exact: true })).toHaveCount(1);
});
