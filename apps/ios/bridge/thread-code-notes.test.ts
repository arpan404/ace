import { commands, connect, fixture, latest, open, reset, until } from "./thread-harness.ts";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";

/*
 * Notes the person pinned to code in the phone's editor, over the real SDK and the fake daemon:
 * the phone keeps them and hands the open thread the whole list; Send carries one
 * `<code_annotations>` block after the person's words, and says which notes it took.
 */

afterEach(reset);

async function thread() {
  const fake = fixture();
  fake.createThread({ id: "plan", workspaceId: "ace", title: "Plan", provider: "codex" });
  fake.apply("plan", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const owner = connect(fake);
  const session = open(owner, "plan");
  await until(() => latest("thread.controls"), "composer controls");
  return session;
}

const note = (
  id: string,
  number: number,
  path: string,
  lines: [number, number],
  comment: string,
  excerpt: string,
) => ({
  id,
  number,
  path,
  start: { line: lines[0], column: 2 },
  end: { line: lines[1], column: 12 },
  excerpt,
  comment,
});

const sentText = () =>
  ((commands("thread.send")[0]?.input ?? []) as { type: string; text: string }[])
    .map((part) => part.text)
    .join("");

test("two notes made on the phone reach the agent as one request with both ranges", async () => {
  const session = await thread();
  session.handle({
    type: "code.set",
    notes: [
      note("a", 1, "src/cart/total.ts", [1, 2], "Sum the prices", "let sum = 0;\n  return sum"),
      note("b", 2, "src/cart/view.tsx", [4, 4], "Render the items", "<ul />"),
    ],
  });
  session.handle({ type: "send", text: "Two things", opposite: false, requestId: "both" });
  await until(() => commands("thread.send").length === 1, "the message");

  const text = sentText();
  expect(text.startsWith("Two things")).toBe(true);
  expect(text).toContain('<code_annotations version="1" count="2">');
  const one = text.indexOf("[1] src/cart/total.ts:2-3");
  const two = text.indexOf("[2] src/cart/view.tsx:5");
  expect(one).toBeGreaterThan(0);
  expect(two).toBeGreaterThan(one);
  expect(text).toContain("Comment: Sum the prices\nCode:\n```\nlet sum = 0;\n  return sum\n```");
  expect(text).toContain("Comment: Render the items\nCode:\n```\n<ul />\n```");
  // The phone hears which notes went, so it drops only those.
  await until(() => latest("thread.codeSent"), "the notes that went");
  expect(latest("thread.codeSent")?.ids).toEqual(["a", "b"]);
});

test("a message of only notes can be sent", async () => {
  const session = await thread();
  session.handle({ type: "code.set", notes: [note("a", 1, "a.ts", [0, 0], "Why?", "x")] });
  session.handle({ type: "send", text: "", opposite: false, requestId: "bare" });
  await until(() => commands("thread.send").length === 1, "the message");
  expect(sentText()).toContain("[1] a.ts:1");
});

test("notes the phone cleared don't go, and an unreadable note is dropped, not the rest", async () => {
  const session = await thread();
  session.handle({ type: "code.set", notes: [note("a", 1, "a.ts", [0, 0], "Old", "x")] });
  session.handle({ type: "code.set", notes: [] });
  session.handle({ type: "send", text: "Plain", opposite: false, requestId: "plain" });
  await until(() => commands("thread.send").length === 1, "the message");
  expect(sentText()).toBe("Plain");

  session.handle({
    type: "code.set",
    notes: [{ id: "", number: 1 }, note("b", 2, "b.ts", [3, 3], "Keep", "y")],
  });
  session.handle({ type: "send", text: "Again", opposite: false, requestId: "again" });
  await until(() => commands("thread.send").length === 2, "the second message");
  const second = (commands("thread.send")[1]?.input ?? []) as { text: string }[];
  const joined = second.map((part) => part.text).join("");
  expect(joined).toContain('count="1"');
  expect(joined).toContain("[1] b.ts:4");
});

test("a send's admission names the notes it carried, so the phone settles exactly those", async () => {
  const session = await thread();
  session.handle({ type: "code.set", notes: [note("a", 1, "a.ts", [0, 0], "Why?", "x")] });
  session.handle({ type: "send", text: "With a note", opposite: false, requestId: "carried" });
  await until(() => latest("admission", "carried"), "the admission");
  expect(latest("admission", "carried")).toMatchObject({ ok: true, notes: ["a"] });
  // The next message has none left to carry, and its admission names none.
  session.handle({ type: "send", text: "Plain", opposite: false, requestId: "none" });
  await until(() => latest("admission", "none"), "the second admission");
  expect(latest("admission", "none")?.notes).toBeUndefined();
});

test("a /goal is saved without the notes, and its admission names none, so they stay", async () => {
  const session = await thread();
  session.handle({ type: "code.set", notes: [note("a", 1, "a.ts", [0, 0], "Why?", "x")] });
  session.handle({ type: "send", text: "/goal ship it", opposite: false, requestId: "goal" });
  await until(() => latest("admission", "goal"), "the admission");
  expect(latest("admission", "goal")).toMatchObject({ ok: true });
  expect(latest("admission", "goal")?.notes).toBeUndefined();
  expect(commands("thread.goal.set")).toHaveLength(1);
  expect(latest("thread.codeSent")).toBeUndefined();
});

test("a message too long to take is refused by its own request, so the phone gives its notes back", async () => {
  const session = await thread();
  session.handle({ type: "code.set", notes: [note("a", 1, "a.ts", [0, 0], "Why?", "x")] });
  session.handle({ type: "send", text: "x".repeat(100_001), opposite: false, requestId: "long" });
  await until(() => latest("admission", "long"), "the refusal");
  expect(latest("admission", "long")).toMatchObject({ ok: false });
  expect(String(latest("admission", "long")?.message)).toContain("too long");
  expect(commands("thread.send")).toHaveLength(0);
});
