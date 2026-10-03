import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { Event, Item, ItemId, Thread, type EventPayload } from "@ace/protocol";
import { SearchIndex } from "../src/index.ts";

// Pending rows precede indexed rows: a failed document lookup must not scan
// all of a thread's indexed history for each pending deletion or retention row.
const count = z.coerce
  .number()
  .int()
  .min(1000)
  .max(1000000)
  .parse(process.env.SEARCH_DELETE_BENCH_ITEMS ?? 100000);
const directory = mkdtempSync(join(tmpdir(), "ace-search-delete-bench-"));
const db = new DatabaseSync(join(directory, "search.sqlite"));
try {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA cache_size=-16384");
  const index = new SearchIndex(db);
  const thread = Thread.parse({
    id: "thread",
    workspaceId: "workspace",
    provider: "codex",
    title: "Deletion benchmark",
    status: { state: "working", agents: 1 },
    createdAt: 1,
    updatedAt: 1,
  });
  let seq = 0;
  const append = (payloads: EventPayload[]): void =>
    index.append(
      payloads.map((payload) =>
        Event.parse({
          id: `event${++seq}`,
          seq,
          threadId: thread.id,
          at: 1,
          payload,
        }),
      ),
    );
  append([{ type: "thread.created", thread }]);
  const pending = Math.floor(count / 2);
  for (let start = 0; start < count; start += 256) {
    const events: EventPayload[] = [];
    for (let i = start; i < Math.min(start + 256, count); i++)
      events.push({
        type: "item.created",
        item: Item.parse({
          id: `item${i}`,
          agentId: "agent",
          type: "message",
          role: "assistant",
          complete: i >= pending,
          createdAt: 1,
          parts: [{ type: "text", text: `deletionword item${i}` }],
        }),
      });
    append(events);
  }
  const sample = (ids: number[]) => {
    const samples: number[] = [];
    const started = performance.now();
    for (const id of ids) {
      const before = performance.now();
      append([{ type: "item.deleted", itemId: ItemId.parse(`item${id}`) }]);
      samples.push(performance.now() - before);
    }
    const seconds = (performance.now() - started) / 1000;
    samples.sort((a, b) => a - b);
    return {
      operations: samples.length,
      opsPerSecond: samples.length / seconds,
      p50Ms: samples[Math.floor(samples.length / 2)],
      p99Ms: samples[Math.floor(samples.length * 0.99)],
    };
  };
  const pendingDeletion = sample(Array.from({ length: 100 }, (_, i) => pending - 1 - i));
  const indexedDeletion = sample(Array.from({ length: 100 }, (_, i) => count - 1 - i));
  const before = performance.now();
  index.deleteThread(thread.id);
  const retentionMs = performance.now() - before;
  process.stdout.write(
    JSON.stringify({
      items: count,
      pending,
      pendingDeletion,
      indexedDeletion,
      retentionMs,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      remainingPending: index.status(seq).pending,
      remainingHits: index.query({ text: "deletionword" }).hits.length,
    }) + "\n",
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
