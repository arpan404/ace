import { afterEach, expect, test } from "vitest";
import { Item, ItemId } from "@ace/protocol";
import { setup, ready, barrier, message } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("overlapping history pages applied out of order keep creation order and a stable cursor", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created") throw new Error("fixture");
  const fixture = message.item;
  const events = h.daemon.store.appendEvents(
    h.thread.id,
    ["A", "B", "C", "D"].map((id) => {
      const item = Item.parse(fixture);
      item.id = ItemId.parse(id);
      return { type: "item.created" as const, item };
    }),
  );
  const c = events[2];
  const d = events[3];
  if (!c || !d) throw new Error("creation cursors");
  const { client, faults } = h.make({ limits: { items: 3 } });
  await ready(client);
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "snapshot" && event.view.kind === "thread") {
      const item = event.view.items.D;
      if (!item) throw new Error("D snapshot");
      deliver(
        JSON.stringify({
          ...event,
          view: {
            ...event.view,
            items: { D: item },
            itemOrder: ["D"],
            itemSeqs: { D: d.seq },
            itemsBefore: d.seq,
          },
        }),
      );
    } else deliver(frame);
  };
  const { store } = client.thread(h.thread.id);
  await barrier(client, h.thread.id);
  expect(store.order).toEqual(["D"]);
  // First scroll back; keep A/B in a bounded window with the currently loaded D.
  const held: (() => void)[] = [];
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "items.page") held.push(() => deliver(frame));
    else deliver(frame);
  };
  const older = client.itemsPage({ threadId: h.thread.id, before: c.seq, limit: 2 });
  const overlap = client.itemsPage({ threadId: h.thread.id, before: d.seq, limit: 2 });
  await faults.wait((e) => e.type === "items.page" && e.items.some((i) => i.id === "A"));
  await faults.wait((e) => e.type === "items.page" && e.items.some((i) => i.id === "C"));
  const first = held[0];
  const second = held[1];
  if (!first || !second) throw new Error("held pages");
  second();
  const newer = await overlap;
  first();
  const old = await older;
  store.page(old);
  store.page(newer);
  const order = store.order;
  let notifications = 0;
  const stop = store
    .select(["order", "history"], (reader) => reader.order)
    .subscribe(() => {
      notifications++;
    });
  store.page(old);
  expect(store.order).toBe(order);
  expect(notifications).toBe(0);
  stop();
  expect(store.order).toEqual(["A", "B", "C"]);
  expect(new Set(store.order).size).toBe(3);
  expect(store.itemsBefore).toBeNull();
});

test("oversized text history is a bounded preview with lazy complete text reads", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created") throw new Error("fixture");
  if (message.item.type !== "message") throw new Error("message fixture");
  const text = "x".repeat(128 * 1024 - 1) + "😀" + "x".repeat(2 * 1024 * 1024) + "end";
  h.daemon.store.appendEvents(h.thread.id, [
    { ...message, item: { ...message.item, parts: [{ type: "text", text }] } },
  ]);
  const { client } = h.make();
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await barrier(client, h.thread.id);
  expect(store.order).toEqual([]);
  const page = await client.itemsPage({
    threadId: h.thread.id,
    before: store.itemsBefore ?? undefined,
    limit: 1,
  });
  const item = page.items[0];
  if (item?.type !== "message") throw new Error("message preview");
  const part = item.parts[0];
  if (part?.type !== "text" || !part.source) throw new Error("text source");
  expect(part.text.length).toBeLessThanOrEqual(4096);
  let actual = "";
  for await (const chunk of client.text(part.source)) {
    expect(chunk.length).toBeLessThanOrEqual(128 * 1024 + 1);
    actual += chunk;
  }
  expect(actual).toBe(text);
  store.page(page);
  expect(store.item(item.id)?.id).toBe(item.id);
  expect(store.truncated(item.id)).toBe(true);
  const previous = store.item(item.id);
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: "suffix" },
  ]);
  await barrier(client, h.thread.id);
  expect(store.item(item.id)).toMatchObject({
    parts: [{ text: part.text, source: { bytes: part.source.bytes + 12 } }],
  });
  expect(previous).toMatchObject({ parts: [{ source: { bytes: part.source.bytes } }] });
  const suffix = await client.outputRead({
    streamId: part.source.streamId,
    offset: part.source.bytes,
    limit: 12,
  });
  expect(Buffer.from(suffix.bytes).toString("utf16le")).toBe("suffix");
  await barrier(client, h.thread.id);
  expect(client.state).toBe("ready");
});

test("text streams preserve surrogate pairs split across provider deltas", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created") throw new Error("fixture");
  h.daemon.store.appendEvents(h.thread.id, [
    message,
    {
      type: "item.delta",
      itemId: message.item.id,
      agentId: message.item.agentId,
      field: "text",
      append: "\ud83d",
    },
    {
      type: "item.delta",
      itemId: message.item.id,
      agentId: message.item.agentId,
      field: "text",
      append: "\ude00",
    },
  ]);
  const { client } = h.make();
  await ready(client);
  const page = await client.itemsPage({ threadId: h.thread.id, limit: 1 });
  const item = page.items[0];
  if (item?.type !== "message") throw new Error("message");
  const part = item.parts[0];
  if (part?.type !== "text" || !part.source) throw new Error("source");
  let actual = "";
  for await (const chunk of client.text(part.source)) actual += chunk;
  expect(actual).toBe("😀");
});

test("authoritative text replacement invalidates an active detail read rather than mixing versions", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created" || message.item.type !== "message")
    throw new Error("fixture");
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.created",
      item: { ...message.item, parts: [{ type: "text", text: "x".repeat(512 * 1024) }] },
    },
  ]);
  const { client } = h.make();
  await ready(client);
  const page = await client.itemsPage({ threadId: h.thread.id, limit: 1 });
  const item = page.items[0];
  if (item?.type !== "message") throw new Error("message");
  const part = item.parts[0];
  if (part?.type !== "text" || !part.source) throw new Error("source");
  const reader = client.text(part.source);
  expect((await reader.next()).value).toBe("x".repeat(128 * 1024));
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.updated",
      item: { ...message.item, parts: [{ type: "text", text: "replacement" }] },
    },
  ]);
  await expect(reader.next()).rejects.toMatchObject({ name: "ClientError", code: "daemon" });
  await barrier(client, h.thread.id);
  expect(client.state).toBe("ready");
});
