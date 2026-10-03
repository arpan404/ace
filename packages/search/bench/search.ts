import { AgentId } from "@ace/protocol";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { Event, Thread, Item } from "@ace/protocol";
import { SearchIndex } from "../src/index.ts";

const count = z.coerce
  .number()
  .int()
  .min(1000)
  .max(10_000_000)
  .parse(process.env.SEARCH_BENCH_ITEMS ?? 1_000_000);
const mode = z.enum(["both", "prose", "dual"]).parse(process.env.SEARCH_BENCH_MODE ?? "both");
if (!Number.isSafeInteger(count) || count < 1000)
  throw new Error("Set SEARCH_BENCH_ITEMS to at least 1000");
const directory = mkdtempSync(join(tmpdir(), "ace-search-bench-"));
const thread = Thread.parse({
  id: "benchthread",
  workspaceId: "benchworkspace",
  provider: "codex",
  title: "Compiler investigation",
  status: { state: "done" },
  createdAt: 1,
  updatedAt: 1,
});
const now = () => performance.now();
const event = (seq: number, payload: Event["payload"], threadId: string = thread.id) =>
  Event.parse({ seq, id: `event${seq}`, threadId, at: 1, payload });
function percentiles(samples: number[]) {
  samples.sort((a, b) => a - b);
  return {
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p99Ms: samples[Math.floor(samples.length * 0.99)],
  };
}
async function measure(trigrams: boolean) {
  const path = join(directory, trigrams ? "dual.sqlite" : "prose.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384");
  const search = new SearchIndex(db, { trigrams });
  const threadCount = Math.min(10000, count);
  for (let offset = 0; offset < threadCount; offset += 256) {
    const batch: Event[] = [];
    for (let i = offset; i < Math.min(offset + 256, threadCount); i++) {
      const current = Thread.parse({
        ...thread,
        id: `benchthread${i}`,
        workspaceId: `workspace${i % 100}`,
        title: `Compiler investigation ${i}`,
        createdAt: i + 1,
      });
      batch.push(event(i + 1, { type: "thread.created", thread: current }, current.id));
    }
    search.append(batch);
  }
  let peakRss = process.memoryUsage().rss;
  const start = now();
  for (let offset = 0; offset < count; offset += 256) {
    const batch: Event[] = [];
    for (let i = offset; i < Math.min(offset + 256, count); i++) {
      const item = Item.parse({
        id: `item${i}`,
        agentId: `agent${i % 32}`,
        type: "message",
        role: "assistant",
        createdAt: i + 2,
        complete: true,
        parts: [
          {
            type: "text",
            text: `Build compiler variant${i % 10000} shard${i % 997} fooBar snake_case /src/module${i % 1000}.ts 東京開発者 diagnostic${i}`,
          },
        ],
      });
      batch.push(
        event(i + threadCount + 1, { type: "item.created", item }, `benchthread${i % threadCount}`),
      );
    }
    search.append(batch);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (offset % 8192 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const seconds = (now() - start) / 1000;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const queries = ["diagnostic12345", "variant1234", "shard123", "compiler"];
  const latency: Record<string, ReturnType<typeof percentiles>> = {};
  for (const text of queries) {
    search.query({ text }); // Warm this query's statement and postings.
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = now();
      search.query({ text });
      samples.push(now() - started);
    }
    latency[text] = percentiles(samples);
  }
  if (trigrams)
    for (const text of ["/src/module123.ts", "oBar", "京開発"]) {
      const samples: number[] = [];
      for (let i = 0; i < 40; i++) {
        const started = now();
        search.query({ text, mode: "substring" });
        samples.push(now() - started);
      }
      latency[`substring:${text}`] = percentiles(samples);
    }
  for (const text of ["", "Comp"]) {
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = now();
      search.query({ text, scope: "threads" });
      samples.push(now() - started);
    }
    latency[`palette:${text || "recent"}`] = percentiles(samples);
  }
  const stream = Item.parse({
    id: "stream",
    agentId: "agent",
    type: "message",
    role: "assistant",
    createdAt: 2,
    complete: false,
    parts: [],
  });
  search.append([
    event(count + threadCount + 1, { type: "item.created", item: stream }, "benchthread0"),
  ]);
  const before = search.status(count + threadCount + 1).indexWrites;
  const streamStart = now();
  for (let i = 0; i < 10000; i++)
    search.append([
      event(
        count + threadCount + 2 + i,
        {
          type: "item.delta",
          itemId: stream.id,
          agentId: AgentId.parse(stream.agentId),
          field: "text",
          append: "streamChunk",
        },
        "benchthread0",
      ),
    ]);
  search.flush();
  const deltaSeconds = (now() - streamStart) / 1000;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const stats = {
    items: count,
    trigrams,
    threads: threadCount,
    indexSeconds: seconds,
    itemsPerSecond: count / seconds,
    deltaEventsPerSecond: 10000 / deltaSeconds,
    streamIndexWrites: search.status(count + threadCount + 10001).indexWrites - before,
    latency,
    databaseBytes: statSync(path).size,
    sampledPeakRssBytes: peakRss,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  db.close();
  process.stdout.write(JSON.stringify(stats) + "\n");
}
try {
  if (mode === "both") {
    for (const childMode of ["prose", "dual"])
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
          env: { ...process.env, SEARCH_BENCH_MODE: childMode },
          stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Benchmark exited ${code}`)),
        );
      });
  } else await measure(mode === "dual");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
