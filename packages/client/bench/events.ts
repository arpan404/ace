import { performance } from "node:perf_hooks";
import { createThreadView } from "@ace/projection";
import { AgentId, EventId, ItemId, Thread, type EventBatch } from "@ace/protocol";
import { ThreadStore, defaultLimits } from "../src/index.ts";

const thread = Thread.parse({
  id: "bench",
  workspaceId: "workspace",
  title: "bench",
  provider: "codex",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
const itemId = ItemId.parse("message");
const agentId = AgentId.parse("agent");
function run(name: string, matching: number, unrelated: number, parts = 1): void {
  const store = new ThreadStore(defaultLimits);
  const view = createThreadView(thread);
  view.items[itemId] = {
    type: "message",
    id: itemId,
    agentId,
    createdAt: 0,
    complete: false,
    role: "assistant",
    parts: Array.from({ length: parts }, () => ({ type: "text", text: "" })),
    synthetic: false,
    raw: [],
  };
  view.itemOrder.push(itemId);
  store.snapshot(view);
  let notifications = 0;
  const stops: (() => void)[] = [];
  for (let i = 0; i < matching; i++)
    stops.push(
      store
        .select([`item:${itemId}`], (reader) => reader.item(itemId))
        .subscribe(() => {
          notifications++;
        }),
    );
  for (let i = 0; i < unrelated; i++)
    stops.push(
      store
        .select([`item:unrelated-${i}`], (reader) => reader.item(`unrelated-${i}`))
        .subscribe(() => {
          notifications++;
        }),
    );
  const event = {
    seq: 1,
    id: EventId.parse("event"),
    at: 0,
    threadId: thread.id,
    payload: { type: "item.delta" as const, itemId, agentId, field: "text" as const, append: "x" },
  };
  const batch: EventBatch = {
    type: "events",
    subscriptionId: "bench",
    afterSeq: 0,
    throughSeq: 1,
    events: [event],
  };
  const count = 200000;
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    batch.afterSeq = i;
    batch.throughSeq = i + 1;
    event.seq = i + 1;
    store.delivery(batch);
  }
  const seconds = (performance.now() - start) / 1000;
  console.log(
    JSON.stringify({
      name,
      events: count,
      matching,
      unrelated,
      opsPerSecond: Math.round(count / seconds),
      microsecondsPerEvent: (seconds * 1e6) / count,
      notifications,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
  for (const stop of stops) stop();
}
run("event application", 0, 0);
run("200-part message application", 0, 0, 200);
run("one observer plus 1000 unrelated selectors", 1, 1000);
run("fan-out to 100 matching selectors", 100, 1000);
