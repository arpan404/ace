import { expect, test } from "vitest";
import { RowSnapshots, type SnapshotRows, type ThreadWrite } from "./row-snapshots.ts";
import type { KeptSnapshot } from "./snapshot-retention.ts";

/*
 * Read snapshots kept as rows (ADR 0105): each transcript item stored once, finished items
 * never written again, and what the policy no longer keeps let go.
 */

const day = 24 * 60 * 60 * 1000;

/** The platform's row store (`SnapshotStore.swift`) in memory, recording each thread write. */
class MemoryRows implements SnapshotRows {
  records = new Map<string, { text: string; used: number }>();
  threads = new Map<string, { head: string; settled: boolean; used: number }>();
  items = new Map<string, Map<string, string>>();
  writes: ThreadWrite[] = [];
  failNext = false;
  clock: { at: number };
  constructor(clock: { at: number }) {
    this.clock = clock;
  }
  async record(key: string) {
    const kept = this.records.get(key);
    if (kept) kept.used = this.clock.at;
    return kept?.text ?? "";
  }
  async setRecord(key: string, text: string) {
    this.records.set(key, { text, used: this.clock.at });
  }
  async thread(key: string) {
    const thread = this.threads.get(key);
    if (!thread) return undefined;
    thread.used = this.clock.at;
    const texts = [...(this.items.get(key)?.values() ?? [])];
    return { head: JSON.parse(thread.head), items: texts.map((text) => JSON.parse(text)) };
  }
  async putThread(write: ThreadWrite) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("storage");
    }
    this.writes.push(write);
    const items = write.replace
      ? new Map<string, string>()
      : (this.items.get(write.key) ?? new Map());
    for (const id of write.removed) items.delete(id);
    for (const item of write.items) items.set(item.id, item.text);
    this.items.set(write.key, items);
    this.threads.set(write.key, { head: write.head, settled: write.settled, used: this.clock.at });
  }
  async index(): Promise<KeptSnapshot[]> {
    return [
      ...[...this.records].map(([key, kept]) => ({
        key,
        kind: "record" as const,
        used: kept.used,
        bytes: kept.text.length,
        settled: false,
      })),
      ...[...this.threads].map(([key, thread]) => ({
        key,
        kind: "thread" as const,
        used: thread.used,
        bytes: thread.head.length,
        settled: thread.settled,
      })),
    ];
  }
  async drop(keys: readonly string[]) {
    for (const key of keys) {
      this.records.delete(key);
      this.threads.delete(key);
      this.items.delete(key);
    }
  }
  async clear() {
    this.records.clear();
    this.threads.clear();
    this.items.clear();
  }
}

function message(id: string, text: string, complete: boolean) {
  return { id, type: "message", role: "assistant", agentId: "root", createdAt: 1, text, complete };
}

function record(
  id: string,
  items: ReturnType<typeof message>[],
  status: { state: string } = { state: "working" },
  settledAt?: number,
) {
  return {
    version: 2,
    view: {
      seq: items.length,
      thread: { id, title: id, status, ...(settledAt === undefined ? {} : { settledAt }) },
      items: Object.fromEntries(items.map((item) => [item.id, item])),
      itemOrder: items.map((item) => item.id),
      itemSeqs: Object.fromEntries(items.map((item, index) => [item.id, index + 1])),
    },
    truncated: [],
  };
}

const ids = (write: ThreadWrite | undefined) => write?.items.map((item) => item.id);

test("a finished message is written once; only the streaming tail is written again", async () => {
  const clock = { at: day };
  const rows = new MemoryRows(clock);
  const snapshots = new RowSnapshots(rows, { now: () => clock.at });
  await snapshots.set(
    "host/thread:t",
    record("t", [message("a", "hi", true), message("b", "wo", false)]),
  );
  await snapshots.set(
    "host/thread:t",
    record("t", [message("a", "hi", true), message("b", "work", false)]),
  );
  await snapshots.set(
    "host/thread:t",
    record("t", [message("a", "hi", true), message("b", "worked", true)]),
  );
  await snapshots.set(
    "host/thread:t",
    record("t", [message("a", "hi", true), message("b", "worked", true), message("c", "", false)]),
  );
  expect(rows.writes.map(ids)).toEqual([["a", "b"], ["b"], ["b"], ["c"]]);
  expect(rows.items.get("host/thread:t")?.size).toBe(3);
});

test("a relaunch reads the thread back from its rows and never writes its finished items again", async () => {
  const clock = { at: day };
  const rows = new MemoryRows(clock);
  const value = record("t", [message("a", "hi", true), message("b", "wo", false)]);
  await new RowSnapshots(rows, { now: () => clock.at }).set("host/thread:t", value);

  const relaunched = new RowSnapshots(rows, { now: () => clock.at });
  expect(await relaunched.get("host/thread:t")).toEqual(value);
  await relaunched.set(
    "host/thread:t",
    record("t", [message("a", "hi", true), message("b", "wow", false)]),
  );
  expect(ids(rows.writes.at(-1))).toEqual(["b"]);
});

test("an item that leaves the thread leaves storage", async () => {
  const clock = { at: day };
  const rows = new MemoryRows(clock);
  const snapshots = new RowSnapshots(rows, { now: () => clock.at });
  await snapshots.set(
    "host/thread:t",
    record("t", [message("a", "hi", true), message("b", "x", true)]),
  );
  await snapshots.set("host/thread:t", record("t", [message("b", "x", true)]));
  expect([...(rows.items.get("host/thread:t")?.keys() ?? [])]).toEqual(["b"]);
});

test("after a failed write the next one replaces the thread whole", async () => {
  const clock = { at: day };
  const rows = new MemoryRows(clock);
  const snapshots = new RowSnapshots(rows, { now: () => clock.at });
  await snapshots.set("host/thread:t", record("t", [message("a", "hi", true)]));
  rows.failNext = true;
  await snapshots.set(
    "host/thread:t",
    record("t", [message("a", "hi", true), message("b", "x", true)]),
  );
  await snapshots.set(
    "host/thread:t",
    record("t", [message("a", "hi", true), message("b", "x", true)]),
  );
  const last = rows.writes.at(-1);
  expect(last?.replace).toBe(true);
  expect(ids(last)).toEqual(["a", "b"]);
});

test("a thread unused for seven days is gone at the next launch, and one used since stays", async () => {
  const clock = { at: day };
  const rows = new MemoryRows(clock);
  const first = new RowSnapshots(rows, { now: () => clock.at });
  await first.set("host/thread:old", record("old", [message("a", "hi", true)]));
  clock.at += 3 * day;
  await first.set("host/thread:recent", record("recent", [message("a", "hi", true)]));

  clock.at += 4 * day;
  await new RowSnapshots(rows, { now: () => clock.at }).expire();
  expect([...rows.threads.keys()]).toEqual(["host/thread:recent"]);
});

test("caching a twenty-first settled thread lets the least recently opened settled one go", async () => {
  const clock = { at: day };
  const rows = new MemoryRows(clock);
  const snapshots = new RowSnapshots(rows, { now: () => clock.at });
  await snapshots.expire();
  for (let index = 0; index < 21; index++) {
    clock.at += 1;
    await snapshots.set(
      `host/thread:s${index}`,
      record(`s${index}`, [message("a", "hi", true)], { state: "idle" }, 1),
    );
    await snapshots.expire();
  }
  clock.at += 1;
  await snapshots.set("host/thread:busy", record("busy", [message("a", "hi", false)]));
  await snapshots.expire();
  expect(rows.threads.has("host/thread:s0")).toBe(false);
  expect(rows.threads.has("host/thread:s1")).toBe(true);
  expect(rows.threads.has("host/thread:busy")).toBe(true);
  expect(rows.threads.size).toBe(21);
});

test("a whole-thread record from an earlier build is let go", async () => {
  const clock = { at: day };
  const rows = new MemoryRows(clock);
  await rows.setRecord("host/thread:t", JSON.stringify(record("t", [message("a", "hi", true)])));
  await rows.setRecord("host/sidebar", "[]");
  await new RowSnapshots(rows, { now: () => clock.at }).expire();
  expect([...rows.records.keys()]).toEqual(["host/sidebar"]);
});
