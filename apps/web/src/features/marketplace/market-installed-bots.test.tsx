import type { MarketInstalled } from "@ace/protocol/marketplace";
import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { findMarket, openApp } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

/*
 * Installed lists each bot made from one bot package as its own row (ADR 0200 §3.9), and an
 * update its bot holds until its turn ends shows the version actually running, saying the new
 * one waits (ADR 0200 §6.1). Update on a row reviews the update of that row's bot.
 */

const bot = (target: string, extra: Partial<MarketInstalled>): MarketInstalled => ({
  source: "market",
  type: "spade-bot",
  name: "flight-watcher",
  title: "Flight watcher",
  version: "1.0.0",
  hash: "a".repeat(64),
  acceptedAt: 1,
  state: "on",
  target,
  linked: true,
  ...extra,
});

test("each bot from one package is its own row, and a held update says it waits for the bot's turn", async () => {
  const app = await openApp("/chats?market=installed", {
    installed: [
      bot("bot_1", { update: "2.1.0" }),
      bot("bot_2", { version: "2.0.0", update: "2.1.0", held: { version: "2.1.0" } }),
    ],
  });
  const market = await findMarket();
  // The bot behind is under Updates; the one whose update waits for its turn isn't offered it.
  const updates = within(await within(market).findByRole("list", { name: "Updates" }));
  const installed = within(within(market).getByRole("list", { name: "Installed" }));
  const [behind] = updates.getAllByRole("listitem");
  const [waiting] = installed.getAllByRole("listitem");
  if (!waiting || !behind) throw new Error("both rows are listed");
  // The version Spade runs, and the accepted one waiting: not offered again.
  expect(within(waiting).getByText("Update to 2.1.0 waits for its turn")).toBeTruthy();
  expect(within(waiting).getByText("2.0.0")).toBeTruthy();
  expect(within(waiting).queryByRole("button", { name: "Update Flight watcher" })).toBeNull();

  await userEvent.click(within(behind).getByRole("button", { name: "Update Flight watcher" }));
  // The review it opens is that bot's update.
  await waitFor(() =>
    expect(new URLSearchParams(app.history.location.search).get("market")).toBe(
      "bot/flight-watcher/update/bot_1",
    ),
  );
});
