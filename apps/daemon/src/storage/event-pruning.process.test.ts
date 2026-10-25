import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { AgentId, AgentItem, ItemId, type Event, type ThreadId } from "@ace/protocol";
import { applyDelivery, createThreadView, type ThreadView } from "@ace/projection";
import type { Store } from "../store.ts";
import { message, shell } from "../payload-test-support.ts";
import { storageFixture } from "./test-support.ts";

vi.setConfig({ testTimeout: 30_000 });
/** Pruning applies to everything older than the fixture clock, right up to the head. */
export const pruneLimits = {
  prune: { updates: 2, deletions: 1024, maxBatches: 8192, minAgeMs: 86_400_000, headMargin: 0 },
};
const fixtures: Awaited<ReturnType<typeof storageFixture>>[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function open(root?: string, limits: object = pruneLimits) {
  const fixture = await storageFixture(root, undefined, { limits });
  fixtures.push(fixture);
  return fixture;
}
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-pruning-")));
  roots.push(root);
  return root;
}

const root = AgentId.parse("root");
const old = 1_000;
const delta = (itemId: string, field: "text" | "output", append: string) =>
  ({ type: "item.delta", itemId: ItemId.parse(itemId), agentId: root, field, append }) as const;
const streaming = (id: string, text: string, complete: boolean) =>
  AgentItem.parse({ ...message(id, text), complete });

/**
 * A thread whose items stream and settle the way providers report them: a message that
 * streams and then settles, a shell whose output keeps arriving after its final update, and a
 * message that only ever streams. Returns the thread id.
 */
function busyThread(store: Store, thread: { id: ThreadId }, at = old): ThreadId {
  const append = (...payloads: Parameters<Store["appendEvents"]>[1]) =>
    store.appendEvents(thread.id, payloads, at);
  for (let round = 0; round < 3; round++) {
    const answer = `${thread.id}-answer-${round}`;
    const command = `${thread.id}-shell-${round}`;
    append({ type: "item.created", item: streaming(answer, "", false) });
    append({ type: "item.created", item: shell(command) });
    for (let part = 0; part < 4; part++) {
      append(delta(answer, "text", `word ${part} `));
      append(delta(command, "output", `line ${part}\n`));
    }
    append({ type: "item.updated", item: streaming(answer, "word 0 word 1 ", false) });
    append(delta(answer, "text", "word 2 word 3 "));
    append({ type: "item.updated", item: streaming(answer, "word 0 word 1 word 2 word 3", true) });
    const running = shell(command);
    if (running.type !== "tool_call") throw new Error("Expected a shell");
    append({ type: "item.updated", item: { ...running, complete: true } });
    append(delta(command, "output", "late output\n"));
  }
  const unsettled = `${thread.id}-unsettled`;
  append({ type: "item.created", item: streaming(unsettled, "", false) });
  append(delta(unsettled, "text", "still "), delta(unsettled, "text", "typing"));
  return thread.id;
}

function events(store: Store, threadId: ThreadId, afterSeq = 0): Event[] {
  return store.readEvents({ afterSeq, threadId, limit: 100_000 });
}
/** What a client holds after applying `log` on top of `view`, the way deliveries arrive. */
function deliver(view: ThreadView, log: Event[], throughSeq: number): ThreadView {
  const next = structuredClone(view);
  if (throughSeq <= next.seq) return next;
  const result = applyDelivery(next, {
    type: "events",
    subscriptionId: "test",
    afterSeq: next.seq,
    throughSeq,
    events: log.filter((event) => event.seq > next.seq && event.seq <= throughSeq),
  });
  if (result.kind !== "applied") throw new Error(`Delivery was ${result.kind}`);
  return next;
}
function shown(view: ThreadView) {
  return { order: view.itemOrder, items: view.items };
}
function count(store: Store, sql: string): number {
  return Number(Object.values(store.statement(sql).get() ?? {})[0]);
}

test("compaction drops item events a later full update replaces, and a full replay shows the same items", async () => {
  const f = await open();
  const id = busyThread(f.store, f.thread("busy"));
  const before = events(f.store, id);
  const head = f.store.headSeq();
  const replayed = shown(
    deliver(createThreadView(f.store.snapshotThread(id).thread), before, head),
  );
  const snapshot = f.store.snapshotThread(id);
  const page = f.store.readHistoricalItemPage(id, head, head + 1, 200);

  const compaction = await f.storage.compact("owner");

  expect(compaction.state).toBe("complete");
  const after = events(f.store, id);
  // Per round: 4 text and 4 output deltas, the replaced update and the delta after it.
  expect(before.length - after.length).toBe(3 * 10);
  expect(compaction.eventsPruned).toBe(3 * 10);
  expect(compaction.revisionsPruned).toBeGreaterThan(0);
  expect(after.filter((event) => event.payload.type === "item.created")).toHaveLength(7);
  // Output after a final update and an item that never settled keep every delta.
  expect(after.filter((event) => event.payload.type === "item.delta")).toHaveLength(3 + 2);
  // Every surviving row is unchanged.
  const original = new Map(before.map((event) => [event.seq, event]));
  for (const event of after) expect(event).toEqual(original.get(event.seq));
  expect(shown(deliver(createThreadView(snapshot.thread), after, head))).toEqual(replayed);
  expect(f.store.snapshotThread(id)).toEqual(snapshot);
  expect(f.store.readHistoricalItemPage(id, head, head + 1, 200)).toEqual(page);
});

test("a client resuming from any earlier cursor ends with the same items, through replay or a fresh snapshot", async () => {
  const f = await open();
  const id = busyThread(f.store, f.thread("resume"));
  const head = f.store.headSeq();
  const before = events(f.store, id);
  const empty = createThreadView(f.store.snapshotThread(id).thread);
  const final = shown(deliver(empty, before, head));
  const snapshot = f.store.snapshotThread(id);
  // Every view a client could have held, at every cursor the thread ever had.
  const held = [0, ...before.map((event) => event.seq)].map((cursor) => ({
    cursor,
    view: deliver(empty, before, cursor),
  }));

  expect((await f.storage.compact("owner")).eventsPruned).toBeGreaterThan(0);

  let replayed = 0;
  let snapshots = 0;
  for (const { cursor, view } of held) {
    if (!f.store.replaySafe(cursor)) {
      // The subscription answers a removed cursor with a fresh snapshot.
      snapshots++;
      expect(f.store.snapshotThread(id)).toEqual(snapshot);
      continue;
    }
    replayed++;
    expect(shown(deliver(view, events(f.store, id, cursor), head)), `cursor ${cursor}`).toEqual(
      final,
    );
  }
  expect(replayed).toBeGreaterThan(0);
  expect(snapshots).toBeGreaterThan(0);
});

test("events from the last day stay", async () => {
  const f = await open();
  const recent = busyThread(f.store, f.thread("recent"), f.now());
  const total = events(f.store, recent).length;
  expect((await f.storage.compact("owner")).eventsPruned).toBe(0);
  expect(events(f.store, recent)).toHaveLength(total);
});

test("events the long-thread index has not read yet stay until it catches up", async () => {
  const f = await open();
  const lagging = busyThread(f.store, f.thread("lagging"));
  const total = events(f.store, lagging).length;
  const indexed = count(f.store, "SELECT seq FROM long_meta WHERE id=1");
  f.store.statement("UPDATE long_meta SET seq=0 WHERE id=1").run();
  expect((await f.storage.compact("owner")).eventsPruned).toBe(0);
  expect(events(f.store, lagging)).toHaveLength(total);
  f.store.statement("UPDATE long_meta SET seq=? WHERE id=1").run(indexed);
  expect((await f.storage.compact("owner")).eventsPruned).toBe(3 * 10);
});

test("pruning continues from its stored cursor in later runs and finds nothing left to do", async () => {
  const f = await open(undefined, { prune: { ...pruneLimits.prune, updates: 1, maxBatches: 2 } });
  const id = busyThread(f.store, f.thread("steps"));
  const total = events(f.store, id).length;
  const first = await f.storage.prune(() => true);
  expect(first.done).toBe(false);
  let removed = first.events;
  for (let run = 0; run < 64; run++) {
    const next = await f.storage.prune(() => true);
    removed += next.events;
    if (next.done) break;
  }
  expect(removed).toBe(3 * 10);
  expect(events(f.store, id)).toHaveLength(total - removed);
  expect((await f.storage.prune(() => true)).events).toBe(0);
});

test("an item with more replaced rows than one batch may delete is pruned across batches to the same result", async () => {
  const f = await open(undefined, {
    prune: { ...pruneLimits.prune, updates: 64, deletions: 1 },
  });
  const id = busyThread(f.store, f.thread("budget"));
  const head = f.store.headSeq();
  const before = events(f.store, id);
  const empty = createThreadView(f.store.snapshotThread(id).thread);
  const final = shown(deliver(empty, before, head));
  expect((await f.storage.compact("owner")).eventsPruned).toBe(3 * 10);
  const after = events(f.store, id);
  expect(after).toHaveLength(before.length - 3 * 10);
  expect(shown(deliver(empty, after, head))).toEqual(final);
});

const crash = (path: string) =>
  promisify(execFile)(process.execPath, [
    join(import.meta.dirname, "crash-worker.ts"),
    path,
    "prune",
  ]);

test("a kill mid-pruning leaves an intact database that resumes to the same result", async () => {
  const path = await directory();
  const f = await storageFixture(path, undefined, { limits: pruneLimits });
  const id = busyThread(f.store, f.thread("crash"));
  const head = f.store.headSeq();
  const before = events(f.store, id);
  const empty = createThreadView(f.store.snapshotThread(id).thread);
  const final = shown(deliver(empty, before, head));
  const snapshot = f.store.snapshotThread(id);
  await f.close();

  await expect(crash(path)).rejects.toMatchObject({ signal: "SIGKILL" });
  const db = new DatabaseSync(join(path, "events.sqlite"));
  try {
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  } finally {
    db.close();
  }

  const restarted = await open(path);
  const partial = events(restarted.store, id).length;
  // The first batch committed with its cursor; the rest had not run.
  expect(partial).toBeLessThan(before.length);
  expect(partial).toBeGreaterThan(before.length - 3 * 10);
  expect(restarted.store.statement("SELECT state FROM storage_compactions").get()?.state).toBe(
    "running",
  );
  await restarted.storage.resume();
  expect(restarted.store.statement("SELECT state FROM storage_compactions").get()?.state).toBe(
    "complete",
  );
  const after = events(restarted.store, id);
  expect(after).toHaveLength(before.length - 3 * 10);
  expect(shown(deliver(empty, after, head))).toEqual(final);
  expect(restarted.store.snapshotThread(id)).toEqual(snapshot);
});
