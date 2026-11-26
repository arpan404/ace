import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

/* ADR 0212 in the running chat: several short messages from one turn, a long one folded in place,
 * a document the bot wrote as a card, and replies both ways, against the fake Spade. */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

function garden(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "garden", name: "Garden" });
}

test("a turn of several messages coalesces into one block with its paragraphs, with no tag drawn", async () => {
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
  const bubbles = [...run.querySelectorAll("[data-part=spade-message]")];
  expect(bubbles).toHaveLength(1);
  expect(bubbles[0]?.textContent).toContain("October.");
  expect(bubbles[0]?.textContent).toContain("Mulch it after.");
  expect(bubbles[0]?.textContent).toContain("Want a reminder?");
  expect(chat.queryByText(/<\/?msg/)).toBeNull();
});

/** Layout jsdom doesn't do: a folded message's words draw `height` pixels tall. */
function drawnTall(height: number) {
  const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.parentElement?.dataset.part === "spade-fold"
      ? height
      : (real?.get?.call(this) ?? 0);
  });
}

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
  ...Array.from({ length: 20 }, (_, at) => `- Note ${at + 1}`),
  "",
  "South also throws in free delivery.",
].join("\n");

test("a long reply stays one message with every word, and no document card", async () => {
  drawnTall(900);
  await spadeApp("/spade/garden", (spade) => spade.reply(garden(spade), report));
  const chat = within(await feed("Garden"));
  expect(await chat.findByText("South also throws in free delivery.")).toBeTruthy();
  expect(chat.getByRole("table")).toBeTruthy();
  expect(chat.queryByRole("group", { name: "Prices" })).toBeNull();
  expect(chat.getAllByRole("article", { name: "Garden" })).toHaveLength(1);
});

test("Show more reveals the rest of a long reply and Show less folds it", async () => {
  drawnTall(900);
  await spadeApp("/spade/garden", (spade) => spade.reply(garden(spade), report));
  const chat = within(await feed("Garden"));
  const more = await chat.findByRole("button", { name: "Show more" });
  const fold = document.getElementById(more.getAttribute("aria-controls") ?? "");
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(fold?.hasAttribute("data-folded")).toBe(true);
  await userEvent.click(more);
  const less = chat.getByRole("button", { name: "Show less" });
  expect(less.getAttribute("aria-expanded")).toBe("true");
  expect(fold?.hasAttribute("data-folded")).toBe(false);
  await userEvent.click(less);
  expect(chat.getByRole("button", { name: "Show more" })).toBeTruthy();
  expect(fold?.hasAttribute("data-folded")).toBe(true);
});

test("a reply that draws within ten lines offers no Show more", async () => {
  drawnTall(200);
  await spadeApp("/spade/garden", (spade) => spade.reply(garden(spade), report));
  const chat = within(await feed("Garden"));
  await chat.findByText("South also throws in free delivery.");
  expect(chat.queryByRole("button", { name: "Show more" })).toBeNull();
});

test("a <doc> the bot wrote is still a document card whose Open shows every word", async () => {
  await spadeApp("/spade/garden", (spade) =>
    spade.reply(
      garden(spade),
      '<msg>Here it is.</msg><doc title="Supplier prices">| Supplier | Price |\n| --- | --- |\n| South | €38 |</doc>',
    ),
  );
  const chat = within(await feed("Garden"));
  const card = await chat.findByRole("group", { name: "Supplier prices" });
  await userEvent.click(within(card).getByRole("button", { name: "Open" }));
  const sheet = await screen.findByRole("dialog", { name: "Supplier prices" });
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
  // The words show at once; their frame carries the message's id once it is stored.
  const frame = await waitFor(() => {
    const found = chat.getByText("Tuesday or Wednesday?").closest("[data-spade-message]");
    if (!(found instanceof HTMLElement)) throw new Error("expected the message's frame");
    return found;
  });
  await userEvent.click(within(frame).getByRole("button", { name: "Reply" }));
  const strip = await screen.findByRole("status", { name: "Replying to Garden" });
  // It is the composer's own line, which opens the capsule, never a strip loose over the chat.
  const composer = strip.closest("[data-slot=composer]");
  expect(composer?.contains(screen.getByRole("combobox", { name: "Message Garden" }))).toBe(true);
  expect(composer?.hasAttribute("data-pill")).toBe(false);
  await userEvent.type(screen.getByRole("combobox", { name: "Message Garden" }), "Tuesday{Enter}");
  // The strip goes once it is sent, and the bubble quotes the message it answers.
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Replying to Garden" })).toBeNull(),
  );
  await chat.findByRole("button", {
    name: "You replied to Garden: Tuesday or Wednesday?. Show the message",
  });
  const quote = chat.getByRole("button", {
    name: "You replied to Garden: Tuesday or Wednesday?. Show the message",
  });
  const pill = chat.getByText("Tuesday").closest("[data-part=spade-message]");
  // The ghost sits above the reply's pill, not inside it.
  expect(pill?.contains(quote)).toBe(false);
  expect(
    quote.compareDocumentPosition(pill as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
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

test("clicking a quote inside a bubble goes to the original and lights it a moment", async () => {
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  await spadeApp("/spade/garden", (spade) => {
    const bot = garden(spade);
    spade.store(bot.conversation, { type: "user_message", text: "Can you book the 9:10?" });
    spade.reply(bot, '<msg>Looking.</msg><msg reply="m1">Booked the 9:10.</msg>');
  });
  const chat = within(await feed("Garden"));
  const quote = await chat.findByRole("button", {
    name: "Replied to you: Can you book the 9:10?. Show the message",
  });
  const bubble = chat.getByText("Booked the 9:10.").closest("[data-part=spade-message]");
  // The ghost sits above the reply's bubble.
  expect(bubble?.contains(quote)).toBe(false);
  await userEvent.click(quote);
  const original = document.querySelector('[data-spade-message="m1"]');
  expect(original?.textContent).toContain("Can you book the 9:10?");
  expect(scrolled).toHaveBeenCalled();
  expect(scrolled.mock.contexts[0]).toBe(original);
  expect(original?.hasAttribute("data-lit")).toBe(true);
});
