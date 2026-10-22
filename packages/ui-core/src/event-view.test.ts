import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { eventCounts, eventFollowsOrder, eventView } from "./event-view.ts";

let at = 0;
const base = (id: string) => ({ id, agentId: "root", createdAt: ++at, complete: true });
const error = (id: string, text: string, code?: string) =>
  Item.parse({ ...base(id), type: "notice", level: "error", text, ...(code ? { code } : {}) });
const user = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  Item.parse({
    ...base(id),
    type: "message",
    role: "user",
    parts: [{ type: "text", text }],
    ...extra,
  });

function thread(items: Item[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return { order: items.map((item) => item.id), item: (id: string) => byId.get(id) };
}
const view = (items: Item[], id: string) => {
  const reader = thread(items);
  return eventView(reader.item(id), eventCounts(reader, id));
};

test("identical failures show once, on the first row, with how many times", () => {
  const items = [error("e1", "The model crashed."), error("e2", "The model crashed.")];
  expect(view(items, "e1")).toMatchObject({ kind: "error", count: 2 });
  expect(view(items, "e2")).toEqual({ kind: "none" });
});

test("a bare error code that only echoes the error above it is hidden", () => {
  const items = [
    error("e1", "The provider stopped responding.", "internal_error"),
    error("e2", "internal_error"),
  ];
  expect(view(items, "e1")).toMatchObject({ kind: "error" });
  expect(view(items, "e2")).toEqual({ kind: "none" });
});

test("an error row names the thread's provider when the notice doesn't", () => {
  const reader = thread([error("e1", "Something failed.")]);
  const shown = eventView(reader.item("e1"), eventCounts(reader, "e1"), "codex");
  expect(shown).toMatchObject({ kind: "error", error: { provider: "codex" } });
});

test("a compaction reads as one system row", () => {
  const item = Item.parse({ ...base("c1"), type: "compaction" });
  expect(view([item], "c1")).toMatchObject({ kind: "system", text: "Context compacted" });
});

test("a usage warning stays out of the transcript", () => {
  const item = Item.parse({
    ...base("w1"),
    type: "notice",
    level: "warning",
    text: "Your account has used 82% of its 5-hour window.",
  });
  expect(view([item], "w1")).toEqual({ kind: "none" });
});

test("the person's own message, though it looked like ace's input, is a bubble", () => {
  expect(view([user("u1", "ace restarted. Please diagnose this bug")], "u1")).toEqual({
    kind: "user",
  });
});

test("an injected message ace has no words for is quiet text", () => {
  const item = user("s1", "Injected context from the provider.", { synthetic: true });
  expect(view([item], "s1")).toEqual({
    kind: "quiet",
    text: "Injected context from the provider.",
  });
});

test("a delivery failure for a send reads as not sent, naming its command", () => {
  const item = Item.parse({
    ...base("n1"),
    type: "notice",
    level: "error",
    text: "Couldn't deliver the message.",
    code: "delivery_failed",
    commandId: "cmd-1",
  });
  expect(view([item], "n1")).toMatchObject({ kind: "notSent", commandId: "cmd-1" });
});

test("only errors, refusals and ace inputs follow the rows around them", () => {
  expect(eventFollowsOrder(error("e1", "Boom."))).toBe(true);
  expect(eventFollowsOrder(user("u1", "Fix the login redirect"))).toBe(false);
});
