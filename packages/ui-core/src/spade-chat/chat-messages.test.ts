import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeView,
  type SpadeBubble,
} from "./index.ts";

/* ADR 0212: a turn's words as several short messages, long words as a document card, and quotes
 * both ways, through the fold a client runs on Spade's stored events and live text. */

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const frame = (kind: string, body: unknown) => {
    const input = parseSpadeLiveFrame(kind, JSON.stringify(body));
    if (input) foldSpade(state, input);
  };
  return {
    stored: (event: Record<string, unknown>) =>
      frame("stored", { seq: ++seq, at: 1_000 + seq, event }),
    delta: (reply: string, text: string) => frame("delta", { reply, text }),
    view: () => spadeView(state),
    bubbles: () => spadeBubbles(spadeView(state)),
  };
}

type Bot = Extract<SpadeBubble, { kind: "bot" }>;
const bots = (bubbles: SpadeBubble[]) =>
  bubbles.filter((bubble): bubble is Bot => bubble.kind === "bot");

describe("a turn of several messages", () => {
  test("shows each as its own bubble, in order, as the words arrive, and stays working until it ends", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Any cheap flights to Lisbon?" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.delta("r1", "<msg>Found 3 flights under €100.</msg>\n<msg>The cheapest");
    expect(bots(c.bubbles()).map((b) => [b.text, b.live])).toEqual([
      ["Found 3 flights under €100.", false],
      ["The cheapest", true],
    ]);
    // A finished bubble doesn't finish the turn: the bot is working until its last message.
    expect(c.view().busy).toBe(true);
    c.delta("r1", " leaves Tuesday at 9:10.</msg>\n<msg>Want me to hold it?</ms");
    expect(bots(c.bubbles()).map((b) => b.text)).toEqual([
      "Found 3 flights under €100.",
      "The cheapest leaves Tuesday at 9:10.",
      "Want me to hold it?",
    ]);
    expect(c.view().busy).toBe(true);
    const words =
      "<msg>Found 3 flights under €100.</msg>\n<msg>The cheapest leaves Tuesday at 9:10.</msg>\n<msg>Want me to hold it?</msg>";
    c.stored({ type: "step_finished", reply: "r1", text: words });
    c.stored({ type: "reply_finished", reply: "r1", text: words });
    const done = bots(c.bubbles());
    expect(done.map((b) => [b.text, b.live, b.id])).toEqual([
      ["Found 3 flights under €100.", false, "m3"],
      ["The cheapest leaves Tuesday at 9:10.", false, "m3.2"],
      ["Want me to hold it?", false, "m3.3"],
    ]);
    expect(c.view().busy).toBe(false);
    // No tag is ever drawn.
    for (const bubble of done) expect(bubble.text).not.toContain("<");
  });

  test("keeps the keys the bubbles streamed under once the step is stored", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.delta("r1", "<msg>One.</msg><msg>Two");
    const live = bots(c.bubbles()).map((b) => b.key);
    c.stored({ type: "step_finished", reply: "r1", text: "<msg>One.</msg><msg>Two.</msg>" });
    expect(bots(c.bubbles()).map((b) => b.key)).toEqual(live);
  });
});

describe("long words", () => {
  const report = [
    "Here's what I found across the three suppliers.",
    "",
    "## Prices",
    "",
    "| Supplier | Price |",
    "| --- | --- |",
    "| North | €40 |",
    "| South | €38 |",
  ].join("\n");

  test("a reply with a heading or a table shows its first paragraph and a card holding all of it", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: report });
    const [bubble] = bots(c.bubbles());
    expect(bubble?.text).toBe("Here's what I found across the three suppliers.");
    expect(bubble?.doc).toMatchObject({ title: "Prices", text: report });
    expect(bubble?.doc?.preview).toContain("North");
  });

  test("a reply over twelve lines becomes a card too, and a short one stays a bubble", () => {
    const long = Array.from({ length: 14 }, (_, at) => `Line ${at + 1}`).join("\n");
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: long });
    c.stored({ type: "reply_finished", reply: "r1", text: long });
    c.stored({ type: "reply_started", reply: "r2" });
    c.stored({ type: "step_finished", reply: "r2", text: "Short and sweet." });
    const [first, second] = bots(c.bubbles());
    expect(first?.doc?.text).toBe(long);
    expect(first?.doc?.title).toBe("Full reply");
    expect(second).toMatchObject({ text: "Short and sweet." });
    expect(second?.doc).toBeUndefined();
  });

  test("a document the bot wrote is a card with its title and no bubble of words", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: '<msg>Plan is ready.</msg><doc title="Lisbon trip plan">Day 1: Alfama.\nDay 2: Belém.</doc>',
    });
    expect(bots(c.bubbles()).map((b) => [b.text, b.doc?.title, b.doc?.text])).toEqual([
      ["Plan is ready.", undefined, undefined],
      ["", "Lisbon trip plan", "Day 1: Alfama.\nDay 2: Belém."],
    ]);
  });
});

describe("replies", () => {
  test("the person's reply shows the message it quoted, as Spade stored it", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "<msg>Tuesday or Wednesday?</msg>" });
    c.stored({ type: "reply_finished", reply: "r1", text: "" });
    c.stored({
      type: "user_message",
      text: "Tuesday",
      reply_to: { id: "m2", text: "Tuesday or Wednesday?", mine: false },
    });
    const mine = c.bubbles().find((bubble) => bubble.kind === "person");
    expect(mine).toMatchObject({
      id: "m4",
      quote: { id: "m2", who: { kind: "bot" }, text: "Tuesday or Wednesday?" },
    });
  });

  test("a reply_to this client can't read is no quote, and the message still shows", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Hello", reply_to: { id: 7, text: ["x"] } });
    const mine = c.bubbles().find((bubble) => bubble.kind === "person");
    expect(mine).toMatchObject({ text: "Hello" });
    expect(mine && "quote" in mine && mine.quote).toBeFalsy();
  });

  test("the bot's reply quotes an earlier message of the chat, and an unknown or later one quotes nothing", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Can you book the 9:10?" });
    c.stored({ type: "user_message", text: "Also, is breakfast included?" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: '<msg reply="m1">Booked the 9:10.</msg><msg reply="m2">Yes, breakfast is in.</msg><msg reply="m99">Anything else?</msg><msg reply="m4.5">Bye.</msg>',
    });
    expect(bots(c.bubbles()).map((b) => b.quote)).toEqual([
      { id: "m1", who: { kind: "person" }, text: "Can you book the 9:10?" },
      { id: "m2", who: { kind: "person" }, text: "Also, is breakfast included?" },
      undefined,
      undefined,
    ]);
  });

  test("the bot can quote its own earlier message by its id", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "<msg>One.</msg><msg>Two.</msg>" });
    c.stored({ type: "reply_finished", reply: "r1", text: "" });
    c.stored({ type: "reply_started", reply: "r2" });
    c.stored({ type: "step_finished", reply: "r2", text: '<msg reply="m2.2">About that.</msg>' });
    expect(bots(c.bubbles()).at(-1)?.quote).toEqual({
      id: "m2.2",
      who: { kind: "bot" },
      text: "Two.",
    });
  });
});

describe("another bot's message", () => {
  test("splits into its messages, each one the person can reply to by that bot's name", () => {
    const c = conversation();
    c.stored({
      type: "user_message",
      text: '<msg>Fares are up.</msg><msg reply="m9">TAP is €212.</msg>',
      from_agent: { id: "quill", name: "Quill" },
    });
    c.stored({
      type: "user_message",
      text: "Skip TAP then",
      reply_to: { id: "m1.2", text: "TAP is €212.", mine: false, name: "Quill" },
    });
    const bubbles = c.bubbles();
    const others = bubbles.filter((bubble) => bubble.kind === "other");
    // Its quote names a message of its own conversation, foreign here, so it drops.
    expect(others.map((b) => [b.text, b.id, "quote" in b])).toEqual([
      ["Fares are up.", "m1", false],
      ["TAP is €212.", "m1.2", false],
    ]);
    expect(bubbles.find((bubble) => bubble.kind === "person")).toMatchObject({
      quote: { id: "m1.2", who: { kind: "member", name: "Quill" }, text: "TAP is €212." },
    });
  });
});
