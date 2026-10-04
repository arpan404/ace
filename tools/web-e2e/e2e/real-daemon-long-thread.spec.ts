import { readFileSync } from "node:fs";
import { ThreadId } from "@ace/protocol";
import { expect, test, type Page } from "@playwright/test";
import { daemonCommands } from "../src/daemon-socket.ts";
import {
  daemonPort,
  daemonTokenPath,
  longAsk,
  longTitle,
  longTurns,
  scriptedReply,
} from "../src/real-daemon-config.ts";
import { scrollToRow } from "./fake/thread-list.ts";

/**
 * A long thread on a real apps/daemon with scripted providers (src/real-daemon.ts seeds 110
 * turns, past the 200-item snapshot): the daemon's turn index, item windows, SQLite FTS
 * search, catch-up digest and per-device read cursor, through the web app.
 */

const url = `ws://127.0.0.1:${daemonPort}/`;
const token = () => readFileSync(daemonTokenPath, "utf8").trim();
const mod = "ControlOrMeta";

async function openLongThread(page: Page): Promise<string> {
  await page.goto(`/#token=${token()}&daemon=${encodeURIComponent(url)}`);
  await expect(page.getByRole("status", { name: "Daemon: Connected" })).toBeAttached();
  const row = page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("link", { name: new RegExp(longTitle) });
  await scrollToRow(page, row);
  await row.click();
  await expect(page).toHaveURL(/\/t\/[^/?]+$/);
  const feed = page.getByRole("feed", { name: "Transcript" });
  // The seeded follow-ups run one after another from the daemon's start; wait for the last
  // turn's answer.
  await expect(feed.getByText(longAsk(longTurns))).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("list", { name: "Queued messages" })).toHaveCount(0);
  return new URL(page.url()).pathname.split("/").at(-1) ?? "";
}

test("jump to an early turn, search for one, and catch up after another device's work", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const threadId = await openLongThread(page);
  const feed = page.getByRole("feed", { name: "Transcript" });

  // The turn index: the first turn is far older than the transcript's window.
  await expect(feed.getByText(longAsk(1))).toHaveCount(0);
  await page.getByRole("button", { name: "Turns" }).click();
  const turns = page.getByRole("listbox", { name: "Turns of this thread" });
  await expect(
    turns.getByRole("option", { name: new RegExp(`^Turn ${longTurns}: `) }),
  ).toBeVisible();
  await page.keyboard.press("Home");
  await expect(turns.getByRole("option", { name: /^Turn 1: / })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  const jumped = page.getByRole("status", { name: "Jumped" });
  await expect(jumped).toContainText("Jumped to turn 1");
  await expect(jumped).toContainText(`of ${longTurns}`);
  await expect(feed.getByText(longAsk(1))).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /^Jump to live/ })
    .first()
    .click();
  await expect(jumped).toHaveCount(0);
  await expect(feed.getByText(longAsk(longTurns))).toBeVisible();

  // Search: one turn holds the word.
  await page.keyboard.press(`${mod}+f`);
  const bar = page.getByRole("search", { name: "Search this thread" });
  await page.keyboard.type("alpha7x");
  await expect(bar.getByRole("option", { name: /Turn 7/ })).toBeVisible();
  await expect(bar.getByText("1 result")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(jumped).toContainText("Jumped to turn 7");
  await expect(feed.getByText(longAsk(7))).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /^Jump to live/ })
    .first()
    .click();
  await expect(jumped).toHaveCount(0);

  // Read to the live end, leave, and let another device add two turns meanwhile.
  await expect(feed.getByText(longAsk(longTurns))).toBeInViewport();
  await page.waitForTimeout(1_500);
  await page.goto("/activity");
  await daemonCommands(
    url,
    token(),
    ["Checkpoint 111: check the rollout.", "Checkpoint 112: report what changed."].map((text) => ({
      type: "thread.send",
      threadId: ThreadId.parse(threadId),
      input: [{ type: "text", text }],
      delivery: "queue",
    })),
    "e2e-other-device",
  );
  await page.goto(`/t/${threadId}`);
  const card = page.getByRole("region", { name: "While you were away" });
  await expect(card).toContainText(/2 turns finished/, { timeout: 20_000 });
  await expect(card).toContainText(`Latest: ${scriptedReply}`);

  // Summarise asks the agent in an ordinary message; nothing else was sent.
  await card.getByRole("button", { name: "Summarise" }).click();
  await expect(
    feed.getByText(/^Summarise what happened in this thread since I was last here/),
  ).toBeVisible();
  await expect(card).toHaveCount(0);

  // The read cursor is this device's and survives a reload: nothing new, no card.
  await page.waitForTimeout(1_500);
  await page.reload();
  await expect(feed.getByText(/^Summarise what happened in this thread/)).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(card).toHaveCount(0);
});
