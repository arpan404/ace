import type { MarketReview } from "@ace/protocol/marketplace";
import { configure, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { entry, findMarket, openApp } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

/*
 * An agent package's review (ADR 0200 §3.4, §6.1): each declared effect a switch with its reason,
 * only what the person leaves on sent with Install; an update says what changes, what stays
 * because the person changed it and what asks for more; a rollback says where it goes back to.
 */

const effects = [
  {
    key: "network:hosts:api.example-fares.com",
    effect: "network" as const,
    hosts: ["api.example-fares.com"],
    why: "Reads fares.",
  },
  {
    key: "send_as_person",
    effect: "send_as_person" as const,
    why: "Drafts a mail to your travel agent. You send it.",
  },
];

const body = {
  type: "spade-bot" as const,
  botName: "Flight watcher",
  task: "You watch flight fares for the person.",
  model: "fast" as const,
  routines: [{ name: "Morning check", instruction: "Check fares.", schedule: "daily at 7:00" }],
  notes: [],
  brings: [],
  needs: [],
  spadeReady: true,
  linked: true,
  effects,
  triggers: [{ kind: "webhook" as const, name: "Fare feed", instruction: "Read the posted fare." }],
  limits: { spend_alert: { usd_per_day: 0.5 } },
};

const watcher = (review: Partial<MarketReview>) => ({
  summary: entry("spade-bot", "flight-watcher", "Flight watcher"),
  review,
});

const installed = (version: string) => ({
  source: "market" as const,
  type: "spade-bot" as const,
  name: "flight-watcher",
  title: "Flight watcher",
  version,
  hash: "a".repeat(64),
  acceptedAt: 1,
  state: "on" as const,
  target: "bot_1",
  linked: true,
});

const strong = [
  ...effects,
  { key: "publish", effect: "publish" as const, why: "Posts a weekly fare report." },
  {
    key: "network:drive_site:www.example-air.com",
    effect: "network" as const,
    grant: { kind: "drive_site" as const, host: "www.example-air.com" },
    why: "Fills in the airline's search form.",
  },
];

const checked = (market: HTMLElement, name: string) =>
  within(market).getByRole("switch", { name }).getAttribute("aria-checked");

test("a stranger's package starts with only its declared hosts on, and only what is left on is sent", async () => {
  const { daemon } = await openApp("/chats?market=bot/flight-watcher/review", {
    entries: [watcher({ byAce: false, body: { ...body, effects: strong } })],
  });
  const market = await findMarket();
  await within(market).findByRole("switch", { name: "Reaches api.example-fares.com" });
  expect(checked(market, "Reaches api.example-fares.com")).toBe("true");
  // Acting as the person, publishing and sending in their name start off.
  expect(checked(market, "Can ask you to send things in your name")).toBe("false");
  expect(checked(market, "Publishes and posts")).toBe("false");
  expect(checked(market, "Acts in pages on www.example-air.com as you")).toBe("false");
  expect(within(market).getByText(/It isn't made by ace, so only reaching the sites/)).toBeTruthy();
  // A send the person turns on still asks each time.
  expect(within(market).getByText(/You send it\. You decide each time\./)).toBeTruthy();
  expect(
    within(market).getByText("Expected to cost about $0.50 a day on your fast model."),
  ).toBeTruthy();
  // Its webhook is a routine too, paused until Start its routines.
  expect(within(market).getByText("When something on this machine posts to it")).toBeTruthy();

  await userEvent.click(
    within(market).getByRole("switch", { name: "Can ask you to send things in your name" }),
  );
  await userEvent.click(within(market).getByRole("button", { name: "Install" }));
  await expect
    .poll(() => daemon.marketplace.accepted[0]?.choices.effects)
    .toEqual({
      "network:hosts:api.example-fares.com": true,
      send_as_person: true,
      publish: false,
      "network:drive_site:www.example-air.com": false,
    });
});

test("a package's own code is a row per component, on unless the person turns it off", async () => {
  const code = [
    {
      name: "fares",
      imports: ["spade:package/tools" as const, "spade:package/http" as const],
      why: "Parses fare tables and picks the cheapest.",
      sentence:
        "Runs its own code: fares. It can reach api.example-fares.com and call Spade's tools as this bot.",
    },
    {
      name: "dates",
      imports: [],
      why: "Works out dates.",
      sentence: "Runs its own code: dates. It reaches nothing outside itself.",
    },
  ];
  const { daemon } = await openApp("/chats?market=bot/flight-watcher/review", {
    entries: [watcher({ byAce: false, body: { ...body, code } })],
  });
  const market = await findMarket();
  await within(market).findByRole("switch", { name: "Run fares" });
  expect(within(market).getByText("Runs its own code")).toBeTruthy();
  expect(within(market).getByText(code[0]!.sentence)).toBeTruthy();
  expect(within(market).getByText("Parses fare tables and picks the cheapest.")).toBeTruthy();
  expect(checked(market, "Run fares")).toBe("true");
  expect(checked(market, "Run dates")).toBe("true");
  await userEvent.click(within(market).getByRole("switch", { name: "Run dates" }));
  await userEvent.click(within(market).getByRole("button", { name: "Install" }));
  await expect
    .poll(() => daemon.marketplace.accepted[0]?.choices.effects)
    .toMatchObject({ "code:fares": true, "code:dates": false });
});

test("a package by ace starts with what it declares on", async () => {
  await openApp("/chats?market=bot/flight-watcher/review", {
    entries: [watcher({ byAce: true, body: { ...body, effects: strong } })],
  });
  const market = await findMarket();
  await within(market).findByRole("switch", { name: "Publishes and posts" });
  for (const name of [
    "Reaches api.example-fares.com",
    "Can ask you to send things in your name",
    "Publishes and posts",
    "Acts in pages on www.example-air.com as you",
  ])
    expect(checked(market, name)).toBe("true");
  expect(within(market).queryByText(/It isn't made by ace/)).toBeNull();
});

test("an update says what changes, what stays because you changed it, and what starts off", async () => {
  await openApp("/chats?market=bot/flight-watcher/update", {
    entries: [
      watcher({
        version: "2.0.0",
        updates: "1.0.0",
        body: {
          ...body,
          effects: [
            ...effects,
            { key: "publish", effect: "publish", why: "Posts a weekly fare report." },
          ],
          update: {
            bot: "bot_1",
            rollback: false,
            plan: {
              name: "same",
              task: "kept",
              face: "same",
              personality: "same",
              routines: [{ step: "add", name: "Evening check" }],
              notes_kept: 0,
              asks_more: ["publish"],
              off: [],
            },
            asksMore: ["It starts when something posts to it on this machine."],
          },
        },
      }),
    ],
    installed: [{ ...installed("1.0.0"), update: "2.0.0" }],
  });
  const market = await findMarket();
  const stays = await within(market).findByRole("list", { name: "Stays because you changed it" });
  expect(within(stays).getByText("You changed its task, so this update leaves it.")).toBeTruthy();
  const changes = within(market).getByRole("list", { name: "What changes" });
  expect(
    within(changes).getByText("Adds the routine Evening check, paused until you start it."),
  ).toBeTruthy();
  const more = within(market).getByRole("list", { name: "Asks for more" });
  expect(within(more).getByText("Publishes and posts. Off until you turn it on.")).toBeTruthy();
  // Nothing new is switched on here: no effect switches on an update.
  expect(within(market).queryByRole("switch", { name: "Publishes and posts" })).toBeNull();
  expect(within(market).getByRole("button", { name: "Update" })).toBeTruthy();
});

test("an update says how the bot's kept runs replay on the new version, and why one differs", async () => {
  await openApp("/chats?market=bot/flight-watcher/update", {
    entries: [
      watcher({
        version: "2.0.0",
        updates: "1.0.0",
        body: {
          ...body,
          update: {
            bot: "bot_1",
            rollback: false,
            plan: {
              name: "same",
              task: "same",
              face: "same",
              personality: "same",
              routines: [],
              notes_kept: 0,
              asks_more: [],
              off: [],
            },
            asksMore: [],
            replay: {
              summary: "1 of 2 kept runs replay the same. 1 doesn't: see why.",
              passed: 1,
              failed: 1,
              cases: [
                { id: "case_1", given: "Check fares", passed: true, lines: [] },
                {
                  id: "case_2",
                  given: "Mail my agent the fare",
                  passed: false,
                  lines: ["send_message was refused: Flight watcher doesn't declare sending."],
                },
              ],
            },
          },
        },
      }),
    ],
    installed: [{ ...installed("1.0.0"), update: "2.0.0" }],
  });
  const market = await findMarket();
  expect(
    await within(market).findByText("1 of 2 kept runs replay the same. 1 doesn't: see why."),
  ).toBeTruthy();
  await userEvent.click(within(market).getByRole("button", { name: "See why" }));
  const differ = within(within(market).getByRole("list", { name: "Kept runs that differ" }));
  expect(differ.getByText("Mail my agent the fare")).toBeTruthy();
  expect(
    differ.getByText("send_message was refused: Flight watcher doesn't declare sending."),
  ).toBeTruthy();
});

test("a rollback says where it goes back to, from the copy on this machine", async () => {
  await openApp("/chats?market=bot/flight-watcher/rollback", {
    entries: [
      watcher({
        version: "1.0.0",
        updates: "2.0.0",
        body: {
          ...body,
          update: {
            bot: "bot_1",
            rollback: true,
            plan: {
              name: "same",
              task: "replace",
              face: "same",
              personality: "same",
              routines: [{ step: "remove", name: "Evening check" }],
              notes_kept: 0,
              asks_more: [],
              off: ["publish"],
            },
            asksMore: [],
          },
        },
      }),
    ],
    installed: [{ ...installed("2.0.0"), previous: { version: "1.0.0", hash: "b".repeat(64) } }],
  });
  const market = await findMarket();
  expect(
    await within(market).findByText(
      "Goes back to version 1.0.0 from 2.0.0, from the copy kept on this machine.",
    ),
  ).toBeTruthy();
  expect(within(market).getByText("Removes the routine Evening check.")).toBeTruthy();
  expect(within(market).getByRole("button", { name: "Roll back" })).toBeTruthy();
});
