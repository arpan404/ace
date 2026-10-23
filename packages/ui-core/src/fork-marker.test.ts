import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { saidAt, withForkMarker } from "./fork-marker.ts";
import type { Block } from "./transcript-blocks.ts";

let clock = 100;
function message(id: string, role: "user" | "assistant", extra: Record<string, unknown> = {}) {
  return Item.parse({
    id,
    agentId: "root",
    type: "message",
    role,
    complete: true,
    createdAt: ++clock,
    parts: [{ type: "text", text: id }],
    ...extra,
  });
}
const copied = (id: string, role: "user" | "assistant") =>
  message(id, role, { inherited: { threadId: "source", itemId: `source-${id}`, at: 5 } });
const replayed = (id: string, role: "user" | "assistant") =>
  message(id, role, { inherited: { threadId: "source" } });
const ask = (id: string) => message(id, "user", { origin: { kind: "person" } });

/** The blocks of `items`, one each, and where the divider lands among them. */
function marked(items: Item[], fromStart: boolean) {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  const blocks: Block[] = items.map((item) =>
    item.type === "message" && item.role === "user"
      ? { kind: "user", key: item.id, itemId: item.id }
      : { kind: "message", key: item.id, itemId: item.id },
  );
  return withForkMarker(blocks, {
    sourceThreadId: "source",
    order: items.map((item) => item.id),
    fromStart,
    item: (id) => byId.get(id),
  }).map((block) => (block.kind === "forked" ? `forked:${block.threadId}` : block.key));
}

test("the divider sits before the fork's first own message, even when older copies aren't loaded", () => {
  const items = [
    copied("q9", "user"),
    copied("a9", "assistant"),
    ask("mine"),
    message("reply", "assistant"),
  ];
  expect(marked(items, false)).toEqual(["q9", "a9", "forked:source", "mine", "reply"]);
});

test("a window of the fork's own work alone, far from its start, shows no divider", () => {
  const items = [ask("later"), message("reply", "assistant")];
  expect(marked(items, false)).toEqual(["later", "reply"]);
});

test("turns the provider's own fork brought along count as the source's history", () => {
  const items = [replayed("q1", "user"), replayed("a1", "assistant"), ask("mine")];
  expect(marked(items, false)).toEqual(["q1", "a1", "forked:source", "mine"]);
});

test("a fork waiting for its first message has the divider after its history", () => {
  expect(marked([copied("q1", "user"), copied("a1", "assistant")], true)).toEqual([
    "q1",
    "a1",
    "forked:source",
  ]);
});

test("a copy keeps the time it was said in the source", () => {
  expect(saidAt(copied("q1", "user"))).toBe(5);
  expect(saidAt(ask("mine"))).toBe(clock);
});
