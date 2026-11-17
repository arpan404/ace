import { marketPickFixture, marketPublishFixture, type FakeDaemon } from "@ace/fake-daemon";
import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { findMarket, openApp } from "./market-test-seed.ts";

/* The publish flow's picker (ADR 0174 §2): the person's own bots, skills and plugins. */

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

const typeButton = {
  bot: /A recipe: face, task, routines/,
  skill: /Instructions and scripts a bot can use/,
  plugin: /Commands and tools for agents and bots/,
};

const lastSource = (daemon: FakeDaemon) => daemon.marketplace.publishing.sources.at(-1);

test.each([
  {
    type: "bot" as const,
    pick: "Inbox sorter",
    others: [],
    sent: { type: "spade-bot", name: "inbox-sorter", source: { kind: "spade-bot", id: "a_inbox" } },
  },
  {
    type: "skill" as const,
    pick: "Triage mail",
    others: ["release-notes"],
    sent: {
      type: "spade-skill",
      name: "triage-mail",
      source: { kind: "ace-skill", id: `skl_${"a".repeat(40)}` },
    },
  },
  {
    type: "plugin" as const,
    pick: "mail-tools",
    others: [],
    sent: {
      type: "spade-plugin",
      name: "mail-tools",
      source: { kind: "plugin", name: "mail-tools" },
    },
  },
])("a $type is picked from your own, and its draft names what was picked", async (each) => {
  const { daemon } = await openApp("/chats?market=publish", {
    publishing: marketPublishFixture(),
    pick: marketPickFixture(),
  });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: typeButton[each.type] }));
  const yours = within(await within(market).findByRole("group", { name: "Yours" }));
  for (const other of each.others) expect(yours.getByText(other)).toBeTruthy();
  const next = within(market).getByRole("button", { name: "Next" });
  expect(next.hasAttribute("disabled")).toBe(true);

  await userEvent.click(yours.getByRole("button", { name: new RegExp(each.pick) }));
  await waitFor(() => expect(next.hasAttribute("disabled")).toBe(false));
  await userEvent.click(next);

  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  expect(lastSource(daemon)).toEqual(each.sent);
});

test("a bot shows its recipe's routines and needs before Next, and only its id is sent", async () => {
  const { daemon } = await openApp("/chats?market=publish", {
    publishing: marketPublishFixture(),
    pick: marketPickFixture(),
  });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: typeButton.bot }));
  const yours = within(await within(market).findByRole("group", { name: "Yours" }));
  const card = yours.getByRole("button", { name: /Inbox sorter/ });
  expect(card.textContent).toContain("You look after the person's inbox.");
  await userEvent.click(card);

  const recipe = within(await within(market).findByRole("region", { name: "Its recipe" }));
  const routines = within(recipe.getByRole("list", { name: "Routines" }));
  expect(routines.getByText("Morning sort")).toBeTruthy();
  expect(routines.getByText("weekdays at 8:00")).toBeTruthy();
  const needs = within(recipe.getByRole("list", { name: "What it asks for" }));
  expect(needs.getByText("gmail")).toBeTruthy();
  expect(needs.getByText("Gmail is allowed for this bot.")).toBeTruthy();
  expect(recipe.getByText("triage-mail")).toBeTruthy();
  expect(recipe.getByText("mail-tools")).toBeTruthy();
  expect(recipe.getByText(/The routine "Hook" doesn't run on a schedule/)).toBeTruthy();
  expect(recipe.getByText(/keys, tokens, notes and the access you gave it stay/)).toBeTruthy();

  await userEvent.click(within(market).getByRole("button", { name: "Next" }));
  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  // The app names the bot; the daemon reads its recipe from Spade, so no recipe text crosses here.
  expect(lastSource(daemon)?.source).toEqual({ kind: "spade-bot", id: "a_inbox" });
});

test("a bot whose recipe Spade refuses holds Next and says why", async () => {
  const pick = marketPickFixture();
  pick.recipes = {};
  await openApp("/chats?market=publish", { publishing: marketPublishFixture(), pick });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: typeButton.bot }));
  const yours = within(await within(market).findByRole("group", { name: "Yours" }));
  await userEvent.click(yours.getByRole("button", { name: /Inbox sorter/ }));

  expect(await within(market).findByText("no such agent")).toBeTruthy();
  expect(within(market).getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
});

test("Choose a folder… still publishes a folder by path, under a name", async () => {
  const { daemon } = await openApp("/chats?market=publish", {
    publishing: marketPublishFixture(),
    pick: marketPickFixture(),
  });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: typeButton.skill }));
  await within(market).findByRole("group", { name: "Yours" });
  await userEvent.click(within(market).getByRole("button", { name: "Choose a folder…" }));
  await userEvent.type(within(market).getByLabelText("Name in the marketplace"), "sort-receipts");
  await userEvent.type(within(market).getByLabelText("Folder on this machine"), "/Users/me/sort");
  await userEvent.click(within(market).getByRole("button", { name: "Next" }));

  expect(await within(market).findByText("Passes ace's checks.")).toBeTruthy();
  expect(lastSource(daemon)).toEqual({
    type: "spade-skill",
    name: "sort-receipts",
    source: { kind: "folder", path: "/Users/me/sort" },
  });
});

test("an empty list says so, and a place that can't be read says why", async () => {
  await openApp("/chats?market=publish", {
    publishing: marketPublishFixture(),
    pick: {
      items: [],
      unavailable: { "spade-bot": ["Spade's bots can't be listed: Spade isn't running."] },
    },
  });
  const market = await findMarket();
  await userEvent.click(await within(market).findByRole("button", { name: typeButton.bot }));
  expect(
    await within(market).findByText("Spade's bots can't be listed: Spade isn't running."),
  ).toBeTruthy();
  expect(within(market).getByText("You don't have a bot in Spade yet.")).toBeTruthy();
});
