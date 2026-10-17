import { expect, test } from "vitest";
import { Event } from "@ace/protocol";
import { harness, view, list, memory, thread } from "./read-snapshots.fixture.ts";

test("reload paints persisted messages while syncing and always reconciles from a fresh wire", async () => {
  const m = memory();
  m.values.set("thread:thread", { version: 1, view: view() });
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
  resolve?.({ version: 1, view: view("Stale") });
  await Promise.resolve();
  expect(lease.store.thread?.title).toBe("Live");
  await f.client.close();
});

test.each([
  { version: 2, view: view() },
  { version: 1, view: { broken: true } },
  { version: 1, view: { ...view(), thread: { ...thread, id: "other" } } },
])("invalid, future-version and wrong-thread snapshots remain misses", async (cached) => {
  const f = harness({ get: async () => cached, set: async () => {} });
  const lease = f.client.thread("thread");
  await f.start();
  expect(lease.store.thread).toBeUndefined();
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
  await expect.poll(() => m.values.has("thread:thread")).toBe(true);
  const reloaded = harness(m.storage);
  const restored = reloaded.client.thread("thread");
  await expect.poll(() => restored.store.cursor).toBe(30);
  expect(restored.store.item("answer")).toMatchObject({
    parts: [{ type: "text", text: `hello${"!".repeat(20)}` }],
  });
  await f.client.close();
  await reloaded.client.close();
});

test("cached sidebar paints before the network and reconciles removed rows", async () => {
  const m = memory();
  m.values.set("sidebar:[null,false]", { version: 1, home: list() });
  const f = harness(m.storage);
  const lease = f.client.threads();
  await expect.poll(() => lease.store.loaded).toBe(true);
  expect(lease.store.ids).toEqual(["thread"]);
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

test("an evicted thread cannot hydrate after its replacement acquires the bounded cache", async () => {
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
  late?.({ version: 1, view: view() });
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
  pending.get("sidebar:[null,false]")?.({ version: 1, home: list("Wrong project") });
  await Promise.resolve();
  expect(lease.store.loaded).toBe(false);
  pending.get('sidebar:["selected",false]')?.({ version: 1, home: list("Selected") });
  await expect.poll(() => lease.store.thread("thread")?.title).toBe("Selected");
  expect(lease.store.syncing).toBe(true);
  collection.close();
  await f.client.close();
});

test("an archived filter persists only its half and an archive-only record still hydrates", async () => {
  const m = memory();
  m.values.set("sidebar:[null,true]", { version: 1, archive: list("Archived") });
  const f = harness(m.storage);
  const collection = f.client.threadsCollection();
  const lease = collection.threads();
  await collection.threadsWindow({ archived: true });
  // Archive-only hydration marks the view loaded before any wire snapshot arrives.
  await expect.poll(() => lease.store.loaded).toBe(true);
  // And the cached half paints its rows at once: no blank window until Home's wire lands.
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
  await expect.poll(() => lease.store.thread("thread")?.title).toBe("Archived");
  f.flush();
  await expect.poll(() => m.values.has("sidebar:[null,true]")).toBe(true);
  const stored = m.values.get("sidebar:[null,true]") as Record<string, unknown>;
  expect("home" in stored).toBe(false);
  expect(m.values.has("sidebar:[null,false]")).toBe(false);
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
  pending.get("sidebar:[null,false]")?.({ version: 1, home: list("Old") });
  await Promise.resolve();
  expect(lease.store.thread("thread")?.title).toBe("Live");
  // A no-change hydrate cannot re-enter the syncing set when nothing adopted.
  expect(lease.store.syncing).toBe(false);
  await f.client.close();
});

test("storage failures leave network subscriptions usable and closing checkpoints dirty snapshots", async () => {
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
  m.values.set("thread:thread", { version: 1, view: view() });
  const closing = harness(m.storage);
  const restored = closing.client.thread("thread");
  await expect.poll(() => restored.store.cursor).toBe(10);
  m.values.clear();
  await closing.client.close();
  closing.flush();
  expect(m.values.has("thread:thread")).toBe(true);
});
