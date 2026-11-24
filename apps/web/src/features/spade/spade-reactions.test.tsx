import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

/* Reactions and quoted replies both ways, against the fake Spade. */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const feed = () => screen.findByRole("feed", { name: "Conversation with Garden" });

function garden(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "garden", name: "Garden" });
}

test("the person reacts to a bot's message from the picker, and clicking their chip takes it back", async () => {
  const { spade } = await spadeApp("/spade/garden", (api) => {
    const bot = garden(api);
    api.store(bot.conversation, { type: "user_message", text: "When do I plant garlic?" });
    api.reply(bot, "In October.");
  });
  const chat = within(await feed());
  const run = await chat.findByRole("article", { name: "Garden" });
  await userEvent.click(within(run).getByRole("button", { name: "React" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "React 👍" }));
  const chip = await chat.findByRole("button", { name: "Remove your 👍 reaction" });
  expect(spade.eventsOf("c-garden").filter((event) => event.type === "reaction")).toEqual([
    { type: "reaction", message: "m3", emoji: "👍", by: "person" },
  ]);
  // Reacting starts no turn.
  expect(spade.eventsOf("c-garden").filter((event) => event.type === "reply_started")).toHaveLength(
    1,
  );
  await userEvent.click(chip);
  await waitFor(() => expect(chat.queryByRole("button", { name: /Remove your/ })).toBeNull());
});

test("a reaction the bot made shows under the person's message, and a person's message offers no React", async () => {
  await spadeApp("/spade/garden", (api) => {
    const bot = garden(api);
    api.store(bot.conversation, { type: "user_message", text: "Planted the garlic." });
    api.reply(bot, '<react to="m1">👍</react>\n<msg>Lovely, mulch it after.</msg>');
  });
  const chat = within(await feed());
  await chat.findByText("Lovely, mulch it after.");
  expect(await chat.findByLabelText("Reacted 👍")).toBeTruthy();
  const mine = chat.getByText("Planted the garlic.").closest("[data-spade-message]");
  expect(mine?.contains(chat.getByLabelText("Reacted 👍"))).toBe(true);
  expect(within(mine as HTMLElement).queryByRole("button", { name: "React" })).toBeNull();
});

test("the bot's reply to a message quotes it above its bubble, and the quote goes to the original", async () => {
  await spadeApp("/spade/garden", (api) => {
    const bot = garden(api);
    api.store(bot.conversation, { type: "user_message", text: "When do I plant garlic?" });
    api.reply(bot, '<msg reply="m1">In October.</msg>');
  });
  const chat = within(await feed());
  const quote = await chat.findByRole("button", {
    name: /Replying to You: When do I plant garlic\?/,
  });
  expect(quote.textContent).toContain("When do I plant garlic?");
});

test("answers to several messages each quote their own, and the latest answer stays unquoted", async () => {
  await spadeApp("/spade/garden", (api) => {
    const bot = garden(api);
    api.store(bot.conversation, { type: "user_message", text: "Plant garlic?" });
    api.store(bot.conversation, { type: "user_message", text: "Water the beans?" });
    api.store(bot.conversation, { type: "user_message", text: "Any frost?" });
    api.reply(
      bot,
      '<msg reply="m1">Yes, in October.</msg><msg reply="m2">Only when dry.</msg><msg>Frost on Friday.</msg>',
    );
  });
  const chat = within(await feed());
  await chat.findByText("Frost on Friday.");
  const quotes = chat.getAllByRole("button", { name: /^Replying to You/ });
  expect(quotes.map((quote) => quote.textContent)).toEqual([
    "YouPlant garlic?",
    "YouWater the beans?",
  ]);
});
