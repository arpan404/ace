import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { lastSentText } from "./last-sent.ts";

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
  expect(lastSentText(transcript(items))).toBe("add tests too");
});

test("inputs ace sent for the person are skipped", () => {
  const items = [
    message("1", "user", "fix the build"),
    message("2", "user", "ace restarted. Continue where you left off."),
    message("3", "user", "task finished", { synthetic: true }),
  ];
  expect(lastSentText(transcript(items))).toBe("fix the build");
});

test("a transcript with nothing from the person recalls nothing", () => {
  expect(lastSentText(transcript([message("1", "assistant", "hello")]))).toBeUndefined();
});
