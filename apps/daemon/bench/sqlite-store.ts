/**
 * Store timings on a copy of a real `events.sqlite`: open, sidebar, opening threads, paging
 * back through history, catch-up, in-thread search, streaming writes and file size.
 *
 * Point it at a disposable copy; the write phase adds a thread to it. On APFS, `cp -c` clones
 * a multi-gigabyte database instantly. Run the same script from each checkout so the imports
 * resolve to the implementation being measured:
 *
 *   cp -c events.sqlite /tmp/run.sqlite
 *   node apps/daemon/bench/sqlite-store.ts --db=/tmp/run.sqlite --output=result.json
 *
 * It sends no provider requests and opens no sockets.
 */
import { performance } from "node:perf_hooks";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AgentItem, ThreadId, type EventPayload, type ServerMessage } from "@ace/protocol";
import { Store, createDevThread } from "../src/index.ts";
import { subscribe } from "../src/subscription.ts";
import { migrateEngine } from "../src/engine/migrations.ts";
import { writeMeasurement } from "./output.ts";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    return [key ?? "", value];
  }),
);
const path = args.get("db");
if (!path) throw new Error("--db=PATH is required");
const output = args.get("output") ?? "";
const repeats = Number(args.get("repeats") ?? 15);
const writeItems = Number(args.get("write-items") ?? 200);
const deltasPerItem = Number(args.get("deltas") ?? 40);

const round = (n: number) => +n.toFixed(3);
function stats(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
    total: round(sorted.reduce((sum, value) => sum + value, 0)),
  };
}
function time<T>(run: () => T): [T, number] {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
}
function fileBytes(file: string): number {
  let total = 0;
  for (const suffix of ["", "-wal"])
    try {
      total += statSync(file + suffix).size;
    } catch {
      /* No WAL yet. */
    }
  return total;
}

// Pick the threads to read with a separate read-only connection, so the choice is the same
// for every implementation and costs the measured store nothing.
const probe = new DatabaseSync(path, { readOnly: true });
const sized = probe
  .prepare(
    `SELECT t.id AS id, COUNT(i.id) AS items, (MIN(i.created_seq) + MAX(i.created_seq)) / 2 AS mid
     FROM threads t JOIN items i ON i.thread_id=t.id
     WHERE t.archived_at IS NULL GROUP BY t.id ORDER BY items DESC`,
  )
  .all() as { id: string; items: number; mid: number }[];
probe.close();
const largest = sized.slice(0, 5);
const median = sized.slice(Math.floor(sized.length / 2) - 2, Math.floor(sized.length / 2) + 3);
const picked = [...largest, ...median].map((row) => ({
  id: ThreadId.parse(row.id),
  items: row.items,
  mid: row.mid,
}));

const result: Record<string, unknown> = {
  db: path,
  bytesBefore: fileBytes(path),
  threadsMeasured: picked.map((row) => row.items),
};

const cpuStart = process.cpuUsage();
const cpuMs = (since: NodeJS.CpuUsage) => {
  const used = process.cpuUsage(since);
  return +((used.user + used.system) / 1000).toFixed(1);
};
const [store, openMs] = time(() => new Store(path, (error) => console.error("store error", error)));
result.openMs = +openMs.toFixed(3);
// The engine opens its schema when the daemon starts; this includes its one-time upgrade passes.
result.engineOpenMs = +time(() => store.atomic(migrateEngine))[1].toFixed(3);
const live = () => {
  const row = store
    .statement("SELECT * FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()")
    .get() as { page_count: number; freelist_count: number; page_size: number };
  return (row.page_count - row.freelist_count) * row.page_size;
};
result.liveBytesBefore = live();
// Experiments only: `--pragmas="cache_size=-16384;wal_autocheckpoint=1000"` on the main connection.
const pragmas = (args.get("pragmas") ?? "").split(";").filter(Boolean);
for (const pragma of pragmas) store.statement(`PRAGMA ${pragma}`).all();
result.pragmas = pragmas;
// The daemon serves reads while search catches up; measure that catch-up, then read.
const backfillStart = performance.now();
await store.search.backfill(store, { signal: new AbortController().signal });
result.searchBackfillMs = +(performance.now() - backfillStart).toFixed(1);

// The app's sidebar: the first page after start, then repeats (served from its page cache
// until any write lands).
result.sidebarPageFirst = +time(() => store.sidebarPage({ limit: 20 }))[1].toFixed(3);
result.sidebarPage = stats(
  Array.from({ length: repeats }, () => time(() => store.sidebarPage({ limit: 20 }))[1]),
);

// Sidebar: the list every client loads first, then a windowed subscription like the app's.
result.listThreads = stats(
  Array.from({ length: repeats }, () => time(() => store.listThreads())[1]),
);
result.sidebarWindow = stats(
  Array.from({ length: repeats }, () => {
    let first = 0;
    const start = performance.now();
    const stop = subscribe(
      store,
      `sidebar-${randomUUID()}`,
      { kind: "threads", window: { limit: 50 } },
      undefined,
      50_000,
      () => {
        first ||= performance.now() - start;
      },
    );
    stop();
    return first || performance.now() - start;
  }),
);

// Opening a thread: the subscription snapshot a client receives when it opens one.
function openThread(id: ThreadId): { ms: number; bytes: number } {
  let bytes = 0;
  let ms = 0;
  const start = performance.now();
  const stop = subscribe(
    store,
    `thread-${randomUUID()}`,
    { kind: "thread", threadId: id },
    undefined,
    50_000,
    (message: ServerMessage) => {
      if (message.type === "snapshot" && !ms) {
        ms = performance.now() - start;
        bytes = JSON.stringify(message).length;
      }
    },
  );
  stop();
  return { ms: ms || performance.now() - start, bytes };
}
const firstOpen = picked.map((row) => openThread(row.id));
result.threadOpenFirst = {
  ...stats(firstOpen.map((s) => s.ms)),
  bytes: firstOpen.map((s) => s.bytes),
};
result.threadOpenRepeat = stats(
  Array.from({ length: Math.max(1, Math.floor(repeats / 3)) }, () =>
    picked.map((row) => openThread(row.id).ms),
  ).flat(),
);

// Scrolling back: 50-item pages from the newest item to the first, as the transcript does.
function scrollBack(id: ThreadId) {
  const pages: number[] = [];
  let before = Number.MAX_SAFE_INTEGER;
  for (let guard = 0; guard < 10_000; guard++) {
    const [page, ms] = time(() => store.readItemPage(id, before, 50));
    pages.push(ms);
    const next = page.itemsBefore;
    if (!page.items.length || next === null || next >= before) break;
    before = next;
  }
  return pages;
}
result.scrollBackPages = stats(largest.flatMap((row) => scrollBack(ThreadId.parse(row.id))));

// Long-thread navigation: turn pages and the item window a client jumps to.
result.turnsPage = stats(
  picked.flatMap((row) =>
    Array.from(
      { length: 3 },
      () => time(() => store.turnsPage({ threadId: row.id, limit: 50 }))[1],
    ),
  ),
);
result.itemsWindow = stats(
  picked.flatMap((row) =>
    Array.from(
      { length: 3 },
      () =>
        time(() =>
          store.itemsWindow({ threadId: row.id, aroundSeq: row.mid, before: 50, after: 50 }),
        )[1],
    ),
  ),
);
const head = store.headSeq();
result.catchUp = stats(
  picked.flatMap((row) =>
    Array.from(
      { length: 3 },
      () =>
        time(() =>
          store.threadCatchUp({ threadId: row.id, sinceSeq: Math.max(0, head - 20_000) }),
        )[1],
    ),
  ),
);
result.threadSearch = stats(
  largest.flatMap((row) =>
    ["error", "test", "function", "bun run"].map(
      (text) =>
        time(() =>
          store.threadSearch({
            threadId: ThreadId.parse(row.id),
            text,
            scope: "thread",
            limit: 30,
          }),
        )[1],
    ),
  ),
);

result.readCpuMs = cpuMs(cpuStart);
// Global search runs in the daemon's search workers; the first query includes their start.
const terms = ["error", "migration", "sqlite", "bun run test", "sidebar"];
const searchSamples: number[] = [];
const searchFailures: string[] = [];
for (const text of terms) {
  const start = performance.now();
  try {
    await store.searchQueries.query({ text, limit: 30 });
  } catch (error) {
    searchFailures.push(`${text}: ${error instanceof Error ? error.message : String(error)}`);
  }
  searchSamples.push(performance.now() - start);
}
result.globalSearchFirst = +(searchSamples[0] ?? 0).toFixed(3);
result.globalSearch = { ...stats(searchSamples.slice(1)), failures: searchFailures };

// Streaming writes, the way the engine writes a running agent: created and updated items
// commit at once; deltas go through the live write buffer, which flushes every 75 ms or at
// 64 KiB, and on any read.
const workspace = store.createWorkspace(`/bench/${randomUUID()}`, "bench");
const thread = createDevThread(store, workspace, "SQLite bench");
const appends: number[] = [];
const bytesBeforeWrites = fileBytes(path);
const text = "The quick brown fox jumps over the lazy dog. ".repeat(4);
const snapshot = { persist() {}, committed() {} };
const commits: number[] = [];
const writeStart = performance.now();
const writeCpu = process.cpuUsage();
const liveBeforeWrites = live();
for (let index = 0; index < writeItems; index++) {
  const id = randomUUID();
  const tool = index % 2 === 1;
  const item = AgentItem.parse(
    tool
      ? {
          id,
          agentId: "bench",
          type: "tool_call",
          createdAt: Date.now(),
          complete: false,
          call: {
            id,
            agentId: "bench",
            kind: "shell",
            title: "bun run test",
            status: "running",
            startedAt: Date.now(),
            raw: [],
            detail: { kind: "shell", command: "bun run test" },
          },
        }
      : {
          id,
          agentId: "bench",
          type: "message",
          role: "assistant",
          createdAt: Date.now(),
          complete: false,
          parts: [{ type: "text", text: "" }],
        },
  );
  commits.push(time(() => store.appendEvents(thread.id, [{ type: "item.created", item }]))[1]);
  for (let delta = 0; delta < deltasPerItem; delta++) {
    const payload: EventPayload = {
      type: "item.delta",
      itemId: item.id,
      agentId: item.agentId,
      field: tool ? "output" : "text",
      append: text,
    };
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    appends.push(
      time(() => {
        store.prepareLiveWrite(bytes);
        store.bufferLiveWrite(thread.id, [payload], Date.now(), snapshot);
      })[1],
    );
    // A provider streams tokens over time; let the buffer's timer flush between bursts.
    if (delta % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const done = AgentItem.parse(
    tool
      ? {
          ...item,
          complete: true,
          call: { ...(item as { call: object }).call, status: "succeeded" },
        }
      : { ...item, complete: true, parts: [{ type: "text", text: text.repeat(deltasPerItem) }] },
  );
  commits.push(
    time(() => store.appendEvents(thread.id, [{ type: "item.updated", item: done }]))[1],
  );
  if (index % 10 === 0)
    commits.push(
      time(() =>
        store.appendEvents(thread.id, [{ type: "thread.updated", title: `SQLite bench ${index}` }]),
      )[1],
    );
}
const [, flushMs] = time(() => store.flushLiveWrites());
const writeTotal = performance.now() - writeStart;
const writeCpuMs = cpuMs(writeCpu);
const liveWriteBytes = live() - liveBeforeWrites;
result.writes = {
  items: writeItems,
  deltas: appends.length,
  bufferedDelta: stats(appends),
  commit: stats(commits),
  totalMs: +writeTotal.toFixed(1),
  cpuMs: writeCpuMs,
  liveBytesPerItem: Math.round(liveWriteBytes / writeItems),
  flushMs: +flushMs.toFixed(3),
  eventsPerSecond: Math.round((appends.length + commits.length) / (writeTotal / 1000)),
  ...store.streamingMetrics(),
};
result.threadOpenAfterWrites = openThread(thread.id);

await store.close();
const after = new DatabaseSync(path);
after.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const pages = after
  .prepare("SELECT * FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()")
  .get() as Record<string, number>;
after.close();
result.bytesAfter = fileBytes(path);
result.writeBytesPerItem = Math.round(
  ((result.bytesAfter as number) - bytesBeforeWrites) / writeItems,
);
result.pages = pages;
result.rssMiB = Math.round(process.memoryUsage().rss / 1048576);

const json = JSON.stringify(result, null, 2);
console.log(json);
await writeMeasurement(output, json);
