import { setImmediate as yieldImmediate } from "node:timers/promises";
import { createDevThread } from "./commands.ts";
import { expect, test } from "vitest";
import { Item, ItemId } from "@ace/protocol";
import { storeFixture, root } from "./long-thread-test-support.ts";

test("search rebuild yields bounded replay pages and keeps large message interiors and later events searchable", async () => {
  const f = storeFixture();
  const text =
    "headneedle " + "x ".repeat(180000) + " middleunique " + "y ".repeat(180000) + " tailneedle";
  for (let i = 0; i < 12; i++)
    f.store.appendEvents(f.thread.id, [
      {
        type: "item.created",
        item: Item.parse({
          type: "message",
          id: `large-${i}`,
          agentId: root,
          createdAt: 10,
          complete: true,
          role: "assistant",
          parts: [{ type: "text", text }],
        }),
      },
    ]);
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.created",
      item: Item.parse({
        type: "message",
        id: "later",
        agentId: root,
        createdAt: 11,
        complete: true,
        role: "assistant",
        parts: [{ type: "text", text: "laterneedle" }],
      }),
    },
  ]);
  const pages: number[] = [];
  const source = {
    headSeq: () => f.store.headSeq(),
    getThread: f.store.getThread.bind(f.store),
    readEvents(options: { afterSeq: number; limit: number }) {
      const events = f.store.readEvents(options);
      pages.push(Buffer.byteLength(JSON.stringify(events)));
      return events;
    },
    readSearchPage(options: { afterSeq: number; limit: number; maxBytes: number }) {
      const page = f.store.readSearchPage(options);
      pages.push(page.bytes);
      return page;
    },
  };
  let yields = 0;
  await f.store.search.rebuild(source, {
    signal: new AbortController().signal,
    yield: async () => {
      yields++;
      await yieldImmediate();
    },
  });
  expect(Math.max(...pages)).toBeLessThanOrEqual(512 * 1024);
  expect(yields).toBeGreaterThan(0);
  expect(f.store.search.query({ text: "laterneedle" }).hits).toMatchObject([{ itemId: "later" }]);
  expect(f.store.search.query({ text: "tailneedle" }).hits).toHaveLength(12);
  expect(
    f.store.threadSearch({
      threadId: f.thread.id,
      text: "middleunique",
      scope: "thread",
      limit: 20,
    }).hits,
  ).toHaveLength(12);
});

test("a cancelled byte-limited rebuild resumes after restart without skipping later messages or deltas", async () => {
  const f = storeFixture();
  const text = "firstprefix " + "word ".repeat(140000) + " originaltail";
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.created",
      item: Item.parse({
        type: "message",
        id: "stream",
        agentId: root,
        createdAt: 10,
        complete: false,
        role: "assistant",
        parts: [{ type: "text", text }],
      }),
    },
  ]);
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.delta",
      itemId: ItemId.parse("stream"),
      agentId: root,
      field: "text",
      append: "deltahead " + "next ".repeat(140000) + " deltamiddle enddelta",
    },
  ]);
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.created",
      item: Item.parse({
        type: "message",
        id: "after",
        agentId: root,
        createdAt: 11,
        complete: true,
        role: "assistant",
        parts: [{ type: "text", text: "aftercancelneedle" }],
      }),
    },
  ]);
  const abort = new AbortController();
  await f.store.search.rebuild(f.store, {
    signal: abort.signal,
    yield: async () => {
      abort.abort();
    },
  });
  expect(f.store.search.status(f.store.headSeq()).indexedSeq).toBeLessThan(f.store.headSeq());
  await f.restart();
  await f.store.search.backfill(f.store, { signal: new AbortController().signal });
  expect(f.store.search.query({ text: "aftercancelneedle" }).hits).toMatchObject([
    { itemId: "after" },
  ]);
  expect(f.store.search.query({ text: "enddelta" }).hits).toMatchObject([{ itemId: "stream" }]);
  expect(
    f.store.threadSearch({ threadId: f.thread.id, text: "deltamiddle", scope: "thread", limit: 10 })
      .hits,
  ).toMatchObject([{ itemId: "stream" }]);
  const first = f.store.readSearchPage({ afterSeq: 0, limit: 256, maxBytes: 512 * 1024 });
  expect(first.bytes).toBeLessThanOrEqual(512 * 1024);
  expect(first.throughSeq).toBeLessThan(f.store.headSeq());
});

test("byte-limited replay crosses deleted sequence gaps and never treats a short page as source completion", async () => {
  const f = storeFixture();
  const removed = createDevThread(f.store, f.workspace);
  f.store.appendEvents(removed.id, [
    {
      type: "item.created",
      item: Item.parse({
        type: "message",
        id: "removed",
        agentId: root,
        createdAt: 10,
        complete: true,
        role: "assistant",
        parts: [{ type: "text", text: "removedneedle" }],
      }),
    },
  ]);
  f.store.deleteThread(removed.id);
  for (let i = 0; i < 4; i++)
    f.store.appendEvents(f.thread.id, [
      {
        type: "item.created",
        item: Item.parse({
          type: "message",
          id: `budget-${i}`,
          agentId: root,
          createdAt: 10,
          complete: true,
          role: "assistant",
          parts: [{ type: "text", text: "word ".repeat(40000) + ` budgetneedle${i}` }],
        }),
      },
    ]);
  const page = f.store.readSearchPage({ afterSeq: 0, limit: 256, maxBytes: 512 * 1024 });
  expect(page.events.length).toBeLessThan(256);
  expect(page.throughSeq).toBeLessThan(f.store.headSeq());
  expect(page.bytes).toBeLessThanOrEqual(512 * 1024);
  await f.store.search.rebuild(f.store, { signal: new AbortController().signal });
  expect(f.store.search.query({ text: "removedneedle" }).hits).toEqual([]);
  for (let i = 0; i < 4; i++)
    expect(f.store.search.query({ text: `budgetneedle${i}` }).hits).toMatchObject([
      { itemId: `budget-${i}` },
    ]);
  expect(f.store.search.status(f.store.headSeq()).ready).toBe(true);
});

test("oversized file-write metadata rebuilds bounded previews and full file text without blocking later events", async () => {
  const f = storeFixture();
  const text = "writehead " + "x ".repeat(180000) + " writeinterior " + "y ".repeat(180000) + " writetail";
  f.store.appendEvents(f.thread.id, [{
    type: "item.created",
    item: Item.parse({
      type: "tool_call", id: "large-write", agentId: root, createdAt: 10, complete: true,
      call: { id: "large-write", agentId: root, kind: "file.write", title: "Write giant-file.ts", status: "succeeded", startedAt: 10, raw: [],
        detail: { kind: "file.write", changes: [{ kind: "add", path: "giant-file.ts", newText: text }] } },
    }),
  }, {
    type: "item.created", item: Item.parse({ type: "message", id: "after-write", agentId: root, createdAt: 11, complete: true, role: "assistant", parts: [{ type: "text", text: "afterwriteneedle" }] }),
  }]);
  await f.restart();
  const pages: number[] = [];
  await f.store.search.rebuild({
    headSeq: () => f.store.headSeq(), getThread: f.store.getThread.bind(f.store), readEvents: f.store.readEvents.bind(f.store),
    readSearchPage(options) { const page = f.store.readSearchPage(options); pages.push(page.bytes); return page; },
  }, { signal: new AbortController().signal });
  expect(Math.max(...pages)).toBeLessThanOrEqual(524288);
  expect(f.store.search.status(f.store.headSeq()).ready).toBe(true);
  for (const text of ["writehead", "writetail"]) expect(f.store.search.query({ text }).hits).toMatchObject([{ itemId: "large-write" }]);
  expect(f.store.search.query({ text: "afterwriteneedle" }).hits).toMatchObject([{ itemId: "after-write" }]);
  expect(f.store.threadSearch({ threadId: f.thread.id, text: "writeinterior", scope: "thread", limit: 10 }).hits).toMatchObject([{ itemId: "large-write" }]);
});
