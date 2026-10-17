import { createThreadView } from "@ace/projection";
import { Item, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { windowSnapshot } from "./window.ts";

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
