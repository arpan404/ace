import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { multiDayThread, type SyntheticThreadEvent } from "@ace/fake-daemon";
import { ThreadId, type ThreadSearchResponse } from "@ace/protocol";
import { Store } from "../src/store.ts";

/** Standalone measurement only. Does not run tests or start provider CLIs. */
const Arguments = z.object({
  items: z.coerce.number().int().min(100).max(10_000_000).default(1_000_000),
  turns: z.coerce.number().int().min(1).max(100_000).default(2_000),
  subagents: z.coerce.number().int().min(0).max(1000).default(48),
  database: z.string().optional(),
  phase: z.enum(["seed", "read", "seed-only"]).default("seed"),
  samples: z.coerce.number().int().min(1).max(1000).default(100),
});
const input: Record<string, string> = {};
for (const argument of process.argv.slice(2)) {
  const match = /^--(items|turns|subagents|database|phase|samples)=(.+)$/.exec(argument);
  if (!match?.[1] || match[2] === undefined) throw new Error(`Unknown argument ${argument}`);
  input[match[1]] = match[2];
}
const options = Arguments.parse(input);
if (options.phase === "read" && !options.database)
  throw new Error("Read phase requires --database");
const root = await mkdtemp(join(tmpdir(), "ace-long-thread-bench-"));
const database = options.database ? resolve(options.database) : join(root, "state.sqlite");
let store: Store | undefined;
let nextId = 0;
const threadId = ThreadId.parse("thread-multi-day");
const memory = () => ({
  rssMiB: process.memoryUsage().rss / 1024 ** 2,
  heapMiB: process.memoryUsage().heapUsed / 1024 ** 2,
  peakRssMiB: process.resourceUsage().maxRSS / 1024,
});

function report(value: unknown): void {
  console.log(JSON.stringify(value));
}

function writeBatch(target: Store, records: SyntheticThreadEvent[]): void {
  target.atomic(() => {
    let start = 0;
    while (start < records.length) {
      const first = records[start];
      if (!first) break;
      let end = start + 1;
      while (
        end < records.length &&
        records[end]?.threadId === first.threadId &&
        records[end]?.at === first.at
      )
        end++;
      target.appendEvents(
        first.threadId,
        records.slice(start, end).map((event) => event.payload),
        first.at,
      );
      start = end;
    }
  });
}

function measurement(name: string, action: () => unknown, samples = options.samples): void {
  report({ phase: "query", metric: name, samples });
  const elapsed: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    action();
    elapsed.push(performance.now() - start);
  }
  const sorted = elapsed.toSorted((left, right) => left - right);
  report({
    metric: name,
    samples,
    firstMs: elapsed[0],
    p50Ms: sorted[Math.floor(samples * 0.5)],
    p95Ms: sorted[Math.floor(samples * 0.95)],
    maxMs: sorted.at(-1),
  });
}

try {
  store = new Store(
    database,
    (error) => {
      throw error;
    },
    {
      nextId: () => `bench-${++nextId}`,
      now: () => Date.UTC(2026, 9, 3),
      searchScheduler: () => () => {},
    },
  );
  if (options.phase !== "read") {
    report({ phase: "database", path: database });
    const workspaceId = store.createWorkspace("/synthetic/workspace", "Multi-day performance");
    const start = performance.now();
    const initialMemory = memory();
    let batch: SyntheticThreadEvent[] = [];
    let batchBytes = 0;
    let items = 0;
    let events = 0;
    let reported = 0;
    for (const record of multiDayThread({ ...options, workspaceId })) {
      batch.push(record);
      batchBytes += JSON.stringify(record.payload).length * 2;
      events++;
      if (record.payload.type === "item.created") items++;
      if (batch.length >= 128 || batchBytes >= 512 * 1024) {
        writeBatch(store, batch);
        batch = [];
        batchBytes = 0;
        if (items - reported >= 100_000) {
          report({
            phase: "seed",
            items,
            events,
            elapsedMs: performance.now() - start,
            ...memory(),
          });
          reported = items;
        }
        await setImmediate();
      }
    }
    if (batch.length) writeBatch(store, batch);
    batch = [];
    // Both FTS owners drain their bounded durable queues before cold reopen.
    await store.search.backfill(store, { signal: new AbortController().signal });
    report({
      phase: "seeded",
      items,
      generatedEvents: events,
      canonicalEvents: store.headSeq(),
      elapsedMs: performance.now() - start,
      initialMemory,
      ...memory(),
    });
  }
  await store.close();
  if (options.phase !== "seed-only") {
    store = new Store(
      database,
      (error) => {
        throw error;
      },
      { searchScheduler: () => () => {} },
    );
    await store.search.backfill(store, { signal: new AbortController().signal });
    globalThis.gc?.();
    report({
      phase: "reopened",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      databaseBytes: (await stat(database)).size,
      ...memory(),
    });
    const reader = store;
    const lastTurns = reader.turnsPage({ threadId, limit: 50 });
    const sinceSeq = lastTurns.turns.at(-26)?.endSeq ?? 0;
    const blobTurn = Math.min(options.turns, 173);
    const blobText = `blob-needle-${blobTurn}`;
    const outputText = `tool-output-needle-${blobTurn}`;
    let ordinal = 0;
    measurement("turns.page", () => {
      ordinal = (ordinal + 37) % options.turns;
      reader.turnsPage({ threadId, before: Math.max(2, ordinal), limit: 50 });
    });
    let cursor: string | undefined;
    measurement("thread.search.common", () => {
      const page: ThreadSearchResponse = reader.threadSearch({
        threadId,
        text: "migration",
        scope: "thread",
        limit: 30,
        ...(cursor ? { cursor } : {}),
      });
      cursor = page.cursor ?? undefined;
    });
    measurement("thread.search.blob", () =>
      reader.threadSearch({ threadId, text: blobText, scope: "thread", limit: 30 }),
    );
    measurement("thread.search.toolOutput", () =>
      reader.threadSearch({
        threadId,
        text: outputText,
        scope: "thread",
        filter: "tool_output",
        limit: 30,
      }),
    );
    measurement("thread.search.tree", () =>
      reader.threadSearch({ threadId, text: "subagent-needle", scope: "tree", limit: 30 }),
    );
    measurement("thread.catchUp.recent", () => reader.threadCatchUp({ threadId, sinceSeq }));
    measurement("thread.catchUp.all", () => reader.threadCatchUp({ threadId, sinceSeq: 0 }));
    measurement("items.window", () =>
      reader.itemsWindow({
        threadId,
        turnOrdinal: Math.max(1, Math.floor(options.turns / 2)),
        before: 50,
        after: 50,
      }),
    );
    const catchUp = reader.threadCatchUp({ threadId, sinceSeq: 0 });
    const coverage = reader.threadSearch({
      threadId,
      text: "migration",
      scope: "thread",
      limit: 1,
    });
    report({
      phase: "query-coverage",
      completedTurns: catchUp.turnsCompleted,
      indexedSeq: coverage.indexedSeq,
      headSeq: coverage.headSeq,
      ready: coverage.ready,
      pending: coverage.pending,
      blobHits: reader.threadSearch({ threadId, text: blobText, scope: "thread", limit: 30 }).hits
        .length,
      toolOutputHits: reader.threadSearch({
        threadId,
        text: outputText,
        scope: "thread",
        filter: "tool_output",
        limit: 30,
      }).hits.length,
      descendantHits: reader.threadSearch({
        threadId,
        text: "subagent-needle",
        scope: "tree",
        limit: 100,
      }).hits.length,
      catchUpDigest: catchUp.digest,
      initiatingMessagePreview: lastTurns.turns[0]?.initiatingMessagePreview,
      latestAgentMessagePreview: lastTurns.turns.at(-1)?.latestAgentMessagePreview,
    });
    globalThis.gc?.();
    report({ phase: "retained-after-gc", ...memory() });
    report({
      phase: "complete",
      boundedSeedBatchItems: 128,
      boundedSeedBatchBytes: 512 * 1024,
      ...memory(),
    });
  }
} finally {
  await store?.close();
  await rm(root, { recursive: true, force: true });
}
