import { Store, createDevThread } from "../src/index.ts";
import { AgentItem, type EventPayload } from "@ace/protocol";
const message = (id: string, text: string) =>
  AgentItem.parse({
    id,
    agentId: "a",
    type: "message",
    role: "assistant",
    createdAt: 1,
    complete: false,
    parts: [{ type: "text", text }],
  });
function setup() {
  const store = new Store(":memory:");
  const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
  return { store, thread };
}
function measure(run: () => void) {
  const samples = Array.from({ length: 5 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).toSorted((a, b) => a - b);
  return +(samples[2] ?? 0).toFixed(2);
}
for (const size of [0, 1, 8]) {
  const { store, thread } = setup();
  const item = message("m", "x".repeat(size * 1024 * 1024));
  store.appendEvents(thread.id, [{ type: "item.created", item }]);
  const delta: EventPayload = {
    type: "item.delta",
    itemId: item.id,
    agentId: item.agentId,
    field: "text",
    append: "x",
  };
  console.log(
    JSON.stringify({
      probe: "100 text appends",
      priorMiB: size,
      ms: measure(() => {
        for (let i = 0; i < 100; i++) store.appendEvents(thread.id, [delta]);
      }),
    }),
  );
  store.close();
}
{
  const { store, thread } = setup();
  const item = AgentItem.parse({
    id: "s",
    agentId: "a",
    type: "tool_call",
    createdAt: 1,
    complete: false,
    call: {
      id: "s",
      agentId: "a",
      kind: "shell",
      title: "shell",
      status: "running",
      startedAt: 1,
      raw: [],
      detail: { kind: "shell", command: "echo" },
    },
  });
  const delta: EventPayload = {
    type: "item.delta",
    itemId: item.id,
    agentId: item.agentId,
    field: "output",
    append: "x",
  };
  store.appendEvents(thread.id, [
    { type: "item.created", item },
    ...Array.from({ length: 20000 }, () => delta),
  ]);
  for (const offset of [0, 19999])
    console.log(
      JSON.stringify({
        probe: "100 output reads / 20000 chunks",
        offset,
        ms: measure(() => {
          for (let i = 0; i < 100; i++) store.readOutput("output:s", offset, 1);
        }),
      }),
    );
  store.close();
}
for (const count of [200, 2000]) {
  const { store, thread } = setup();
  store.appendEvents(
    thread.id,
    Array.from({ length: count }, (_, i) => ({
      type: "item.created" as const,
      item: message(`m${i}`, "x".repeat(4096)),
    })),
  );
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const ms = measure(() => store.snapshotThread(thread.id));
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  const cache = store.acquireThread(thread.id);
  console.log(
    JSON.stringify({
      probe: "cold snapshot + retained subscription",
      historyItems: count,
      ms,
      heapGrowthOverFiveSnapshots: heapGrowth,
      retainedItems: cache.itemOrder.length,
      retainedBytes: Buffer.byteLength(JSON.stringify(cache)),
    }),
  );
  store.close();
}
