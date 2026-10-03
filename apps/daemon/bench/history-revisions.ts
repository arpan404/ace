// Non-gating, offline public-store benchmark. Do not execute while merge-only testing applies.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Item, Thread } from "@ace/protocol";
import { Store } from "@ace/daemon";

const directory = mkdtempSync(join(tmpdir(), "ace-history-bench-"));
try {
  for (const historicalItems of [100, 10000]) {
    const store = new Store(join(directory, `${historicalItems}.sqlite`), undefined, {
      now: () => 1,
    });
    try {
      const workspaceId = store.createWorkspace(directory, "Benchmark", 1);
      const thread = Thread.parse({
        id: "bench",
        workspaceId,
        title: "Benchmark",
        provider: "codex",
        status: { state: "new" },
        createdAt: 1,
        updatedAt: 1,
      });
      store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
      for (let i = 0; i < historicalItems; i++)
        store.appendEvents(
          thread.id,
          [
            {
              type: "item.created",
              item: Item.parse({
                id: `item-${i}`,
                agentId: "root",
                type: "message",
                role: "assistant",
                complete: true,
                createdAt: 1,
                parts: [{ type: "text", text: "history" }],
              }),
            },
          ],
          1,
        );
      const itemId = Item.parse({
        id: "live",
        agentId: "root",
        type: "message",
        role: "assistant",
        complete: false,
        createdAt: 1,
        parts: [{ type: "text", text: "" }],
      });
      if (itemId.type !== "message") throw new Error("Invalid stream fixture");
      store.appendEvents(thread.id, [{ type: "item.created", item: itemId }], 1);
      const iterations = 10000;
      const start = performance.now();
      for (let i = 0; i < iterations; i++)
        store.appendEvents(
          thread.id,
          [
            {
              type: "item.delta",
              agentId: itemId.agentId,
              itemId: itemId.id,
              field: "text",
              append: "x",
            },
          ],
          1,
        );
      const elapsed = performance.now() - start;
      process.stdout.write(
        JSON.stringify({
          operation: "append-with-history-index",
          historicalItems,
          iterations,
          opsPerSecond: (iterations / elapsed) * 1000,
          microsecondsPerOp: (elapsed * 1000) / iterations,
          peakRssBytes: process.resourceUsage().maxRSS * 1024,
        }) + "\n",
      );
      const reads = 1000;
      const readStart = performance.now();
      for (let i = 0; i < reads; i++) {
        store.historicalItemCount(thread.id, store.headSeq());
        store.readHistoricalItemPage(
          thread.id,
          store.headSeq(),
          store.headSeq() + 1,
          50,
          128 * 1024,
        );
      }
      const readElapsed = performance.now() - readStart;
      process.stdout.write(
        JSON.stringify({
          operation: "historical-count-and-page",
          historicalItems,
          iterations: reads,
          opsPerSecond: (reads / readElapsed) * 1000,
          microsecondsPerOp: (readElapsed * 1000) / reads,
          peakRssBytes: process.resourceUsage().maxRSS * 1024,
        }) + "\n",
      );
    } finally {
      store.close();
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
