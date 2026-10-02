import { performance } from "node:perf_hooks";
import { Client, webSocketTransport } from "../src/index.ts";
import { setup, ready, agentId, when } from "../src/test-support.ts";
import { ItemId } from "@ace/protocol";

const h = await setup();
try {
  const itemId = ItemId.parse("output-bench");
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.created",
      item: {
        type: "tool_call",
        id: itemId,
        agentId,
        createdAt: 0,
        complete: true,
        call: {
          id: itemId,
          agentId,
          kind: "shell",
          title: "bench",
          startedAt: 0,
          status: "succeeded",
          raw: [],
          detail: { kind: "shell", command: "synthetic" },
        },
      },
    },
  ]);
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.delta", itemId: itemId, agentId, field: "output", append: "x".repeat(65536) },
  ]);
  const { client }: { client: Client } = h.make({
    transport: () => webSocketTransport(() => new WebSocket(h.daemon.url)),
    scheduler: {
      set(delay, callback) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
  });
  await ready(client);
  const subscription = client.thread(h.thread.id);
  await when(
    subscription.store.select(["thread"], (store) => store.thread),
    Boolean,
  );
  const count = 1000;
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const result = await client.outputRead({
      streamId: `output:${itemId}`,
      offset: 0,
      limit: 65536,
    });
    if (result.bytes.length !== 65536) throw new Error("Short read");
  }
  const seconds = (performance.now() - start) / 1000;
  console.log(
    JSON.stringify({
      name: "64 KiB output.read over real daemon/socket",
      operations: count,
      opsPerSecond: Math.round(count / seconds),
      microsecondsPerOperation: (seconds * 1e6) / count,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
  subscription.release();
  for (const history of [1000, 10000]) {
    const payloads = Array.from({ length: history - h.daemon.store.headSeq() }, (_, i) => ({
      type: "thread.updated" as const,
      title: `history-${i}`,
    }));
    for (let i = 0; i < payloads.length; i += 100)
      h.daemon.store.appendEvents(h.thread.id, payloads.slice(i, i + 100));
    const coldStart = performance.now();
    for (let i = 0; i < 1000; i++)
      await client.outputRead({ streamId: `output:${itemId}`, offset: 65535, limit: 1 });
    const elapsed = performance.now() - coldStart;
    console.log(
      JSON.stringify({
        name: "cold one-byte indexed output.read",
        history,
        opsPerSecond: Math.round(1e6 / elapsed),
        microsecondsPerOperation: elapsed,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  }
} finally {
  await h.cleanup();
}
