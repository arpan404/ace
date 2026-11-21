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
