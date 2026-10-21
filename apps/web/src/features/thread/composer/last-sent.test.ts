import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { sentText } from "./last-sent.ts";

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
): Item =>
  Item.parse({
    id,
    type: "message",
    role,
    parts: [{ type: "text", text }],
    agentId: "agent-root",
    createdAt: 1,
    complete: true,
    ...extra,
  });

const transcript = (items: Item[]) => ({
  order: items.map((item) => item.id),
  item: (id: string) => items.find((item) => item.id === id),
});

test("the person's latest message is recalled, not the agent's reply after it", () => {
  const items = [
    message("1", "user", "first ask"),
    message("2", "assistant", "done"),
    message("3", "user", "add tests too"),
    message("4", "assistant", "added"),
  ];
  expect(sentText(transcript(items), 0)).toBe("add tests too");
});

test("inputs ace sent for the person are skipped", () => {
  const items = [
    message("1", "user", "fix the build"),
    message("2", "user", "ace restarted. Continue where you left off."),
    message("3", "user", "task finished", { synthetic: true }),
  ];
  expect(sentText(transcript(items), 0)).toBe("fix the build");
});

test("a transcript with nothing from the person recalls nothing", () => {
  expect(sentText(transcript([message("1", "assistant", "hello")]), 0)).toBeUndefined();
});

test("each step back reaches the message sent before, until there are none left", () => {
  const items = [
    message("1", "user", "first ask"),
    message("2", "assistant", "done"),
    message("3", "user", "task finished", { synthetic: true }),
    message("4", "user", "second ask"),
    message("5", "assistant", "done"),
    message("6", "user", "third ask"),
  ];
  const sent = transcript(items);
  expect([0, 1, 2, 3].map((older) => sentText(sent, older))).toEqual([
    "third ask",
    "second ask",
    "first ask",
    undefined,
  ]);
});
