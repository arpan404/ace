// Non-gating merge-time benchmark; deliberately includes a legacy single huge blob.
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { Store, createDevThread } from "@ace/daemon";
import { AgentItem, ItemId, AgentId } from "@ace/protocol";
const db = new DatabaseSync(":memory:");
const store = new Store(":memory:", undefined, { database: db });
try {
  const thread = createDevThread(store, store.createWorkspace("/synthetic", "bench"));
  const item = AgentItem.parse({
    type: "tool_call",
    id: "range",
    agentId: "agent",
    complete: true,
    createdAt: 0,
    call: {
      id: "call",
      agentId: "agent",
      kind: "shell",
      title: "synthetic",
      startedAt: 0,
      status: "succeeded",
      raw: [],
      detail: { kind: "shell", command: "synthetic" },
    },
  });
  store.appendEvents(thread.id, [
    { type: "item.created", item },
    { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "output", append: "x" },
  ]);
  for (const size of [1024 * 1024, 16 * 1024 * 1024]) {
    db.prepare("UPDATE output_chunks SET bytes = ? WHERE stream_id = ?").run(
      Buffer.alloc(size, 120),
      "output:range",
    );
    db.prepare("UPDATE output_streams SET size = ? WHERE id = ?").run(size, "output:range");
    const count = 10000;
    const start = performance.now();
    for (let i = 0; i < count; i++) store.readOutput("output:range", size - 2, 1);
    const ms = performance.now() - start;
    console.log(
      JSON.stringify({
        name: "one-byte range inside single blob",
        blobBytes: size,
        opsPerSecond: (count * 1000) / ms,
        microsecondsPerOperation: (ms * 1000) / count,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  }
  for (const parts of [1, 200]) {
    const id = ItemId.parse(`text-${parts}`);
    const agentId = AgentId.parse("agent");
    store.appendEvents(thread.id, [
      {
        type: "item.created",
        item: AgentItem.parse({
          type: "message",
          id,
          agentId,
          role: "assistant",
          complete: false,
          createdAt: 0,
          parts: Array.from({ length: parts }, () => ({ type: "text", text: "" })),
        }),
      },
    ]);
    const count = 10000;
    const start = performance.now();
    for (let i = 0; i < count; i++)
      store.appendEvents(thread.id, [
        { type: "item.delta", itemId: id, agentId, field: "text", append: "x" },
      ]);
    const ms = performance.now() - start;
    console.log(
      JSON.stringify({
        name: "text stream persistence",
        parts,
        opsPerSecond: (count * 1000) / ms,
        microsecondsPerOperation: (ms * 1000) / count,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  }
} finally {
  store.close();
}
