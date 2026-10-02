import { afterEach, expect, test } from "vitest";
import { ItemId } from "@ace/protocol";
import { setup, ready, when, barrier, message, delta, itemId, itemText } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("a delayed duplicate thread snapshot cannot roll back applied text or cursor", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [message]);
  const { client, faults } = h.make();
  await ready(client);
  let replay: (() => void) | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "snapshot") replay = () => deliver(frame);
    deliver(frame);
  };
  const { store } = client.thread(h.thread.id);
  await when(
    store.select([`item:${itemId}`], (s) => s.item(itemId)),
    Boolean,
  );
  h.daemon.store.appendEvents(h.thread.id, [delta("A")]);
  await barrier(client, h.thread.id);
  if (!replay) throw new Error("Snapshot not captured");
  replay();
  expect(itemText(store.item(itemId))).toBe("A");
  expect(store.cursor).toBe(h.daemon.store.headSeq());
});

test("a delayed duplicate sidebar snapshot cannot roll back live metadata", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  let replay: (() => void) | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "snapshot") replay = () => deliver(frame);
    deliver(frame);
  };
  const { store } = client.threads();
  await when(
    store.select([`thread:${h.thread.id}`], (s) => s.thread(h.thread.id)),
    Boolean,
  );
  h.daemon.store.appendEvents(h.thread.id, [{ type: "thread.updated", title: "new title" }]);
  await barrier(client, h.thread.id);
  if (!replay) throw new Error("Snapshot not captured");
  replay();
  expect(store.thread(h.thread.id)?.title).toBe("new title");
});

test("an unloaded update followed by its delta cannot evict the loaded item", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created") throw new Error("Fixture");
  h.daemon.store.appendEvents(h.thread.id, [
    message,
    { ...message, item: { ...message.item, id: ItemId.parse("new") } },
  ]);
  const { client } = h.make({ limits: { items: 1 } });
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await when(
    store.select(["thread"], (s) => s.thread),
    Boolean,
  );
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.updated", item: { ...message.item, complete: true } },
    delta("late"),
  ]);
  await barrier(client, h.thread.id);
  expect(store.order).toEqual(["new"]);
  expect(store.item(itemId)).toBeUndefined();
});

test("a held history page cannot admit an item older than its observed live update", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created") throw new Error("Fixture");
  h.daemon.store.appendEvents(h.thread.id, [
    message,
    { ...message, item: { ...message.item, id: ItemId.parse("new") } },
  ]);
  const { client, faults } = h.make({ limits: { items: 1 } });
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await when(
    store.select(["thread"], (s) => s.thread),
    Boolean,
  );
  let release: (() => void) | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "items.page" && !release) {
      release = () => deliver(frame);
    } else deliver(frame);
  };
  const pending = client.itemsPage({
    threadId: h.thread.id,
    before: h.daemon.store.headSeq(),
    limit: 1,
  });
  await faults.wait((event) => event.type === "items.page");
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.updated", item: { ...message.item, complete: true } },
  ]);
  await barrier(client, h.thread.id);
  if (!release) throw new Error("Page not captured");
  release();
  const page = await pending;
  store.page(page);
  expect(store.item(itemId)?.complete).toBe(true);
});

test("a page newer than delivery ignores deltas already included in that page", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created") throw new Error("fixture");
  h.daemon.store.appendEvents(h.thread.id, [
    message,
    { ...message, item: { ...message.item, id: ItemId.parse("new") } },
  ]);
  const before = h.daemon.store.headSeq();
  const { client, faults } = h.make({ limits: { items: 1 } });
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await barrier(client, h.thread.id);
  let replay: (() => void) | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "events") replay = () => deliver(frame);
    else deliver(frame);
  };
  h.daemon.store.appendEvents(h.thread.id, [delta("once")]);
  const page = await client.itemsPage({ threadId: h.thread.id, before, limit: 1 });
  store.page(page);
  if (!replay) throw new Error("Delta not captured");
  replay();
  expect(itemText(store.item(itemId))).toBe("once");
  expect(store.cursor).toBe(h.daemon.store.headSeq());
});

test("an expired page journal rejects stale history and a fresh page recovers", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created") throw new Error("fixture");
  h.daemon.store.appendEvents(h.thread.id, [
    message,
    { ...message, item: { ...message.item, id: ItemId.parse("new") } },
  ]);
  const before = h.daemon.store.headSeq();
  const { client } = h.make({ limits: { items: 1, entities: 1 } });
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await barrier(client, h.thread.id);
  const old = await client.itemsPage({ threadId: h.thread.id, before, limit: 1 });
  h.daemon.store.appendEvents(h.thread.id, [delta("A"), delta("B")]);
  await barrier(client, h.thread.id);
  expect(() => store.page(old)).toThrow("fresh read");
  const fresh = await client.itemsPage({ threadId: h.thread.id, before, limit: 1 });
  store.page(fresh);
  expect(itemText(store.item(itemId))).toBe("AB");
  expect(client.state).toBe("ready");
});
