import { Event, Item, Thread, type ThreadView } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { expect, test } from "vitest";
import { defaultLimits, ThreadStore } from "./index.ts";

/*
 * The window's order is the daemon's creation sequence. Timestamps are display-only: imported
 * history keeps its native times and clocks step, so `createdAt` may disagree with sequence.
 */

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Order",
  rootAgentId: "root",
  status: { state: "done" },
  createdAt: 0,
  updatedAt: 0,
});
const message = (id: string, createdAt: number, agentId = "root") =>
  Item.parse({
    id,
    agentId,
    type: "message",
    role: agentId === "root" && id.startsWith("ask") ? "user" : "assistant",
    createdAt,
    complete: true,
    parts: [{ type: "text", text: id }],
  });
/** A daemon window: items in creation order with their sequences. */
const windowOf = (seq: number, entries: [Item, number][], itemsBefore: number | null) => {
  const view: ThreadView = createThreadView(thread, seq);
  view.items = Object.fromEntries(entries.map(([item]) => [item.id, item]));
  view.itemOrder = entries.map(([item]) => item.id);
  view.itemSeqs = Object.fromEntries(entries.map(([item, at]) => [item.id, at]));
  view.itemsBefore = itemsBefore;
  return view;
};
/** One event, decoded as the wire decodes it. */
const deliver = (store: ThreadStore, seq: number, payload: object) =>
  store.delivery({
    type: "events",
    subscriptionId: "s",
    afterSeq: seq - 1,
    throughSeq: seq,
    events: [Event.parse({ id: `event-${seq}`, seq, at: seq, threadId: thread.id, payload })],
  });

// Creation sequence 1..4; timestamps run the other way.
const first = message("first", 40);
const second = message("second", 10);
const third = message("third", 30);
const live = message("live", 5);

test("snapshot, live append, older page and resnapshot all hold items in creation order", () => {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(
    windowOf(
      10,
      [
        [second, 2],
        [third, 3],
      ],
      2,
    ),
  );
  expect(store.order).toEqual(["second", "third"]);
  deliver(store, 11, { type: "item.created", item: live });
  expect(store.order).toEqual(["second", "third", "live"]);
  store.page(
    { seq: 11, threadId: thread.id, items: [first], itemSeqs: { first: 1 }, itemsBefore: null },
    2,
  );
  expect(store.order).toEqual(["first", "second", "third", "live"]);
  store.snapshot(
    windowOf(
      11,
      [
        [first, 1],
        [second, 2],
        [third, 3],
        [live, 11],
      ],
      null,
    ),
  );
  expect(store.order).toEqual(["first", "second", "third", "live"]);
});

test("an update that changes an item's timestamp leaves it where it was created", () => {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(thread));
  deliver(store, 1, { type: "item.created", item: first });
  deliver(store, 2, { type: "item.created", item: second });
  deliver(store, 3, { type: "item.updated", item: { ...first, createdAt: 99 } });
  expect(store.order).toEqual(["first", "second"]);
});

test("loading older history into a full live window keeps every live item updating", () => {
  const store = new ThreadStore({ ...defaultLimits, items: 3 });
  const tail = ["c", "d", "e"].map((id) => message(id, 1, "root"));
  store.snapshot(
    windowOf(
      10,
      tail.map((item, index): [Item, number] => [item, index + 3]),
      3,
    ),
  );
  store.page(
    {
      seq: 10,
      threadId: thread.id,
      items: [message("b", 1)],
      itemSeqs: { b: 2 },
      itemsBefore: 2,
    },
    3,
  );
  expect(store.order).toEqual(["c", "d", "e"]);
  expect(store.itemsBefore).toBe(3);
  for (const [index, id] of ["c", "e"].entries())
    deliver(store, 11 + index, {
      type: "item.delta",
      itemId: id,
      agentId: "root",
      field: "text",
      append: " more",
    });
  expect(store.item("c")).toMatchObject({ parts: [{ text: "c more" }] });
  expect(store.item("e")).toMatchObject({ parts: [{ text: "e more" }] });
});

test("a page read for a cursor the window has since trimmed past is not admitted", () => {
  const store = new ThreadStore({ ...defaultLimits, items: 3 });
  store.snapshot(windowOf(10, [[message("c", 1), 3]], 3));
  deliver(store, 11, { type: "item.created", item: message("d", 1) });
  deliver(store, 12, { type: "item.created", item: message("e", 1) });
  deliver(store, 13, { type: "item.created", item: message("f", 1) });
  expect(store.order).toEqual(["d", "e", "f"]);
  store.page(
    { seq: 13, threadId: thread.id, items: [message("b", 1)], itemSeqs: { b: 2 }, itemsBefore: 2 },
    3,
  );
  expect(store.order).toEqual(["d", "e", "f"]);
  expect(store.item("b")).toBeUndefined();
  expect(store.itemsBefore).toBe(11);
});

test("busy subagent output does not push the root's prompt and reply out of the window", () => {
  const store = new ThreadStore({ ...defaultLimits, items: 4 });
  store.snapshot(
    windowOf(
      2,
      [
        [message("ask", 1), 1],
        [message("reply", 2), 2],
      ],
      null,
    ),
  );
  for (let seq = 3; seq <= 10; seq++)
    deliver(store, seq, { type: "item.created", item: message(`sub-${seq}`, seq, "sub") });
  expect(store.order).toEqual(["ask", "reply", "sub-9", "sub-10"]);
  // Everything from sub-9 on is held; the evicted subagent output is behind the cursor.
  expect(store.itemsBefore).toBe(9);
  deliver(store, 11, {
    type: "item.delta",
    itemId: "reply",
    agentId: "root",
    field: "text",
    append: " still live",
  });
  expect(store.item("reply")).toMatchObject({ parts: [{ text: "reply still live" }] });
  // Root output takes back the window as subagents go quiet.
  for (let seq = 12; seq <= 15; seq++)
    deliver(store, seq, { type: "item.created", item: message(`root-${seq}`, seq) });
  expect(store.order).toEqual(["root-12", "root-13", "root-14", "root-15"]);
});
