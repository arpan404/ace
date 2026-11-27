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
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { randomUUID } from "node:crypto";
import {
  AgentItem,
  ThreadId,
  type EventPayload,
  type ServerMessage,
  type WorkspaceId,
} from "@ace/protocol";
import type { Fact } from "@ace/core";
import { Store, createDevThread } from "../src/index.ts";
import { EngineRepository } from "../src/engine/repository.ts";
import { createEngineThread } from "../src/engine/create-thread.ts";
import { subscribe } from "../src/subscription.ts";
import { migrateEngine } from "../src/engine/migrations.ts";
import { writeMeasurement } from "./output.ts";
import { installSplit, split, summarize, type Split } from "./sqlite-split.ts";

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
// `--split`: also split each read's time into SQLite, JSON.parse and the rest, record the heap
// the reads retain, and hold WAL checkpoints during the write phase so its WAL growth per
// commit can be read off, then time that checkpoint on its own.
const splitting = args.has("split");
if (splitting) installSplit();
const splits = new Map<string, Split[]>();
let phase = "";
const gc = () => (globalThis as { Bun?: { gc(full: boolean): void } }).Bun?.gc(true);
const heapMiB = () => {
  gc();
  return +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
};

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
  if (splitting && phase) {
    const [result, one] = split(run);
    const list = splits.get(phase) ?? [];
    list.push(one);
    splits.set(phase, list);
    return [result, one.wallMs];
  }
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
     WHERE t.archived_at IS NULL AND json_extract(t.client,'$.deletedAt') IS NULL
     GROUP BY t.id ORDER BY items DESC`,
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

/**
 * `engineCommit`: one thread's fold-and-save commits of a fixed batch (one message, ten appends,
 * a turn end), timed through the engine repository. Switch off runs `EngineRepository.apply`;
 * switch on needs the `engine-probe` build and runs the same batch through the probe's fold
 * (`ACE_ENGINE=native ACE_STORE=native`). The batch names no input, interaction or transition, so
 * the probe's pass-through collaborators do what the TypeScript ones do here: nothing. The figure
 * is printed beside the store's own timings; both sides fold equivalent work.
 */
function engineFacts(text: string, item: string): Fact[] {
  return [
    {
      type: "item.upsert",
      agent: "root",
      item,
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text }],
        complete: false,
      },
    },
    ...Array.from({ length: 10 }, (): Fact => ({
      type: "item.delta",
      agent: "root",
      item,
      field: "text",
      append: ` ${text}`,
    })),
    { type: "turn.ended", agent: "root", outcome: "completed" },
  ];
}

const engineCommitRows = (store: Store, id: ThreadId) =>
  store.atomic(
    (db) =>
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM engine_inputs WHERE thread_id=?) AS inputs,
                  (SELECT COUNT(*) FROM engine_interaction_requests WHERE thread_id=?) AS interactions,
                  (SELECT COUNT(*) FROM intents WHERE thread_id=?) AS intents`,
        )
        .get(id, id, id) as { inputs: number; interactions: number; intents: number },
  );

function engineCommitOff(store: Store, workspace: WorkspaceId, home: string) {
  const repo = new EngineRepository(store);
  const id = ThreadId.parse(randomUUID());
  createEngineThread(repo, {
    id,
    workspaceId: workspace,
    title: "Engine commit",
    selection: { provider: "codex", options: {} },
    cwd: home,
    at: Date.now(),
    silenceMs: 30_000,
  });
  const batch = engineFacts("bench", "bench-item");
  const samples: number[] = [];
  let at = Date.now();
  for (let index = 0; index < repeats; index++) {
    at += 1;
    samples.push(time(() => repo.apply(id, batch, at))[1]);
  }
  const rows = engineCommitRows(store, id);
  return { samples, balanced: rows.inputs + rows.interactions + rows.intents };
}

/** The same batch through the probe's fold: needs the `engine-probe` build. */
async function engineCommitOn(home: string) {
  const { engineSeam } = await import("../src/native-engine/testing.ts");
  const { createThreadState } = await import("@ace/core");
  const seam = await engineSeam({ options: { home } });
  try {
    await seam.engine.ready();
    seam.probe.passThroughCollaborators();
    const workspace = seam.store.createWorkspace(seam.home, "Bench");
    const thread = createDevThread(seam.store, workspace);
    const state = createThreadState({
      threadId: thread.id as never,
      rootAgent: {
        agent: "root" as never,
        fidelity: "full" as never,
        native: { provider: "codex", nativeId: "native-root" } as never,
        cwd: seam.home,
      },
      config: { provider: "codex", silenceMs: 30_000 },
    });
    seam.store.atomic((db) =>
      db
        .prepare("INSERT INTO thread_state VALUES (?, ?, 0)")
        .run(thread.id, JSON.stringify({ ...state, engineSnapshot: 9 })),
    );
    const batch = engineFacts("bench", "bench-item");
    const samples: number[] = [];
    let at = Date.now();
    for (let index = 0; index < repeats; index++) {
      at += 1;
      const start = performance.now();
      seam.probe.apply(thread.id, batch, at);
      samples.push(performance.now() - start);
    }
    const rows = engineCommitRows(seam.store, thread.id);
    return { samples, balanced: rows.inputs + rows.interactions + rows.intents };
  } finally {
    await seam.close();
  }
}

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
// A checkpoint worker that never answers: the WAL keeps every frame the write phase commits.
const heldCheckpoints = () => {
  const worker = {
    postMessage() {},
    on() {
      return worker;
    },
    terminate: async () => 0,
  };
  return worker;
};
const [store, openMs] = time(
  () =>
    new Store(
      path,
      (error) => console.error("store error", error),
      splitting ? { checkpointWorker: heldCheckpoints } : {},
    ),
);
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

phase = "sidebarPage";
// The app's sidebar: the first page after start, then repeats (served from its page cache
// until any write lands).
result.heapBeforeReadsMiB = splitting ? heapMiB() : undefined;
result.sidebarPageFirst = +time(() => store.sidebarPage({ limit: 20 }))[1].toFixed(3);
result.sidebarPage = stats(
  Array.from({ length: repeats }, () => time(() => store.sidebarPage({ limit: 20 }))[1]),
);

phase = "listThreads";
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

phase = "threadOpen";
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
const firstOpen = picked.map((row) => time(() => openThread(row.id))[0]);
result.threadOpenFirst = {
  ...stats(firstOpen.map((s) => s.ms)),
  bytes: firstOpen.map((s) => s.bytes),
};
result.threadOpenRepeat = stats(
  Array.from({ length: Math.max(1, Math.floor(repeats / 3)) }, () =>
    picked.map((row) => openThread(row.id).ms),
  ).flat(),
);

phase = "scrollBack";
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

phase = "turnsPage";
// Long-thread navigation: turn pages and the item window a client jumps to.
result.turnsPage = stats(
  picked.flatMap((row) =>
    Array.from(
      { length: 3 },
      () => time(() => store.turnsPage({ threadId: row.id, limit: 50 }))[1],
    ),
  ),
);
phase = "itemsWindow";
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
phase = "catchUp";
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
phase = "threadSearch";
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

phase = "";
result.readCpuMs = cpuMs(cpuStart);
if (splitting) {
  result.heapAfterReadsMiB = heapMiB();
  result.splits = Object.fromEntries([...splits].map(([name, list]) => [name, summarize(list)]));
}
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
const walBeforeWrites = store.streamingMetrics().walBytes;
const transactionsBeforeWrites = store.streamingMetrics().transactions;
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
if (splitting) {
  const metrics = store.streamingMetrics();
  const commitsWritten = metrics.transactions - transactionsBeforeWrites;
  const walGrowth = metrics.walBytes - walBeforeWrites;
  const checkpoint = new DatabaseSync(path);
  const [, passiveMs] = time(() => checkpoint.prepare("PRAGMA wal_checkpoint(PASSIVE)").get());
  checkpoint.close();
  result.walProbe = {
    commits: commitsWritten,
    walBytes: walGrowth,
    walBytesPerCommit: Math.round(walGrowth / Math.max(1, commitsWritten)),
    walPagesPerCommit: +(walGrowth / 4120 / Math.max(1, commitsWritten)).toFixed(1),
    checkpointPassiveMs: +passiveMs.toFixed(1),
  };
}

// `engineCommit`: the engine's own fold-and-save commits, switch off and (with the probe build
// and `ACE_ENGINE=native ACE_STORE=native`) on.
{
  const off = engineCommitOff(store, store.createWorkspace(path, "Engine commit"), path);
  const figure: Record<string, unknown> = {
    off: { ...stats(off.samples), rowsOutsideTheEngine: off.balanced },
  };
  if (engineBackend() === "native") {
    const on = await engineCommitOn(mkdtempSync(join(tmpdir(), "ace-engine-commit-")));
    figure.on = { ...stats(on.samples), rowsOutsideTheEngine: on.balanced, probe: true };
  }
  result.engineCommit = figure;
}

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
