import { afterEach, expect, test } from "vitest";
import { createDevThread } from "@ace/daemon";
import { ItemId } from "@ace/protocol";
import { setup, ready, when, barrier, message, itemId, delta, itemText } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("reconnect mid-stream resumes only unapplied output and ignores duplicate coverage", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [message]);
  const { client, faults, scheduler } = h.make();
  await ready(client);
  const subscription = client.thread(h.thread.id);
  const item = subscription.store.select([`item:${itemId}`], (store) => store.item(itemId));
  await when(item, Boolean);
  h.daemon.store.appendEvents(h.thread.id, [delta("A")]);
  await when(item, (value) => itemText(value) === "A");
  const cursor = subscription.store.cursor;
  faults.disconnect();
  h.daemon.store.appendEvents(h.thread.id, [delta("B"), delta("C")]);
  faults.incoming = (incoming, frame, deliver) => {
    deliver(frame);
    if (incoming.type === "events") deliver(frame);
  };
  scheduler.advance(125);
  await when(item, (value) => itemText(value) === "ABC");
  await barrier(client, h.thread.id);
  expect(itemText(item.getSnapshot())).toBe("ABC");
  const resumes = faults.sent
    .map((frame) => JSON.parse(frame))
    .filter((frame) => frame.type === "subscribe");
  expect(resumes.at(-1)?.afterSeq).toBe(cursor);
});

test("a dropped frame forces snapshot resync and stale frames cannot duplicate text", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [message]);
  const { client, faults } = h.make();
  await ready(client);
  const { store } = client.thread(h.thread.id);
  const selected = store.select([`item:${itemId}`], (view) => view.item(itemId));
  await when(selected, Boolean);
  let dropped: string | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "events" && !dropped) {
      dropped = frame;
      return;
    }
    deliver(frame);
  };
  h.daemon.store.appendEvents(h.thread.id, [delta("lost")]);
  h.daemon.store.appendEvents(h.thread.id, [delta("found")]);
  await when(selected, (item) => itemText(item) === "lostfound");
  await barrier(client, h.thread.id);
  expect(
    faults.sent
      .map((s) => JSON.parse(s))
      .filter((s) => s.type === "subscribe" && s.afterSeq === undefined),
  ).toHaveLength(2);
  expect(store.cursor).toBe(h.daemon.store.headSeq());
});

test("reordered batches recover authoritative text without gaps or duplicates", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [message]);
  const { client, faults } = h.make();
  await ready(client);
  const { store } = client.thread(h.thread.id);
  const selected = store.select([`item:${itemId}`], (view) => view.item(itemId));
  await when(selected, Boolean);
  let held: string | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "events") {
      deliver(frame);
      return;
    }
    if (!held) {
      held = frame;
      return;
    }
    deliver(frame);
    deliver(held);
  };
  h.daemon.store.appendEvents(h.thread.id, [delta("first")]);
  h.daemon.store.appendEvents(h.thread.id, [delta("second")]);
  await when(selected, (value) => itemText(value) === "firstsecond");
  await barrier(client, h.thread.id);
  expect(itemText(selected.getSnapshot())).toBe("firstsecond");
});

test("two views keep one wire subscription until the last view releases", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  const one = client.thread(h.thread.id);
  const two = client.thread(h.thread.id);
  await when(
    one.store.select(["thread"], (store) => store.thread),
    Boolean,
  );
  one.release();
  one.release();
  h.daemon.store.appendEvents(h.thread.id, [{ type: "thread.updated", title: "still live" }]);
  await when(
    two.store.select(["thread"], (store) => store.thread?.title),
    (title) => title === "still live",
  );
  two.release();
  await barrier(client, h.thread.id);
  const frames = faults.sent.map((frame) => JSON.parse(frame));
  expect(frames.filter((frame) => frame.type === "subscribe")).toHaveLength(1);
  expect(frames.filter((frame) => frame.type === "unsubscribe")).toHaveLength(1);
});

test("LRU retains recent unreferenced threads and snapshots evicted ones", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const b = createDevThread(h.daemon.store, h.workspaceId, "B");
  const c = createDevThread(h.daemon.store, h.workspaceId, "C");
  const { client, faults } = h.make({ limits: { threads: 2 } });
  await ready(client);
  for (const thread of [h.thread, b, h.thread, c, h.thread]) {
    const subscription = client.thread(thread.id);
    await barrier(client, thread.id);
    subscription.release();
  }
  const subscription = client.thread(b.id);
  await barrier(client, b.id);
  subscription.release();
  const frames = faults.sent.map((s) => JSON.parse(s)).filter((s) => s.type === "subscribe");
  expect(frames[4]?.afterSeq).toBeDefined();
  expect(frames[5]?.afterSeq).toBeUndefined();
});

test("an auth rejection is fatal and online hints do not retry it", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make({ credential: async () => "bad-token" });
  await client.start();
  await when(client.connectionState(), (state) => state === "fatal");
  client.networkOnline(false);
  client.networkOnline(true);
  scheduler.advance(100000);
  expect(client.state).toBe("fatal");
  expect(client.error?.code).toBe("auth");
  expect(faults.sent).toHaveLength(1);
});

test("silent heartbeat closes a dead socket and an online hint retries immediately", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make();
  await ready(client);
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "pong") deliver(frame);
  };
  scheduler.advance(15000);
  await faults.wait((event) => event.type === "pong");
  scheduler.advance(15000);
  expect(client.state).toBe("reconnecting");
  client.networkOnline(false);
  expect(client.state).toBe("offline");
  faults.incoming = (_event, frame, deliver) => deliver(frame);
  client.networkOnline(true);
  await when(client.connectionState(), (state) => state === "ready");
  expect(client.state).toBe("ready");
});

test("only the changed item notifies and previous selected values stay immutable", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [message]);
  const { client } = h.make();
  await ready(client);
  const { store } = client.thread(h.thread.id);
  const selected = store.select([`item:${itemId}`], (view) => view.item(itemId));
  await when(selected, Boolean);
  const old = selected.getSnapshot();
  let itemNotifications = 0;
  let titleNotifications = 0;
  const stop = selected.subscribe(() => itemNotifications++);
  const stopTitle = store
    .select(["thread"], (view) => view.thread)
    .subscribe(() => titleNotifications++);
  h.daemon.store.appendEvents(h.thread.id, [delta("new")]);
  await barrier(client, h.thread.id);
  expect(itemNotifications).toBe(1);
  expect(titleNotifications).toBe(0);
  expect(itemText(old)).toBe("");
  expect(itemText(selected.getSnapshot())).toBe("new");
  stop();
  stopTitle();
});

test("item and text windows are capped and older history is read on demand", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  for (let i = 0; i < 5; i++)
    if (message.type === "item.created")
      h.daemon.store.appendEvents(h.thread.id, [
        { ...message, item: { ...message.item, id: ItemId.parse(`item-${i}`) } },
      ]);
  const { client } = h.make({ limits: { items: 2, text: 3 } });
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await when(
    store.select(["thread"], (s) => s.thread),
    Boolean,
  );
  expect(store.order).toEqual(["item-3", "item-4"]);
  const page = await client.itemsPage({
    threadId: h.thread.id,
    before: ItemId.parse("item-3"),
    limit: 2,
  });
  expect(page.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
  store.page(page.items, page.itemsBefore);
  expect(store.order).toEqual(["item-1", "item-2"]);
  h.daemon.store.appendEvents(h.thread.id, [message, delta("abcdef")]);
  await barrier(client, h.thread.id);
  expect(store.order).toHaveLength(2);
  expect(itemText(store.item(itemId))).toBe("f");
  expect(store.truncated(itemId)).toBe(true);
});

test("filtered host sequences do not masquerade as dropped thread events", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const b = createDevThread(h.daemon.store, h.workspaceId, "other");
  const { client, faults } = h.make();
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await when(
    store.select(["thread"], (s) => s.thread),
    Boolean,
  );
  h.daemon.store.appendEvents(b.id, [{ type: "thread.updated", title: "unrelated" }]);
  h.daemon.store.appendEvents(h.thread.id, [{ type: "thread.updated", title: "changed" }]);
  await when(
    store.select(["thread"], (s) => s.thread?.title),
    (title) => title === "changed",
  );
  expect(faults.sent.map((s) => JSON.parse(s)).filter((s) => s.type === "subscribe")).toHaveLength(
    1,
  );
  expect(store.cursor).toBe(h.daemon.store.headSeq());
});

test("sidebar metadata resumes independently and unrelated transcript changes do not notify it", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make();
  await ready(client);
  const sidebar = client.threads();
  const second = client.threads();
  const selected = sidebar.store.select([`thread:${h.thread.id}`], (store) =>
    store.thread(h.thread.id),
  );
  await when(selected, Boolean);
  let notifications = 0;
  const stop = selected.subscribe(() => notifications++);
  h.daemon.store.appendEvents(h.thread.id, [message]);
  await barrier(client, h.thread.id);
  expect(notifications).toBe(0);
  faults.disconnect();
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "thread.updated", title: "reconnected sidebar" },
  ]);
  scheduler.advance(125);
  await when(selected, (entry) => entry?.title === "reconnected sidebar");
  expect(notifications).toBe(1);
  expect(sidebar.store.ids).toEqual([h.thread.id]);
  sidebar.release();
  second.release();
  stop();
});

test("updates outside the loaded item window do not reinsert old history", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [message]);
  const { client } = h.make({ limits: { items: 1 } });
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await when(
    store.select(["thread"], (s) => s.thread),
    Boolean,
  );
  if (message.type !== "item.created") throw new Error("expected item fixture");
  h.daemon.store.appendEvents(h.thread.id, [
    { ...message, item: { ...message.item, id: ItemId.parse("new") } },
  ]);
  await barrier(client, h.thread.id);
  expect(store.order).toEqual(["new"]);
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.updated", item: { ...message.item, complete: true } },
  ]);
  await barrier(client, h.thread.id);
  expect(store.order).toEqual(["new"]);
  expect(store.item(itemId)).toBeUndefined();
});
