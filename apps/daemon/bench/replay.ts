/**
 * Reconnects to a thread that missed events: one replay within the limit (4,000 events) and one
 * past it (6,000, answered with a snapshot). Reports the median time per reconnect, encoding the
 * messages as a socket would.
 */
import { Store, createDevThread } from "../src/index.ts";
import { subscribe } from "../src/subscription.ts";
import { WireEncoder } from "../src/wire-encoder.ts";
import { AgentItem, type ThreadId } from "@ace/protocol";

const store = new Store(":memory:");
const workspace = store.createWorkspace("/repo", "repo");
const thread = createDevThread(store, workspace);
const item = AgentItem.parse({
  id: "live",
  agentId: "root",
  type: "message",
  role: "assistant",
  createdAt: 1,
  complete: false,
  parts: [{ type: "text", text: "" }],
});
store.appendEvents(thread.id, [{ type: "item.created", item }]);
const cursor = store.headSeq();
const append = (count: number) => {
  for (let index = 0; index < count; index++)
    store.appendEvents(thread.id, [
      {
        type: "item.delta",
        itemId: "live",
        agentId: "root",
        field: "text",
        append: "token ".repeat(Number(process.env.REPEAT ?? 8)),
      },
    ]);
};
const median = (samples: number[]) => samples.toSorted((a, b) => a - b)[samples.length >> 1] ?? 0;
let subscriptions = 0;
function reconnect(id: ThreadId) {
  const encoder = new WireEncoder();
  let bytes = 0;
  const start = performance.now();
  const stop = subscribe(
    store,
    `s${++subscriptions}`,
    { kind: "thread", threadId: id },
    cursor,
    5000,
    (message) => (bytes += encoder.encode(message).length),
    250,
    () => () => {},
    false,
    encoder,
  );
  const ms = performance.now() - start;
  stop();
  return { ms, bytes };
}
const sample = () => {
  const runs = Array.from({ length: 31 }, () => reconnect(thread.id));
  return { ms: +median(runs.map((run) => run.ms)).toFixed(2), bytes: runs[0]?.bytes ?? 0 };
};
append(4000);
const within = sample();
append(2000);
const over = sample();
console.log(JSON.stringify({ within, over }));
await store.close();
