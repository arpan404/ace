import { Event, Item, Thread } from "@ace/protocol";
import { applyEvent, createThreadView } from "../src/index.ts";

// Informational only. No elapsed-time threshold is part of the test suite.
const thread = Thread.parse({
  id: "bench",
  workspaceId: "workspace",
  title: "Delta benchmark",
  provider: "codex",
  status: { state: "new" },
  createdAt: 0,
  updatedAt: 0,
});
const item = Item.parse({
  id: "message",
  agentId: "agent",
  type: "message",
  role: "assistant",
  complete: false,
  createdAt: 0,
  parts: [],
});
const delta = Event.parse({
  seq: 2,
  id: "delta",
  at: 0,
  threadId: thread.id,
  payload: {
    type: "item.delta",
    itemId: item.id,
    agentId: item.agentId,
    field: "text",
    append: "x",
  },
});
for (const count of [10000, 20000]) {
  const view = createThreadView(thread);
  applyEvent(view, Event.parse({ ...delta, seq: 1, payload: { type: "item.created", item } }));
  const start = performance.now();
  for (let seq = 2; seq <= count + 1; seq++) applyEvent(view, { ...delta, seq });
  console.log(`${count} deltas: ${(performance.now() - start).toFixed(2)} ms, cursor ${view.seq}`);
}
