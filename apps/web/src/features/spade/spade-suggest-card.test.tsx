import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import { findMarket, seed } from "../marketplace/market-test-seed.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

const withMarket = {
  daemon: (daemon: import("@ace/fake-daemon").FakeDaemon) =>
    daemon.seedServices({ marketplace: seed }),
};

/** The bot Travel suggests the market's Inbox package, as Spade makes the card. */
function suggesting(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const bot = api.addAgent({ id: "travel", name: "Travel" });
  api.card(bot, "s1", [
    {
      prompt: "You forward me booking mails every week",
      kind: "suggest",
      source: "market",
      package: "inbox",
      version: "1.0.0",
      name: "Inbox",
      face: { kind: "character", v: 1, body: "bird", pair: "sky", marking: "cap" },
      blurb: "Sorts your mail every morning.",
      publisher: { id: "pub-1", name: "mailworks" },
      can: ["Ask to use gmail", "Run on a schedule"],
    },
  ]);
  return bot;
}

const feed = async () =>
  within(await screen.findByRole("feed", { name: "Conversation with Travel" }));

const card = async () => within(await (await feed()).findByRole("group", { name: "Travel suggests Inbox" }));

test("a suggested package shows its signed face, publisher and asks, and Review install opens the install review", async () => {
  const { spade } = await spadeApp("/spade/travel", suggesting, withMarket);
  const shown = await card();
  expect(shown.getByText("Inbox")).toBeTruthy();
  expect(shown.getByText("By mailworks · Travel suggests it")).toBeTruthy();
  expect(shown.getByText("Sorts your mail every morning.")).toBeTruthy();
  expect(shown.getByText("You forward me booking mails every week")).toBeTruthy();
  expect(shown.getByText("Ask to use gmail")).toBeTruthy();
  expect(shown.getByText("Nothing is installed until you review it. Travel can't install it.")).toBeTruthy();

  await userEvent.click(shown.getByRole("button", { name: "Review install" }));
  // The Marketplace's own review, with its switches; nothing was installed or answered.
  const market = await findMarket();
  expect(await within(market).findByRole("switch", { name: "Gmail" })).toBeTruthy();
  expect(within(market).getByRole("button", { name: "Install" })).toBeTruthy();
  expect(spade.sent("POST", "/v1/conversations/c-travel/questions/s1")).toEqual([]);
});

test("Later folds the suggestion to one line and Not now tells the bot no", async () => {
  const { spade } = await spadeApp("/spade/travel", suggesting, withMarket);
  await userEvent.click((await card()).getByRole("button", { name: "Later" }));
  expect(spade.sent("POST", "/v1/conversations/c-travel/questions/s1")).toEqual([{ defer: true }]);
  const folded = await (await feed()).findByText("For later · Install Inbox");
  expect(folded).toBeTruthy();
  await userEvent.click((await feed()).getByRole("button", { name: "Review" }));
  await userEvent.click((await card()).getByRole("button", { name: "Not now" }));
  expect(spade.sent("POST", "/v1/conversations/c-travel/questions/s1")).toEqual([
    { defer: true },
    { dismiss: true },
  ]);
  expect(await (await feed()).findByText("Not installed · Inbox")).toBeTruthy();
});

test("an installed suggestion settles to one quiet line", async () => {
  await spadeApp(
    "/spade/travel",
    (api) => {
      const bot = suggesting(api);
      api.store(bot.conversation, {
        type: "question_answered",
        call_id: "s1",
        answers: [{ bot: "inbox-bot", name: "Inbox" }],
      });
    },
    withMarket,
  );
  expect(await (await feed()).findByText("Installed Inbox")).toBeTruthy();
});

test("a bot's notice shows its words as plain text and where it went", async () => {
  await spadeApp("/spade/travel", (api) => {
    withEndpoint(api);
    const bot = api.addAgent({ id: "travel", name: "Travel" });
    api.store(bot.conversation, {
      type: "notice_sent",
      call_id: "n1",
      id: "notice:c-travel:n1",
      title: "Fare dropped",
      body: "LIS to NRT is €612. Book at https://fares.example/deal",
      reach: "held",
      why: "quiet",
    });
  });
  const notice = within(
    await (await feed()).findByRole("group", { name: "Travel sent a notice: Fare dropped" }),
  );
  expect(notice.getByText("LIS to NRT is €612. Book at https://fares.example/deal")).toBeTruthy();
  expect(notice.queryByRole("link")).toBeNull();
  expect(notice.getByText("Held for your morning brief: quiet hours")).toBeTruthy();
});
