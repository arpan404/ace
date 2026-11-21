import { createThreadView } from "@ace/projection";
import { Item, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { tailSnapshot, windowSnapshot } from "./window.ts";

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Window",
  rootAgentId: "root",
  status: { state: "working", agents: 2 },
  createdAt: 0,
  updatedAt: 0,
});
const say = (id: string, createdAt: number, agentId = "root") =>
  Item.parse({
    id,
    agentId,
    type: "message",
    role: "assistant",
    createdAt,
    complete: true,
    parts: [{ type: "text", text: id }],
  });

test("the snapshot keeps the root's share of its tail in creation order, whatever the timestamps", () => {
  const view = createThreadView(thread, 10);
  const creation = new Map<string, number>();
  const items = [say("ask", 99), say("reply", 98)];
  for (let seq = 3; seq <= 10; seq++) items.push(say(`step-${seq}`, 100 - seq, "sub"));
  items.forEach((item, index) => {
    view.items[item.id] = item;
    view.itemOrder.push(item.id);
    creation.set(item.id, index + 1);
  });
  const snapshot = windowSnapshot(view, creation, 4, 10);
  expect(snapshot.itemOrder).toEqual(["ask", "reply", "step-9", "step-10"]);
  // Everything from step-9 on is in the snapshot; the older subagent steps page in from there.
  expect(snapshot.itemsBefore).toBe(9);
  expect(snapshot.itemSeqs).toEqual({ ask: 1, reply: 2, "step-9": 9, "step-10": 10 });
});

test("a tail snapshot holds the newest items within its budget and says it holds less", () => {
  const view = createThreadView(thread, 40);
  const creation = new Map<string, number>();
  for (let seq = 1; seq <= 40; seq++) {
    const item = say(`reply-${seq}`, seq);
    view.items[item.id] = item;
    view.itemOrder.push(item.id);
    creation.set(item.id, seq);
  }
  const counted = tailSnapshot(view, creation, { items: 5, bytes: 1024 * 1024 }, 200, 40);
  expect(counted.itemOrder).toEqual(["reply-36", "reply-37", "reply-38", "reply-39", "reply-40"]);
  expect(counted.itemsBefore).toBe(36);
  expect(counted.partial).toEqual({ previews: [] });
  // A byte budget smaller than five items cuts it further, never below the newest one.
  const one = JSON.stringify(view.items["reply-40"]).length;
  const sized = tailSnapshot(view, creation, { items: 5, bytes: one * 2 + 1 }, 200, 40);
  expect(sized.itemOrder).toEqual(["reply-39", "reply-40"]);
  expect(sized.itemsBefore).toBe(39);
  expect(tailSnapshot(view, creation, { items: 5, bytes: 1 }, 200, 40).itemOrder).toEqual([
    "reply-40",
  ]);
  // A tail that holds the whole window is a full snapshot.
  const whole = tailSnapshot(view, creation, { items: 50, bytes: 1024 * 1024 }, 200, 40);
  expect(whole.itemOrder).toHaveLength(40);
  expect(whole.partial).toBeUndefined();
});

test("a tail snapshot measures its budget in UTF-8 bytes, as the daemon does", () => {
  const view = createThreadView(thread, 3);
  const creation = new Map<string, number>();
  for (let seq = 1; seq <= 3; seq++) {
    const item = say(`reply-${seq}-${"é".repeat(200)}`, seq);
    view.items[item.id] = item;
    view.itemOrder.push(item.id);
    creation.set(item.id, seq);
  }
  const newest = JSON.stringify(view.items[view.itemOrder[2] ?? ""]);
  // Two items by UTF-16 length, but each "é" is two bytes, so only the newest fits.
  const sized = tailSnapshot(view, creation, { items: 3, bytes: newest.length * 2 + 1 }, 200, 3);
  expect(sized.itemOrder).toEqual([view.itemOrder[2]]);
});

test("a newest item larger than the whole budget shows alone as a preview the snapshot names", () => {
  const view = createThreadView(thread, 2);
  const creation = new Map<string, number>();
  const long = Item.parse({
    id: "long",
    agentId: "root",
    type: "message",
    role: "assistant",
    createdAt: 2,
    complete: true,
    parts: [{ type: "text", text: "word ".repeat(2000) }],
  });
  [say("short", 1), long].forEach((item, index) => {
    view.items[item.id] = item;
    view.itemOrder.push(item.id);
    creation.set(item.id, index + 1);
  });
  const snapshot = tailSnapshot(view, creation, { items: 5, bytes: 1024 }, 200, 2);
  expect(snapshot.itemOrder).toEqual(["long"]);
  expect(snapshot.partial).toEqual({ previews: ["long"] });
  const shown = snapshot.items.long;
  const part = shown?.type === "message" ? shown.parts[0] : undefined;
  if (part?.type !== "text") throw new Error("expected a text part");
  // The newest words, clipped, with a source naming the whole text so the client marks it.
  expect(part.text.length).toBeLessThan(10_000);
  expect("word ".repeat(2000).endsWith(part.text)).toBe(true);
  expect(part.source?.bytes).toBe(10_000 * 2);
});
