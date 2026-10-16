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

test("history pages stay bounded and preserve the cursor at the retained older edge", () => {
  const store = new ThreadStore({ ...defaultLimits, items: 2 });
  const thread = Thread.parse({
    id: "thread",
    workspaceId: "workspace",
    provider: "codex",
    title: "History",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  });
  const view = createThreadView(thread, 10);
  view.items = { c: message("c"), d: message("d") };
  view.itemOrder = ["c", "d"];
  view.itemSeqs = { c: 3, d: 4 };
  view.itemsBefore = 3;
  store.snapshot(view);
  store.page({
    seq: 10,
    threadId: thread.id,
    items: [message("b")],
    itemSeqs: { b: 2 },
    itemsBefore: 2,
  });
  expect(store.order).toEqual(["b", "c"]);
  expect(store.item("d")).toBeUndefined();
  store.page({
    seq: 10,
    threadId: thread.id,
    items: [message("a")],
    itemSeqs: { a: 1 },
    itemsBefore: null,
  });
  expect(store.order).toEqual(["a", "b"]);
  expect(store.itemsBefore).toBeNull();
  // An out-of-order duplicate does not move the retained edge forward again.
  store.page({
    seq: 10,
    threadId: thread.id,
    items: [message("b")],
    itemSeqs: { b: 2 },
    itemsBefore: 2,
  });
  expect(store.order).toEqual(["a", "b"]);
  expect(store.itemsBefore).toBeNull();
});
