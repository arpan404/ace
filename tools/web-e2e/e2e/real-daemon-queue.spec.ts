import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  holdMarker,
  limitMarker,
  limitTitle,
  queueTitle,
  scriptedReply,
} from "../src/real-daemon-config.ts";

/**
 * The server queue and limit recovery against a real apps/daemon (src/real-daemon.ts). The
 * scripted provider keeps a turn working while its message carries `holdMarker`, and runs into
 * a usage limit on `limitMarker`, so the daemon has a running turn to queue behind and a limit
 * to hold the queue on. No provider CLI runs.
 */
async function open(page: Page, title: string) {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(`/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`);
  await expect(page.getByRole("button", { name: /, account$/ })).toBeAttached();
  await page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("link", { name: new RegExp(title) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function send(page: Page, text: string) {
  const field = page.getByRole("combobox", { name: "Message" });
  await field.fill(text);
  await field.press("Enter");
  await expect(field).toHaveValue("");
}

test("a message sent while the agent works waits in the daemon's queue until Send now steers it in", async ({
  page,
}) => {
  await open(page, queueTitle);
  const transcript = page.getByRole("feed", { name: "Transcript" });
  const replies = transcript.getByText(scriptedReply, { exact: true });
  const before = await replies.count();

  // Unique per run, so the journey can run again against the same daemon.
  const run = Date.now().toString(36);
  const first = `Then bump the version (${run})`;
  const second = `And tag the release (${run})`;
  await send(page, `Take your time on the changelog ${holdMarker}`);
  await expect(page.getByRole("button", { name: "Stop the agent" })).toBeVisible();

  // Two follow-ups while it works: the daemon holds both, in order.
  await send(page, first);
  await send(page, second);
  const queue = page.getByRole("list", { name: "Queued messages" });
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await expect(queue.getByRole("listitem").first()).toContainText(first);

  // Remove one; the daemon drops it, so a reload doesn't bring it back.
  await queue
    .getByRole("listitem")
    .nth(1)
    .getByRole("button", { name: "Remove from queue" })
    .click();
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await page.reload();
  await expect(
    page.getByRole("list", { name: "Queued messages" }).getByRole("listitem"),
  ).toHaveCount(1);

  // Send now steers the waiting message into the running turn, which then finishes.
  await page.getByRole("button", { name: `Queued message options: ${first}` }).click();
  await page.getByRole("menuitem", { name: "Send now" }).click();
  await expect(page.getByRole("list", { name: "Queued messages" })).toHaveCount(0);
  await expect(transcript.getByText(first)).toBeVisible();
  await expect(replies).toHaveCount(before + 1);
  await expect(page.getByRole("button", { name: "Stop the agent" })).toHaveCount(0);
});

test("a usage limit holds the thread as Limited until Resume now continues it", async ({
  page,
}) => {
  await open(page, limitTitle);
  const replies = page
    .getByRole("feed", { name: "Transcript" })
    .getByText(scriptedReply, { exact: true });
  const before = await replies.count();
  await send(page, `Index the whole repository ${limitMarker}`);

  const limit = page.getByRole("region", { name: "Usage limit reached" });
  await expect(limit).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Threads" })
      .getByRole("link", { name: new RegExp(limitTitle) }),
  ).toContainText("Limited");

  // Resume now continues the cut-off turn in a fresh provider session.
  await limit.getByRole("button", { name: "Resume now" }).click();
  await expect(limit).toHaveCount(0);
  await expect(replies).toHaveCount(before + 1);
});
