import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

/* ADR 0212 in the running chat: several short messages from one turn, long words as a document
 * card, and replies both ways, against the fake Spade. */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

function garden(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "garden", name: "Garden" });
}

test("a turn of several messages shows each as its own bubble, with no tag drawn", async () => {
  await spadeApp("/spade/garden", (spade) => {
    const bot = garden(spade);
    spade.store(bot.conversation, { type: "user_message", text: "When do I plant garlic?" });
    spade.reply(
      bot,
      "<msg>October.</msg>\n<msg>Mulch it after.</msg>\n<msg>Want a reminder?</msg>",
    );
  });
  const chat = within(await feed("Garden"));
  await chat.findByText("Want a reminder?");
  const run = chat.getByRole("article", { name: "Garden" });
  expect(
    [...run.querySelectorAll("[data-part=spade-message]")].map((bubble) =>
      bubble.textContent?.trim(),
    ),
  ).toEqual(["October.", "Mulch it after.", "Want a reminder?"]);
  expect(chat.queryByText(/<\/?msg/)).toBeNull();
});

test("a long reply shows its first paragraph and a document card whose Open shows every word", async () => {
  const report = [
    "Three suppliers can deliver by Friday.",
    "",
    "## Prices",
    "",
    "| Supplier | Price |",
    "| --- | --- |",
    "| North | €40 |",
    "| South | €38 |",
    "",
    "South also throws in free delivery.",
  ].join("\n");
  await spadeApp("/spade/garden", (spade) => spade.reply(garden(spade), report));
  const chat = within(await feed("Garden"));
  expect(await chat.findByText("Three suppliers can deliver by Friday.")).toBeTruthy();
  // The rest is not in the chat, but in the card.
  expect(chat.queryByText("South also throws in free delivery.")).toBeNull();
  const card = chat.getByRole("group", { name: "Prices" });
  await userEvent.click(within(card).getByRole("button", { name: "Open" }));
  const sheet = await screen.findByRole("dialog", { name: "Prices" });
  expect(within(sheet).getByText("South also throws in free delivery.")).toBeTruthy();
  expect(within(sheet).getByRole("table")).toBeTruthy();
});

test("Reply on a bot's message shows it above the composer, and the sent message quotes it", async () => {
  let api: FakeSpadeApi | undefined;
  await spadeApp("/spade/garden", (spade) => {
    api = spade;
    const bot = garden(spade);
    spade.reply(bot, "<msg>Tuesday or Wednesday?</msg>");
  });
  const chat = within(await feed("Garden"));
  const asked = await chat.findByText("Tuesday or Wednesday?");
  const frame = asked.closest("[data-spade-message]");
  if (!(frame instanceof HTMLElement)) throw new Error("expected the message's frame");
  await userEvent.click(within(frame).getByRole("button", { name: "Reply" }));
  expect(await screen.findByRole("status", { name: "Replying to Garden" })).toBeTruthy();
  await userEvent.type(screen.getByRole("combobox", { name: "Message Garden" }), "Tuesday{Enter}");
  // The strip goes once it is sent, and the bubble quotes the message it answers.
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Replying to Garden" })).toBeNull(),
  );
  const quote = await chat.findByRole("button", {
    name: "Replying to Garden: Tuesday or Wednesday?. Show the message",
  });
  expect(quote).toBeTruthy();
  // Spade stored what it quoted with the message, which is what the bot reads.
  const conversation = api?.agents.find((agent) => agent.id === "garden")?.conversation ?? "";
  await waitFor(() =>
    expect(api?.eventsOf(conversation).at(-1)).toMatchObject({
      type: "user_message",
      text: "Tuesday",
      reply_to: { id: frame.dataset.spadeMessage, text: "Tuesday or Wednesday?", mine: false },
    }),
  );
});

test("clicking a quote goes to the original and lights it a moment", async () => {
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  await spadeApp("/spade/garden", (spade) => {
    const bot = garden(spade);
    spade.store(bot.conversation, { type: "user_message", text: "Can you book the 9:10?" });
    spade.reply(bot, '<msg>Looking.</msg><msg reply="m1">Booked the 9:10.</msg>');
  });
  const chat = within(await feed("Garden"));
  const quote = await chat.findByRole("button", {
    name: "Replying to You: Can you book the 9:10?. Show the message",
  });
  await userEvent.click(quote);
  const original = document.querySelector('[data-spade-message="m1"]');
  expect(original?.textContent).toContain("Can you book the 9:10?");
  expect(scrolled).toHaveBeenCalled();
  expect(scrolled.mock.contexts[0]).toBe(original);
  expect(original?.hasAttribute("data-lit")).toBe(true);
});
