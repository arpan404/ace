import { Item, ThreadId, type ItemsWindowResponse } from "@ace/protocol";
import { expect, test } from "vitest";
import type { ThreadExport } from "./api.ts";
import { RowSnapshots, type SnapshotRows, type ThreadWrite } from "./row-snapshots.ts";
import { deviceRetention, type KeptSnapshot } from "./snapshot-retention.ts";
import { ThreadArchives } from "./thread-archives.ts";
import type { Scheduler } from "./types.ts";

/*
 * The archives a client keeps (ADR 0225), through the phone's real row storage: kept across a
 * restart, dropped for another daemon database, and let go from memory only once written.
 */

const seqOf = (n: number) => n * 10;
const notice = (n: number, complete = true): Item =>
  Item.parse({
    id: `item-${n}`,
    agentId: "root",
    type: "notice",
    level: "info",
    text: `notice ${n} ${"x".repeat(200)}`,
    raw: [],
    createdAt: n,
    complete,
  });
const numbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The daemon's reply to an older read of items a..b, b its target. */
function reply(thread: string, a: number, b: number): ItemsWindowResponse {
  const items = numbers(a, b).map((n) => notice(n));
  return {
    type: "items.window",
    requestId: "r",
    threadId: ThreadId.parse(thread),
    seq: seqOf(1_000),
    targetSeq: seqOf(b),
    items,
    itemSeqs: Object.fromEntries(items.map((item, i) => [item.id, seqOf(a + i)])),
    itemsBefore: seqOf(a),
    itemsAfter: seqOf(b),
  };
}

/** `SnapshotStore.swift` in memory. */
class MemoryRows implements SnapshotRows {
  records = new Map<string, string>();
  heads = new Map<string, string>();
  items = new Map<string, Map<string, string>>();
  async record(key: string) {
    return this.records.get(key) ?? "";
  }
  async setRecord(key: string, text: string) {
    this.records.set(key, text);
  }
  async thread(key: string) {
    const head = this.heads.get(key);
    if (!head) return undefined;
    return {
      head: JSON.parse(head),
      items: [...(this.items.get(key)?.values() ?? [])].map((text) => JSON.parse(text)),
    };
  }
  async putThread(write: ThreadWrite) {
    const items = write.replace
      ? new Map<string, string>()
      : (this.items.get(write.key) ?? new Map());
    for (const id of write.removed) items.delete(id);
    for (const item of write.items) items.set(item.id, item.text);
    this.items.set(write.key, items);
    this.heads.set(write.key, write.head);
  }
  async index(): Promise<KeptSnapshot[]> {
    return [...this.heads.keys()].map((key) => ({
      key,
      kind: "thread",
      used: 0,
      bytes: 0,
      settled: false,
    }));
  }
  async drop(keys: readonly string[]) {
    for (const key of keys) {
      this.heads.delete(key);
      this.items.delete(key);
      this.records.delete(key);
    }
  }
  async clear() {
    this.records.clear();
    this.heads.clear();
    this.items.clear();
  }
  async size() {
    return 0;
  }
}

/** Timers that run only when the test says so. */
class ManualScheduler implements Scheduler {
  #due: (() => void)[] = [];
  set(_delayMs: number, callback: () => void) {
    this.#due.push(callback);
    return () => {
      this.#due = this.#due.filter((due) => due !== callback);
    };
  }
  async run() {
    const due = this.#due;
    this.#due = [];
    for (const callback of due) callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setup(rows = new MemoryRows(), memoryBytes?: number) {
  const scheduler = new ManualScheduler();
  const storage = new RowSnapshots(rows, { now: () => 0, policy: deviceRetention });
  const archives = new ThreadArchives(storage, scheduler, memoryBytes ? { memoryBytes } : {});
  return { rows, scheduler, archives };
}
const older = (thread: string, aroundSeq: number) => ({
  threadId: thread,
  aroundSeq,
  before: 199,
  after: 0,
});

test("history read before a restart is answered from the phone after it", async () => {
  const first = setup();
  await first.archives.merge(reply("t", 100, 300));
  await first.archives.close();
  const second = setup(first.rows);
  const answer = await second.archives.window(older("t", seqOf(250)));
  expect(answer?.reply.items).toHaveLength(151);
  expect(answer?.confirmed).toBe(false);
});

const big = (n: number) => Item.parse({ ...notice(n), text: `${n} ${"y".repeat(40_000)}` });

test("an archive larger than one native write is kept whole", async () => {
  const first = setup();
  const items = numbers(1, 199);
  const window = reply("t", 1, 199);
  await first.archives.merge({ ...window, items: items.map(big) });
  await first.archives.close();
  const second = setup(first.rows);
  expect((await second.archives.window(older("t", seqOf(199))))?.reply.items).toHaveLength(199);
});

test("an archive read under another daemon database is dropped", async () => {
  const first = setup();
  first.archives.connected("db-a");
  await first.archives.merge(reply("t", 100, 300));
  await first.archives.close();
  const second = setup(first.rows);
  second.archives.connected("db-b");
  expect(await second.archives.window(older("t", seqOf(250)))).toBeUndefined();
  expect(first.rows.heads.size).toBe(0);
});

test("history read on one connection is checked again after the phone reconnects", async () => {
  const { archives } = setup();
  archives.connected("db-a");
  await archives.merge(reply("t", 100, 300));
  expect((await archives.window(older("t", seqOf(250))))?.confirmed).toBe(true);
  archives.connected("db-a");
  const answer = await archives.window(older("t", seqOf(250)));
  expect(answer?.reply.items).toHaveLength(151);
  expect(answer?.confirmed).toBe(false);
  await archives.merge(reply("t", 100, 300));
  expect((await archives.window(older("t", seqOf(250))))?.confirmed).toBe(true);
});

test("a confirmed live store's items join the archive; an unconfirmed one's don't", async () => {
  const { archives } = setup();
  const view = (unconfirmed: boolean): ThreadExport => ({
    ...(unconfirmed ? { unconfirmed: true } : {}),
    error: undefined,
    truncated: [],
    view: {
      seq: seqOf(400),
      thread: undefined as never,
      agents: {},
      agentChildren: {},
      runs: {},
      items: Object.fromEntries(numbers(301, 400).map((n) => [`item-${n}`, notice(n)])),
      itemOrder: numbers(301, 400).map((n) => `item-${n}`),
      itemSeqs: Object.fromEntries(numbers(301, 400).map((n) => [`item-${n}`, seqOf(n)])),
      itemsBefore: seqOf(301),
      interactions: {},
      backgroundTasks: {},
      usage: {},
      usageSnapshots: {},
    } as unknown as ThreadExport["view"],
  });
  await archives.keep("t", view(true));
  expect(await archives.window(older("t", seqOf(350)))).toBeUndefined();
  await archives.keep("t", view(false));
  await archives.merge(reply("t", 200, 301));
  // The daemon's older read meets the store's tail: one run from item 200 to item 400.
  expect((await archives.window(older("t", seqOf(390))))?.reply.items).toHaveLength(191);
});

test("memory lets go of a written thread, never one with changes still unwritten", async () => {
  const { rows, scheduler, archives } = setup(new MemoryRows(), 1);
  await archives.merge(reply("a", 100, 150));
  await archives.merge(reply("b", 100, 150));
  await archives.merge(reply("c", 100, 150));
  // Nothing is on disk yet, so every thread is still answered from memory.
  expect(rows.heads.size).toBe(0);
  expect(await archives.window(older("b", seqOf(120)))).toBeDefined();
  expect(await archives.window(older("a", seqOf(120)))).toBeDefined();
  await scheduler.run();
  await rows.clear();
  // Written, the threads used longest ago went from memory; the one used last stayed.
  expect(await archives.window(older("a", seqOf(120)))).toBeDefined();
  expect(await archives.window(older("b", seqOf(120)))).toBeUndefined();
});

test("a forgotten thread's archive is gone from memory and from disk", async () => {
  const { rows, scheduler, archives } = setup();
  await archives.merge(reply("t", 100, 300));
  await scheduler.run();
  await archives.forget("t");
  expect(await archives.window(older("t", seqOf(250)))).toBeUndefined();
  expect(rows.heads.size).toBe(0);
});
