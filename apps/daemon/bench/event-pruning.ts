// Prunes a copy of a real events.sqlite and proves every thread still reads the same.
//
//   node apps/daemon/bench/event-pruning.ts <untouched-copy-dir> <copy-to-prune-dir>
//
// Both directories hold an `events.sqlite` cloned from the same file. Only the second is
// pruned. Never point either at a live data home.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Event, ThreadId } from "@ace/protocol";
import { applyDelivery, createThreadView, type ThreadView } from "@ace/projection";
import { Store } from "../src/store.ts";
import { StorageService } from "../src/storage/service.ts";
import { pruneProgress } from "../src/storage/event-pruning.ts";

const [baseDir, prunedDir] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
const size = async (dir: string) => {
  let bytes = 0;
  for (const name of ["events.sqlite", "events.sqlite-wal"])
    bytes += await stat(join(dir, name)).then(
      (file) => file.size,
      () => 0,
    );
  return bytes;
};
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`;
const count = (store: Store, sql: string) =>
  Number(Object.values(store.statement(sql).get() ?? {})[0]);

// ---- prune -------------------------------------------------------------------------------
const opened = performance.now();
const pruned = new Store(join(prunedDir, "events.sqlite"));
console.log(`open pruned copy: ${((performance.now() - opened) / 1000).toFixed(1)} s`);
const before = {
  file: await size(prunedDir),
  events: count(pruned, "SELECT COUNT(*) FROM events"),
  revisions: count(pruned, "SELECT COUNT(*) FROM history_item_revisions"),
};
let ids = 0;
const storage = new StorageService({
  root: prunedDir,
  now: () => Date.now(),
  id: () => `bench-${++ids}`,
  store: pruned,
  services: {},
});
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let started = performance.now();
const prune = await storage.prune(() => true);
const pruneMs = performance.now() - started;
const pruneDelay = delay.max / 1e6;
delay.reset();
started = performance.now();
const compaction = await storage.compact("bench");
const vacuumMs = performance.now() - started;
delay.disable();
const after = {
  file: await size(prunedDir),
  events: count(pruned, "SELECT COUNT(*) FROM events"),
  revisions: count(pruned, "SELECT COUNT(*) FROM history_item_revisions"),
};
console.log(
  JSON.stringify(
    {
      prune: { ...prune, seconds: +(pruneMs / 1000).toFixed(1), maxLoopBlockMs: pruneDelay },
      vacuum: {
        state: compaction.state,
        seconds: +(vacuumMs / 1000).toFixed(1),
        maxLoopBlockMs: delay.max / 1e6,
      },
      progress: pruneProgress((sql) => pruned.statement(sql)),
      before: { ...before, file: mb(before.file) },
      after: { ...after, file: mb(after.file) },
    },
    null,
    2,
  ),
);

// ---- equivalence ---------------------------------------------------------------------------
const base = new Store(join(baseDir, "events.sqlite"));
if (base.headSeq() !== pruned.headSeq()) throw new Error("The copies have different heads");
const head = base.headSeq();
function* events(store: Store, threadId: ThreadId): Generator<Event> {
  for (let cursor = 0; ;) {
    const page = store.readEvents({ afterSeq: cursor, threadId, limit: 4096 });
    if (!page.length) return;
    yield* page;
    cursor = page.at(-1)?.seq ?? head;
  }
}
function deliver(view: ThreadView, log: Iterable<Event>, throughSeq: number): ThreadView {
  const next = structuredClone(view);
  const batch = [...log].filter((event) => event.seq > next.seq && event.seq <= throughSeq);
  if (throughSeq <= next.seq) return next;
  const result = applyDelivery(next, {
    type: "events",
    subscriptionId: "bench",
    afterSeq: next.seq,
    throughSeq,
    events: batch,
  });
  if (result.kind !== "applied") throw new Error(`Delivery was ${result.kind}`);
  return next;
}
const shown = (view: ThreadView) => ({ order: view.itemOrder, items: view.items });
const attempt = <T>(read: () => T): T | { error: string } => {
  try {
    return read();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
function pages(store: Store, id: ThreadId) {
  const all: unknown[] = [];
  for (let older = head + 1; ;) {
    const page = store.readHistoricalItemPage(id, head, older, 200);
    all.push(page);
    if (page.itemsBefore === null) return all;
    older = page.itemsBefore;
  }
}

const threads = base
  .statement("SELECT id FROM threads ORDER BY id")
  .all()
  .map((row) => z.string().parse(row.id) as ThreadId);
const result = {
  threads: threads.length,
  replayEqual: 0,
  snapshotEqual: 0,
  historyEqual: 0,
  resumeByReplay: 0,
  resumeBySnapshot: 0,
  mismatches: [] as string[],
};
started = performance.now();
for (const id of threads) {
  const thread = base.getThread(id);
  if (!thread) continue;
  const empty = createThreadView(thread);
  const log = [...events(base, id)];
  const kept = [...events(pruned, id)];
  // Cursors a client could hold: the start, every 1/8th of the thread, and the end.
  const cursors = new Set([
    0,
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => log[Math.floor((log.length * n) / 8)]?.seq ?? 0),
  ]);
  const held = new Map<number, ThreadView>();
  let view = empty;
  for (const cursor of [...cursors].toSorted((a, b) => a - b)) {
    view = deliver(view, log, cursor);
    held.set(cursor, view);
  }
  const final = shown(deliver(view, log, head));
  if (isDeepStrictEqual(shown(deliver(empty, kept, head)), final)) result.replayEqual++;
  else result.mismatches.push(`${id}: full replay`);
  const snapshot = attempt(() => base.snapshotThread(id));
  if (
    isDeepStrictEqual(
      attempt(() => pruned.snapshotThread(id)),
      snapshot,
    )
  )
    result.snapshotEqual++;
  else result.mismatches.push(`${id}: snapshot`);
  if (
    isDeepStrictEqual(
      attempt(() => pages(pruned, id)),
      attempt(() => pages(base, id)),
    )
  )
    result.historyEqual++;
  else result.mismatches.push(`${id}: history pages`);
  for (const [cursor, held_] of held) {
    if (!pruned.replaySafe(cursor)) {
      result.resumeBySnapshot++;
      continue;
    }
    result.resumeByReplay++;
    if (!isDeepStrictEqual(shown(deliver(held_, kept, head)), final))
      result.mismatches.push(`${id}: resume from ${cursor}`);
  }
}
console.log(
  JSON.stringify(
    { ...result, seconds: +((performance.now() - started) / 1000).toFixed(1) },
    null,
    2,
  ),
);
await base.close();
await storage.close();
await pruned.close();
if (result.mismatches.length) process.exitCode = 1;
