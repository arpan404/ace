import { expect, test } from "vitest";
import { Event, ThreadId } from "@ace/protocol";
import {
  harness,
  holding,
  list,
  memory,
  record,
  stored,
  thread,
  view,
} from "./read-snapshots.fixture.ts";

const text = (store: { item(id: string): unknown }, id: string) => {
  const item = store.item(id);
  if (typeof item !== "object" || item === null || !("parts" in item)) return undefined;
  const parts = item.parts;
  return Array.isArray(parts) ? parts.map((part: { text?: string }) => part.text).join("") : "";
};

test("reload paints persisted messages while syncing and always reconciles from a fresh wire", async () => {
  const m = memory();
  m.values.set(stored("thread:thread"), record());
  const f = harness(m.storage);
  const lease = f.client.thread("thread");
  await expect.poll(() => lease.store.thread?.title).toBe("Cached");
  expect(lease.store.syncing).toBe(true);
  expect(lease.store.order).toEqual(["answer"]);
  await f.start();
  const wire = f.wire("thread");
  expect(wire.afterSeq).toBeUndefined();
  // A daemon crash can lose the cached live tail: an authoritative lower cursor replaces it.
  f.deliver({
    type: "snapshot",
    subscriptionId: wire.subscriptionId,
    seq: 5,
    view: view("Reconciled", 5),
  });
  await expect.poll(() => lease.store.thread?.title).toBe("Reconciled");
  expect(lease.store.syncing).toBe(false);
  lease.release();
  const warm = f.client.thread("thread");
  expect(warm.store.thread?.title).toBe("Reconciled");
  expect(f.wire("thread").afterSeq).toBe(5);
  warm.release();
  await f.client.close();
});

test("a cached thread restores in creation order and merges with the live snapshot by sequence", async () => {
  const m = memory();
  m.values.set(
    stored("thread:thread"),
    record(
      holding(
        [
          ["first", 3, "First"],
          ["second", 5, "Second"],
          ["third", 7, "Third (cached)"],
        ],
        { seq: 10, itemsBefore: 3 },
      ),
    ),
  );
  const f = harness(m.storage);
  const lease = f.client.thread("thread");
  await expect.poll(() => lease.store.order).toEqual(["first", "second", "third"]);
  expect(lease.store.itemSeq("second")).toBe(5);
  await f.start();
  // The daemon's window starts inside what was cached: the two meet with no hole.
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("thread").subscriptionId,
    seq: 20,
    view: holding(
      [
        ["third", 7, "Third (live)"],
        ["fourth", 9, "Fourth"],
        ["fifth", 12, "Fifth"],
      ],
      { title: "Live", seq: 20, itemsBefore: 7 },
    ),
  });
  await expect.poll(() => lease.store.thread?.title).toBe("Live");
  expect(lease.store.order).toEqual(["first", "second", "third", "fourth", "fifth"]);
  expect(text(lease.store, "third")).toBe("Third (live)");
  // Every cached item is complete back to its cursor, so older history pages from there.
  expect(lease.store.itemsBefore).toBe(3);
  expect(lease.store.syncing).toBe(false);
  await f.client.close();
});

test("a cached view the live window does not reach is replaced, never joined across a hole", async () => {
  const m = memory();
  m.values.set(
    stored("thread:thread"),
    record(holding([["old", 3, "Old"]], { seq: 10, itemsBefore: 3 })),
  );
  const f = harness(m.storage);
  const lease = f.client.thread("thread");
  await expect.poll(() => lease.store.order).toEqual(["old"]);
  await f.start();
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("thread").subscriptionId,
    seq: 90,
    view: holding([["new", 80, "New"]], { title: "Live", seq: 90, itemsBefore: 80 }),
  });
  await expect.poll(() => lease.store.thread?.title).toBe("Live");
  expect(lease.store.order).toEqual(["new"]);
  expect(lease.store.itemsBefore).toBe(80);
  await f.client.close();
});

test("a late disk read never overwrites an accepted live thread snapshot", async () => {
  let resolve: ((value: unknown) => void) | undefined;
  const f = harness({
    get: () =>
      new Promise((done) => {
        resolve = done;
      }),
    set: async () => {},
  });
  const lease = f.client.thread("thread");
  await f.start();
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("thread").subscriptionId,
    seq: 10,
    view: view("Live"),
  });
  await expect.poll(() => lease.store.thread?.title).toBe("Live");
  resolve?.(record(view("Stale")));
  await Promise.resolve();
  expect(lease.store.thread?.title).toBe("Live");
  await f.client.close();
});

const { itemSeqs: _dropped, ...withoutSeqs } = view();
test.each([
  { name: "an older build's record", cached: { version: 1, view: view() } },
  { name: "a record without creation sequences", cached: { version: 2, view: withoutSeqs } },
  {
    name: "a record missing one item's sequence",
    cached: record(
      Object.assign(holding([["a", 1, "A"]]), {
        itemOrder: ["a", "b"],
        items: { ...holding([["a", 1, "A"]]).items, ...holding([["b", 2, "B"]]).items },
      }),
    ),
  },
  {
    name: "a record out of creation order",
    cached: record(
      holding([
        ["b", 2, "B"],
        ["a", 1, "A"],
      ]),
    ),
  },
  { name: "a future version", cached: { version: 3, view: view() } },
  { name: "a malformed view", cached: { version: 2, view: { broken: true } } },
  {
    name: "another thread's view",
    cached: record({ ...view(), thread: { ...thread, id: ThreadId.parse("other") } }),
  },
])("$name is ignored and the thread starts from the daemon", async ({ cached }) => {
  const m = memory();
  m.values.set(stored("thread:thread"), cached);
  const f = harness(m.storage);
  const lease = f.client.thread("thread");
  await f.start();
  expect(lease.store.thread).toBeUndefined();
  expect(lease.store.order).toEqual([]);
  expect(f.wire("thread").afterSeq).toBeUndefined();
  await f.client.close();
});

test("streaming schedules one snapshot of the latest text", async () => {
  const m = memory();
  const f = harness(m.storage);
  const lease = f.client.thread("thread");
  await f.start();
  const wire = f.wire("thread");
  f.deliver({ type: "snapshot", subscriptionId: wire.subscriptionId, seq: 10, view: view() });
  await expect.poll(() => lease.store.cursor).toBe(10);
  for (let seq = 11; seq <= 30; seq++)
    f.deliver({
      type: "events",
      subscriptionId: wire.subscriptionId,
      afterSeq: seq - 1,
      throughSeq: seq,
      events: [
        Event.parse({
          id: `e-${seq}`,
          threadId: "thread",
          seq,
          at: seq,
          payload: {
            type: "item.delta",
            agentId: "root",
            itemId: "answer",
            field: "text",
            append: "!",
          },
        }),
      ],
    });
  await expect.poll(() => lease.store.cursor).toBe(30);
  expect(m.values.size).toBe(0);
  f.flush();
  await expect.poll(() => m.values.has(stored("thread:thread"))).toBe(true);
  const reloaded = harness(m.storage);
  const restored = reloaded.client.thread("thread");
  await expect.poll(() => restored.store.cursor).toBe(30);
  expect(text(restored.store, "answer")).toBe(`hello${"!".repeat(20)}`);
  expect(restored.store.itemSeq("answer")).toBe(1);
  await f.client.close();
  await reloaded.client.close();
});

test("cached sidebar paints before the network and reconciles removed rows", async () => {
  const m = memory();
  m.values.set(stored("sidebar:[null,false]"), { version: 2, home: list() });
  const f = harness(m.storage);
  const lease = f.client.threads();
  await expect.poll(() => lease.store.loaded).toBe(true);
  expect(lease.store.ids).toEqual(["thread"]);
  expect(lease.store.syncing).toBe(true);
  await f.start();
  expect(lease.store.syncing).toBe(true);
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("threads").subscriptionId,
    seq: 5,
    view: { kind: "threads", seq: 5, threads: {} },
  });
  await expect.poll(() => lease.store.ids.length).toBe(0);
  expect(lease.store.loaded).toBe(true);
  expect(lease.store.syncing).toBe(false);
  await f.client.close();
});

test("an older build's sidebar record is ignored", async () => {
  const m = memory();
  m.values.set(stored("sidebar:[null,false]"), { version: 1, home: list() });
  const f = harness(m.storage);
  const lease = f.client.threads();
  await f.start();
  expect(lease.store.loaded).toBe(false);
  await f.client.close();
});

test("an evicted thread cannot restore after its replacement takes the bounded cache", async () => {
  let resolve: ((value: unknown) => void) | undefined;
  const f = harness(
    {
      get: () =>
        new Promise((done) => {
          resolve = done;
        }),
      set: async () => {},
    },
    1,
  );
  const first = f.client.thread("thread");
  const late = resolve;
  first.release();
  f.client.thread("other");
  late?.(record());
  await Promise.resolve();
  expect(first.store.thread).toBeUndefined();
  await f.client.close();
});

test("sidebar filter changes fence a late cached list from the previous project", async () => {
  const pending = new Map<string, (value: unknown) => void>();
  const f = harness({
    get: (key) => new Promise((resolve) => pending.set(key, resolve)),
    set: async () => {},
  });
  const collection = f.client.threadsCollection();
  const lease = collection.threads();
  await collection.threadsWindow({ project: "selected" });
  pending.get(stored("sidebar:[null,false]"))?.({ version: 2, home: list("Wrong project") });
  await Promise.resolve();
  expect(lease.store.loaded).toBe(false);
  pending.get(stored('sidebar:["selected",false]'))?.({ version: 2, home: list("Selected") });
  await expect.poll(() => lease.store.thread("thread")?.title).toBe("Selected");
  expect(lease.store.syncing).toBe(true);
  collection.close();
  await f.client.close();
});

test("an archived filter persists only its half and an archive-only record paints at once", async () => {
  const m = memory();
  m.values.set(stored("sidebar:[null,true]"), { version: 2, archive: list("Archived") });
  const f = harness(m.storage);
  const collection = f.client.threadsCollection();
  const lease = collection.threads();
  await collection.threadsWindow({ archived: true });
  await expect.poll(() => lease.store.loaded).toBe(true);
  // The cached half paints its rows at once: no blank list until Home's snapshot lands.
  expect(lease.store.thread("thread")?.title).toBe("Archived");
  expect(lease.store.ids).toEqual(["thread"]);
  await f.start();
  const wires = f.sent.filter(
    (message) => message.type === "subscribe" && message.scope.kind === "threads",
  );
  if (wires.length !== 2 || wires[0]?.type !== "subscribe" || wires[1]?.type !== "subscribe")
    throw new Error("Expected home and archive subscriptions");
  f.deliver({
    type: "snapshot",
    subscriptionId: wires[0].subscriptionId,
    seq: 5,
    view: { kind: "threads", seq: 5, threads: {} },
  });
  f.deliver({
    type: "snapshot",
    subscriptionId: wires[1].subscriptionId,
    seq: 6,
    view: { kind: "threads", seq: 6, threads: { thread: { ...thread, title: "Archived" } } },
  });
  await expect.poll(() => lease.store.syncing).toBe(false);
  f.flush();
  await expect.poll(() => m.values.has(stored("sidebar:[null,true]"))).toBe(true);
  const written = m.values.get(stored("sidebar:[null,true]"));
  expect(written).toMatchObject({ version: 2, archive: { seq: 6 } });
  expect(written).not.toHaveProperty("home");
  expect(m.values.has(stored("sidebar:[null,false]"))).toBe(false);
  collection.close();
  await f.client.close();
});

test("a late cached sidebar cannot replace a live window", async () => {
  const pending = new Map<string, (value: unknown) => void>();
  const f = harness({
    get: (key) => new Promise((resolve) => pending.set(key, resolve)),
    set: async () => {},
  });
  const lease = f.client.threads();
  await f.start();
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("threads").subscriptionId,
    seq: 10,
    view: list("Live"),
  });
  await expect.poll(() => lease.store.thread("thread")?.title).toBe("Live");
  pending.get(stored("sidebar:[null,false]"))?.({ version: 2, home: list("Old") });
  await Promise.resolve();
  expect(lease.store.thread("thread")?.title).toBe("Live");
  expect(lease.store.syncing).toBe(false);
  await f.client.close();
});

test("storage failures leave subscriptions usable and closing checkpoints dirty snapshots", async () => {
  const f = harness({
    get: () => {
      throw new Error("Storage denied");
    },
    set: async () => {
      throw new Error("Quota");
    },
  });
  const lease = f.client.thread("thread");
  await f.start();
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("thread").subscriptionId,
    seq: 10,
    view: view("Live"),
  });
  await expect.poll(() => lease.store.thread?.title).toBe("Live");
  f.flush();
  await Promise.resolve();
  expect(f.client.state).toBe("ready");
  await f.client.close();
  const m = memory();
  m.values.set(stored("thread:thread"), record());
  const closing = harness(m.storage);
  const restored = closing.client.thread("thread");
  await expect.poll(() => restored.store.cursor).toBe(10);
  m.values.clear();
  await closing.client.close();
  expect(m.values.has(stored("thread:thread"))).toBe(true);
});

test("a daemon started afresh at the same address never paints the threads its predecessor served", async () => {
  const m = memory();
  m.values.set(stored("thread:thread", "9d0f3f43-56a5-4c52-9a43-1d8a1b8f6f0e"), record());
  const f = harness(m.storage, 32, { host: undefined });
  const lease = f.client.thread("thread");
  await f.start();
  await Promise.resolve();
  expect(lease.store.thread).toBeUndefined();
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("thread").subscriptionId,
    seq: 10,
    view: view("Live"),
  });
  await expect.poll(() => lease.store.thread?.title).toBe("Live");
  await f.client.close();
});

test("a client meeting its daemon for the first time paints that daemon's record once it is named", async () => {
  const m = memory();
  m.values.set(stored("thread:thread"), record());
  const f = harness(m.storage, 32, { host: undefined });
  const lease = f.client.thread("thread");
  await Promise.resolve();
  expect(lease.store.thread).toBeUndefined();
  await f.start();
  await expect.poll(() => lease.store.thread?.title).toBe("Cached");
  expect(lease.store.unconfirmed).toBe(true);
  await f.client.close();
});

test("a revoked device forgets every record it kept and writes none afterwards", async () => {
  const m = memory();
  m.values.set(stored("thread:thread"), record());
  m.values.set(stored("sidebar:[null,false]"), { version: 2, home: list() });
  const f = harness(m.storage);
  const lease = f.client.thread("thread");
  await expect.poll(() => lease.store.thread?.title).toBe("Cached");
  await f.start();
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("thread").subscriptionId,
    seq: 12,
    view: view("Live", 12),
  });
  await expect.poll(() => lease.store.thread?.title).toBe("Live");
  f.closeSocket(4003);
  await expect.poll(() => f.client.state).toBe("fatal");
  expect(f.client.error?.code).toBe("auth");
  await expect.poll(() => m.values.size).toBe(0);
  // The live snapshot left the store unwritten: neither the timer nor closing writes it now.
  f.flush();
  await f.client.close();
  expect(m.values.size).toBe(0);
});

test("a dropped connection keeps the records for the next one", async () => {
  const m = memory();
  m.values.set(stored("thread:thread"), record());
  const f = harness(m.storage);
  const lease = f.client.thread("thread");
  await expect.poll(() => lease.store.thread?.title).toBe("Cached");
  await f.start();
  await f.reconnect(10);
  expect(m.values.has(stored("thread:thread"))).toBe(true);
  await f.client.close();
});
