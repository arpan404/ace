import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  scriptedReply,
  workerTitle,
} from "../src/real-daemon-config.ts";

const transcript = (page: Page) => page.getByRole("feed", { name: "Transcript" });

/**
 * The client runs in a SharedWorker (ADR 0056): tabs hold mirrors of its stores and never open
 * a socket themselves, and every tab of the origin shares the worker's one connection.
 */
test("two tabs share the worker's daemon connection: neither opens a socket, both follow the thread", async ({
  context,
}) => {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  const sockets: string[] = [];
  const open = async () => {
    const page = await context.newPage();
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto(
      `/#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`,
    );
    await expect(
      page.getByRole("button", { name: "Account and connection", exact: true }),
    ).toBeAttached();
    await page
      .getByRole("navigation", { name: "Threads" })
      .getByRole("link", { name: new RegExp(workerTitle) })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: workerTitle })).toBeVisible();
    return page;
  };

  const first = await open();
  const second = await open();
  const before = await transcript(second).getByText(scriptedReply, { exact: true }).count();

  const message = first.getByRole("combobox", { name: "Message" });
  await message.fill("Reply once more for the second tab.");
  await message.press("Enter");

  await expect(transcript(second).getByText("Reply once more for the second tab.")).toBeVisible();
  await expect(transcript(second).getByText(scriptedReply, { exact: true })).toHaveCount(
    before + 1,
  );
  // Page-owned sockets would include Vite's HMR socket; the daemon's never belongs to a page.
  expect(sockets.filter((url) => url.includes(`:${daemonPort}`))).toEqual([]);
});
