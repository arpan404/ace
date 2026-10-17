import { Item, Thread } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { expect, test } from "vitest";
import { defaultLimits, ThreadStore } from "./index.ts";

const message = (id: string) =>
  Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "user",
    createdAt: 0,
    complete: true,
    parts: [{ type: "text", text: id }],
  });
const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "History",
  status: { state: "done" },
  createdAt: 0,
  updatedAt: 0,
});

test("a page larger than the window's free room admits its newest items and keeps a cursor", () => {
  const store = new ThreadStore({ ...defaultLimits, items: 2 });
  const view = createThreadView(thread, 10);
  view.items = { c: message("c") };
  view.itemOrder = ["c"];
  view.itemSeqs = { c: 3 };
  view.itemsBefore = 3;
  store.snapshot(view);
  const page = {
    seq: 10,
    threadId: thread.id,
    items: [message("a"), message("b")],
    itemSeqs: { a: 1, b: 2 },
    itemsBefore: null,
  };
  store.page(page, 3);
  expect(store.order).toEqual(["b", "c"]);
  expect(store.item("a")).toBeUndefined();
  // "a" was not admitted, so the start of the thread is not reached yet.
  expect(store.itemsBefore).toBe(2);
  // A repeated reply for the old cursor is stale and changes nothing.
  store.page(page, 3);
  expect(store.order).toEqual(["b", "c"]);
  expect(store.itemsBefore).toBe(2);
});

test("a page of items the window already holds still moves its cursor back", () => {
  const store = new ThreadStore(defaultLimits);
  const view = createThreadView(thread, 10);
  view.items = { b: message("b"), c: message("c") };
  view.itemOrder = ["b", "c"];
  view.itemSeqs = { b: 2, c: 3 };
  view.itemsBefore = 3;
  store.snapshot(view);
  store.page(
    { seq: 10, threadId: thread.id, items: [message("b")], itemSeqs: { b: 2 }, itemsBefore: null },
    3,
  );
  expect(store.order).toEqual(["b", "c"]);
  expect(store.itemsBefore).toBeNull();
});
