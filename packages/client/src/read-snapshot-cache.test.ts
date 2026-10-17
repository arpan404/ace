import { expect, test } from "vitest";
import { Event, Item, ThreadId } from "@ace/protocol";
import { harness, memory, view } from "./read-snapshots.fixture.ts";

function delta(seq: number) {
  return Event.parse({
    id: `delta-${seq}`,
    threadId: "thread",
    seq,
    at: seq,
    payload: { type: "item.delta", agentId: "root", itemId: "answer", field: "text", append: "!" },
  });
}

test("closing waits for an in-flight snapshot then checkpoints the newest dirty text", async () => {
  const m = memory();
  let finish: (() => void) | undefined;
  let block = true;
  const f = harness({
    ...m.storage,
    async set(key, value) {
      const captured = structuredClone(value);
      if (block) {
        block = false;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      await m.storage.set(key, captured);
    },
  });
  const held = f.client.thread("thread");
  await f.start();
  const subscriptionId = f.wire("thread").subscriptionId;
  f.deliver({ type: "snapshot", subscriptionId, seq: 10, view: view() });
  await expect.poll(() => held.store.cursor).toBe(10);
  f.flush();
  f.deliver({ type: "events", subscriptionId, afterSeq: 10, throughSeq: 11, events: [delta(11)] });
  await expect.poll(() => held.store.cursor).toBe(11);
  let closed = false;
  const closing = f.client.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish?.();
  await closing;
  const next = harness(m.storage);
  const restored = next.client.thread("thread");
  await expect.poll(() => restored.store.cursor).toBe(11);
  expect(restored.store.item("answer")).toMatchObject({
    parts: [{ type: "text", text: "hello!" }],
  });
  await next.client.close();
});

test("inactive SDK views obey a 16 MiB budget while active views stay retained", async () => {
  const f = harness(memory().storage);
  const active = f.client.thread("active");
  await f.start();
  async function large(id: string) {
    const held = f.client.thread(id);
    const subscriptionId = f.wire("thread").subscriptionId;
    const snapshot = view();
    snapshot.thread.id = ThreadId.parse(id);
    f.deliver({ type: "snapshot", subscriptionId, seq: 10, view: snapshot });
    for (let seq = 11; seq <= 110; seq++)
      f.deliver({
        type: "events",
        subscriptionId,
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [
          Event.parse({
            id: `${id}-${seq}`,
            threadId: id,
            seq,
            at: seq,
            payload: {
              type: "item.created",
              item: Item.parse({
                id: `${id}-${seq}`,
                agentId: "root",
                type: "message",
                role: "assistant",
                createdAt: seq,
                complete: true,
                parts: [{ type: "text", text: "x".repeat(60_000) }],
              }),
            },
          }),
        ],
      });
    await expect.poll(() => held.store.cursor).toBe(110);
    held.release();
  }
  await large("first");
  expect(f.client.cachedThread("first")?.order.length).toBe(101);
  await large("second");
  expect(f.client.cachedThread("first")).toBeUndefined();
  expect(f.client.cachedThread("second")?.order.length).toBe(101);
  expect(f.client.cachedThread("active")).toBe(active.store);
  const reused = f.client.thread("second");
  expect(reused.store.order).toHaveLength(101);
  reused.release();
  await large("third");
  expect(f.client.cachedThread("second")).toBeUndefined();
  expect(f.client.cachedThread("third")?.order.length).toBe(101);
  await f.client.close();
});

test("persisted previews retain creation cursors and discard them on canonical deletion", async () => {
  const m = memory();
  const f = harness(m.storage);
  const held = f.client.thread("thread");
  await f.start();
  const subscriptionId = f.wire("thread").subscriptionId;
  f.deliver({ type: "snapshot", subscriptionId, seq: 10, view: view() });
  await expect.poll(() => held.store.cursor).toBe(10);
  expect(held.store.itemSequence?.("answer")).toBe(1);
  await f.client.close();
  const next = harness(m.storage);
  const cached = next.client.thread("thread");
  await expect.poll(() => cached.store.itemSequence?.("answer")).toBe(1);
  await next.start();
  const wire = next.wire("thread").subscriptionId;
  next.deliver({ type: "snapshot", subscriptionId: wire, seq: 10, view: view() });
  next.deliver({
    type: "events",
    subscriptionId: wire,
    afterSeq: 10,
    throughSeq: 11,
    events: [
      Event.parse({
        id: "deleted",
        threadId: "thread",
        seq: 11,
        at: 11,
        payload: { type: "item.deleted", itemId: "answer" },
      }),
    ],
  });
  await expect.poll(() => cached.store.cursor).toBe(11);
  expect(cached.store.itemSequence?.("answer")).toBeUndefined();
  await next.client.close();
});

test("a warm reconnect accepts a lower authoritative snapshot after a daemon loses its buffered tail", async () => {
  const f = harness(memory().storage);
  const held = f.client.thread("thread");
  await f.start();
  const oldWire = f.wire("thread").subscriptionId;
  f.deliver({ type: "snapshot", subscriptionId: oldWire, seq: 10, view: view() });
  f.deliver({
    type: "events",
    subscriptionId: oldWire,
    afterSeq: 10,
    throughSeq: 11,
    events: [delta(11)],
  });
  await expect.poll(() => held.store.cursor).toBe(11);
  await f.reconnect(10);
  const wire = f.wire("thread");
  expect(wire.afterSeq).toBe(11);
  expect(held.store.syncing).toBe(true);
  f.deliver({
    type: "snapshot",
    subscriptionId: wire.subscriptionId,
    seq: 10,
    view: view("Recovered", 10),
  });
  await expect.poll(() => held.store.thread?.title).toBe("Recovered");
  expect(held.store.cursor).toBe(10);
  expect(held.store.syncing).toBe(false);
  expect(held.store.item("answer")).toMatchObject({ parts: [{ type: "text", text: "hello" }] });
  // Late frames from the old wire and duplicate snapshots cannot roll the replacement back.
  f.deliver({ type: "snapshot", subscriptionId: oldWire, seq: 9, view: view("Old wire", 9) });
  f.deliver({
    type: "snapshot",
    subscriptionId: wire.subscriptionId,
    seq: 8,
    view: view("Duplicate", 8),
  });
  f.deliver({
    type: "events",
    subscriptionId: wire.subscriptionId,
    afterSeq: 10,
    throughSeq: 65_537,
    events: [delta(65_537)],
  });
  await expect.poll(() => held.store.cursor).toBe(65_537);
  expect(held.store.thread?.title).toBe("Recovered");
  expect(held.store.item("answer")).toMatchObject({ parts: [{ type: "text", text: "hello!" }] });
  await f.client.close();
});
