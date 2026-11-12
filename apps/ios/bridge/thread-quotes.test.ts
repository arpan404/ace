import { commands, connect, fixture, latest, open, reset, until } from "./thread-harness.ts";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { messageQuoteLimit } from "@ace/ui-core";
import { QuoteShelf } from "./thread-quotes.ts";

/*
 * Replying to part of an agent's message from the phone, over the real SDK and the fake daemon:
 * a picked passage shows over the composer and travels before the person's words.
 */

afterEach(reset);

const answer = "Run the finder first. It can double as the guard. Then the scripts.";
const at = (words: string) => {
  const start = answer.indexOf(words);
  return { start, end: start + words.length };
};

async function thread(shelf?: QuoteShelf) {
  const fake = fixture();
  fake.createThread({ id: "plan", workspaceId: "ace", title: "Plan", provider: "codex" });
  fake.apply("plan", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const owner = connect(fake);
  const session = open(owner, "plan", undefined, undefined, undefined, shelf);
  await until(() => latest("thread.controls"), "composer controls");
  return session;
}
const chips = () => (latest("thread.quotes")?.items ?? []) as { id: string; text: string }[];
/** The chips' words once the composer shows `count` of them. */
const shown = async (count: number) => {
  await until(() => chips().length === count || undefined, `${count} quotes over the composer`);
  return chips().map((chip) => chip.text);
};

test("a passage picked from an answer goes before the words, then leaves the composer", async () => {
  const session = await thread();
  session.handle({ type: "quote.add", message: answer, ...at("double as the guard") });
  expect(await shown(1)).toEqual(["double as the guard"]);

  session.handle({ type: "send", text: "Yes, do that", opposite: false, requestId: "reply" });
  await until(() => commands("thread.send").length === 1, "the message");
  const input = commands("thread.send")[0]?.input as { type: string; text: string }[];
  expect(input[0]?.text).toContain('Passage: "double as the guard"');
  expect(input[0]?.text).toContain("It can double as the guard. Then the scripts.");
  expect(input.at(-1)?.text).toBe("Yes, do that");
  expect(await shown(0)).toEqual([]);
});

test("a message of only a quote can be sent", async () => {
  const session = await thread();
  session.handle({ type: "quote.add", message: answer, ...at("Then the scripts") });
  session.handle({ type: "send", text: "", opposite: false, requestId: "bare" });
  await until(() => commands("thread.send").length === 1, "the message");
  const input = commands("thread.send")[0]?.input as { text: string }[];
  expect(input[0]?.text).toContain('Passage: "Then the scripts"');
});

test("a selection of only spaces adds no quote", async () => {
  const session = await thread();
  const gap = answer.indexOf(" ");
  session.handle({ type: "quote.add", message: answer, start: gap, end: gap + 1 });
  session.handle({ type: "quote.add", message: answer, ...at("the guard") });
  // Only the passage with words joined.
  expect(await shown(1)).toEqual(["the guard"]);
});

test("past the limit no more quotes join, and the composer is told it is full", async () => {
  const session = await thread();
  for (let index = 0; index <= messageQuoteLimit; index++)
    session.handle({ type: "quote.add", message: answer, ...at("the guard") });
  await shown(messageQuoteLimit);
  session.handle({ type: "quote.remove", id: chips()[0]?.id ?? "" });
  session.handle({ type: "quote.add", message: answer, ...at("the finder") });
  await until(() => chips().at(-1)?.text === "the finder", "the quote that fit");
  expect(chips()).toHaveLength(messageQuoteLimit);
  expect(latest("thread.quotes")?.full).toBe(true);
});

test("removing one quote keeps the rest, and clearing removes all", async () => {
  const session = await thread();
  session.handle({ type: "quote.add", message: answer, ...at("the finder") });
  session.handle({ type: "quote.add", message: answer, ...at("the scripts") });
  await shown(2);
  session.handle({ type: "quote.remove", id: chips()[0]?.id ?? "" });
  expect(await shown(1)).toEqual(["the scripts"]);
  session.handle({ type: "quote.clear" });
  expect(await shown(0)).toEqual([]);
});

test("a thread's quotes are still over its composer when it is opened again", async () => {
  const shelf = new QuoteShelf();
  const first = await thread(shelf);
  first.handle({ type: "quote.add", message: answer, ...at("the guard") });
  await shown(1);
  await reset();
  await thread(shelf);
  expect(await shown(1)).toEqual(["the guard"]);
});

test("the oldest thread's quotes are let go past the shelf's limit", () => {
  const shelf = new QuoteShelf(2);
  const quote = { id: "q", text: "x", before: "", after: "" };
  shelf.set("a", [quote]);
  shelf.set("b", [quote]);
  shelf.set("a", [quote]);
  shelf.set("c", [quote]);
  expect([shelf.get("a").length, shelf.get("b").length, shelf.get("c").length]).toEqual([1, 0, 1]);
});

test("each quote reaches the phone whole, for its draft to keep", async () => {
  const session = await thread();
  session.handle({ type: "quote.add", message: answer, ...at("double as the guard") });
  await shown(1);
  expect(latest("thread.quotes")?.kept).toEqual([
    {
      id: expect.any(String),
      text: "double as the guard",
      before: "Run the finder first. It can ",
      after: ". Then the scripts.",
    },
  ]);
});

test("quotes the phone kept with its draft rejoin the composer, never twice", async () => {
  const session = await thread();
  session.handle({ type: "quote.add", message: answer, ...at("the finder") });
  await shown(1);
  const [own] = (latest("thread.quotes")?.kept ?? []) as { id: string }[];
  const saved = { id: "saved-1", text: "the scripts", before: "Then ", after: "." };
  session.handle({ type: "quote.restore", quotes: [own, saved] });
  expect(await shown(2)).toEqual(["the finder", "the scripts"]);
  session.handle({ type: "send", text: "Both", opposite: false, requestId: "both" });
  await until(() => commands("thread.send").length === 1, "the message");
  const input = commands("thread.send")[0]?.input as { text: string }[];
  expect(input[0]?.text).toContain('[2] Passage: "the scripts"');
});
