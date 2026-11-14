/**
 * Thread opens while another thread streams: one thread takes item deltas, and between writes
 * a reader opens the snapshot of a quiet thread (200 items) and of the streaming one. Reports
 * the read cache's hits and misses and the median time of each open.
 */
import { Store, createDevThread } from "../src/index.ts";
import { AgentItem } from "@ace/protocol";

const message = (id: string, text: string, complete = true) =>
  AgentItem.parse({
    id,
    agentId: "root",
    type: "message",
    role: "assistant",
    createdAt: 1,
    complete,
    parts: [{ type: "text", text }],
  });
const store = new Store(":memory:");
const workspace = store.createWorkspace("/repo", "repo");
const quiet = createDevThread(store, workspace);
const busy = createDevThread(store, workspace);
for (let index = 0; index < 200; index++)
  store.appendEvents(quiet.id, [
    { type: "item.created", item: message(`q${index}`, "x".repeat(2000)) },
  ]);
const live = message("live", "", false);
store.appendEvents(busy.id, [{ type: "item.created", item: live }]);
// A subscribed client holds the quiet thread's view.
store.acquireThread(quiet.id);
const median = (samples: number[]) => samples.toSorted((a, b) => a - b)[samples.length >> 1] ?? 0;
const quietMs: number[] = [];
const busyMs: number[] = [];
const before = { ...store.streamingMetrics().reads };
for (let round = 0; round < 300; round++) {
  store.appendEvents(busy.id, [
    { type: "item.delta", itemId: live.id, agentId: live.agentId, field: "text", append: "token " },
  ]);
  let start = performance.now();
  store.snapshotThread(quiet.id);
  quietMs.push(performance.now() - start);
  start = performance.now();
  store.snapshotThread(busy.id);
  busyMs.push(performance.now() - start);
}
const after = store.streamingMetrics().reads;
console.log(
  JSON.stringify({
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
    invalidations: after.invalidations - before.invalidations,
    quietOpenMs: +median(quietMs).toFixed(3),
    busyOpenMs: +median(busyMs).toFixed(3),
  }),
);
await store.close();
