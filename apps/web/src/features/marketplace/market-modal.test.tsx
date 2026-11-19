import type { FakeDaemon } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { roster, spadeApp } from "@/test/spade.ts";
import { entry, findMarket, openApp, seed } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

async function installed(daemon: FakeDaemon) {
  return daemon.marketplace.handle({
    type: "marketplace.request",
    requestId: "check",
    operation: { op: "installed" },
  });
}

test("search narrows the marketplace to what matches, and Esc clears it first", async () => {
  await openApp("/chats?market=discover");
  const market = await findMarket();
  await userEvent.type(
    within(market).getByRole("searchbox", { name: "Search the marketplace" }),
    "harbour",
  );

  const results = within(await within(market).findByRole("list", { name: "Results" }));
  await waitFor(() => expect(results.queryByText("Triage mail")).toBeNull());
  expect(results.getByText("Harbour dusk")).toBeTruthy();

  await userEvent.keyboard("{Escape}");
  expect(
    within(market).getByRole<HTMLInputElement>("searchbox", { name: "Search the marketplace" })
      .value,
  ).toBe("");
  expect(screen.getByRole("dialog", { name: "Marketplace" })).toBeTruthy();
});

test("Try it dresses the whole app in the Suit, and Undo puts the person's look back", async () => {
  await openApp("/chats?market=suit/harbour-dusk");
  const market = await findMarket();
  await within(market).findByRole("heading", { level: 1, name: "Harbour dusk" });
  expect(document.documentElement.dataset.suit).toBeUndefined();

  await userEvent.click(within(market).getByRole("button", { name: "Try it" }));
  const bar = await screen.findByRole("status");
  expect(await within(bar).findByText("Trying Harbour dusk")).toBeTruthy();
  await waitFor(() => expect(document.documentElement.dataset.suit).toBe("harbour-dusk"));

  await userEvent.click(within(bar).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(document.documentElement.dataset.suit).toBeUndefined());
  expect(within(bar).queryByText("Trying Harbour dusk")).toBeNull();
});

test("a recipe installs with its switches as the person set them, then opens its bot", async () => {
  const { app, spade } = await spadeApp("/chats?market=bot/inbox/review", () => {}, {
    daemon: (daemon) => {
      daemon.seedServices({ marketplace: seed });
      daemon.marketplace.makeBot = () => spade.addAgent({ id: "inbox-bot", name: "Inbox" }).id;
    },
  });
  const market = await findMarket();

  // Required apps start on, optional ones off, and the routines paused.
  const gmail = await within(market).findByRole("switch", { name: "Gmail" });
  const receipts = within(market).getByRole("switch", { name: "Receipts" });
  const routines = within(market).getByRole("switch", { name: "Start its routines" });
  expect(gmail.getAttribute("aria-checked")).toBe("true");
  expect(receipts.getAttribute("aria-checked")).toBe("false");
  expect(routines.getAttribute("aria-checked")).toBe("false");

  // Without a required app it can't install, and says why.
  await userEvent.click(gmail);
  expect(within(market).getByText("Inbox can't work without Gmail.")).toBeTruthy();
  expect(within(market).getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(
    true,
  );

  await userEvent.click(gmail);
  await userEvent.click(receipts);
  await userEvent.click(routines);
  await userEvent.click(within(market).getByRole("button", { name: "Install" }));

  expect(await (await roster()).findByText("Inbox")).toBeTruthy();
  expect(app.daemon.marketplace.accepted.map((accepted) => accepted.choices)).toEqual([
    {
      bots: [],
      needs: { "connector:gmail": true, "connector:https://receipts.example/mcp": true },
      startRoutines: true,
    },
  ]);
});

test("an entry ace hasn't reviewed says so on its page and its review", async () => {
  const { history } = await openApp("/chats?market=bot/inbox");
  const market = await findMarket();
  expect(await within(market).findByText("Not reviewed by ace")).toBeTruthy();

  await userEvent.click(within(market).getByRole("button", { name: "Install" }));
  expect(
    await within(market).findByText(
      "Not reviewed by ace. Read what it does before you install it.",
    ),
  ).toBeTruthy();
  expect(new URLSearchParams(history.location.search).get("market")).toBe("bot/inbox/review");

  // A reviewed one says it was.
  await userEvent.click(within(market).getByRole("button", { name: "Discover" }));
  const tools = within(await within(market).findByRole("region", { name: "Tools" }));
  await userEvent.click(await tools.findByRole("button", { name: "Triage mail" }));
  expect(await within(market).findByText("Reviewed by ace")).toBeTruthy();
  expect(within(market).queryByText("Not reviewed by ace")).toBeNull();
});

test("a withdrawn entry says why and can't be installed, even from its review's address", async () => {
  const app = await openApp("/chats?market=plugin/old-tools");
  const market = await findMarket();
  expect(
    await within(market).findByText(
      "Withdrawn by its publisher: It sent files to a server it didn't name.",
    ),
  ).toBeTruthy();
  expect(within(market).queryByRole("button", { name: "Install" })).toBeNull();

  await userEvent.click(within(market).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Marketplace" })).toBeNull());
  app.history.push("/chats?market=plugin/old-tools/review");
  const again = await findMarket();
  expect(await within(again).findByRole("heading", { name: "Old tools" })).toBeTruthy();
  expect(within(again).queryByRole("button", { name: "Install" })).toBeNull();
  expect(app.daemon.marketplace.accepted).toEqual([]);
});

test("an update waits in Updates until its own review is installed", async () => {
  const app = await openApp("/chats?market=updates", {
    entries: [
      ...(seed.entries ?? []).filter((each) => each.summary.name !== "triage-mail"),
      { summary: entry("spade-skill", "triage-mail", "Triage mail", { version: "1.1.0" }) },
    ],
    installed: [
      {
        source: "market",
        type: "spade-skill",
        name: "triage-mail",
        title: "Triage mail",
        version: "1.0.0",
        hash: "a".repeat(64),
        acceptedAt: 1,
        state: "on",
        update: "1.1.0",
      },
    ],
  });
  const market = await findMarket();
  const updates = within(await within(market).findByRole("list", { name: "Updates" }));
  expect(updates.getByText("1.0.0 → 1.1.0")).toBeTruthy();
  // Nothing applied on its own.
  expect(await installed(app.daemon)).toMatchObject({
    result: { installed: [{ name: "triage-mail", version: "1.0.0" }] },
  });

  await userEvent.click(updates.getByRole("button", { name: "Update Triage mail" }));
  expect(
    await within(market).findByText("Replaces version 1.0.0, which stays until you install."),
  ).toBeTruthy();
  await userEvent.click(within(market).getByRole("button", { name: "Install" }));

  await waitFor(async () =>
    expect(await installed(app.daemon)).toMatchObject({
      result: { installed: [{ name: "triage-mail", version: "1.1.0" }] },
    }),
  );
  expect(await within(market).findByText("Everything is up to date")).toBeTruthy();
});

test("Discover draws only the sections the daemon has data for", async () => {
  await openApp("/chats?market=discover", {
    publishing: {
      discover: {
        featured: [],
        trending: [],
        fresh: [],
        collections: [],
        publishers: [],
        rankedAt: 0,
      },
    },
  });
  const market = await findMarket();
  // The featured hero and the type shelves come from the listings.
  expect(await within(market).findByRole("tablist", { name: "Featured" })).toBeTruthy();
  expect(await within(market).findByRole("region", { name: "Looks" })).toBeTruthy();
  expect(within(market).getByRole("region", { name: "Bots" })).toBeTruthy();
  // The market ranked and collected nothing yet, and Spade isn't running.
  for (const name of [
    "Trending this week",
    "New and notable",
    "Collections",
    "Top publishers",
    "Apps",
  ])
    expect(within(market).queryByRole("region", { name })).toBeNull();
  expect(within(market).queryByRole("button", { name: "Apps" })).toBeNull();
});
