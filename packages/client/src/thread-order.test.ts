import { Event, Item, Thread } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { expect, test } from "vitest";
import { defaultLimits, ThreadStore } from "./index.ts";

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Order",
  status: { state: "done" },
  createdAt: 0,
  updatedAt: 0,
});
const message = (id: string, createdAt: number) =>
  Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "user",
    createdAt,
    complete: true,
    parts: [{ type: "text", text: id }],
  });

const snapshot = () => {
  const view = createThreadView(thread, 10);
  const items = [
    message("latest", 30),
    message("tie", 20),
    message("first", 10),
    message("second", 20),
  ];
  view.items = Object.fromEntries(items.map((item) => [item.id, item]));
  view.itemOrder = items.map((item) => item.id);
  view.itemSeqs = { first: 1, second: 2, tie: 3, latest: 4 };
  return view;
};

test("snapshot and refetch retain chronological asks with creation cursors breaking ties", () => {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(snapshot());
  expect(store.order).toEqual(["first", "second", "tie", "latest"]);
  store.snapshot(snapshot());
  expect(store.order).toEqual(["first", "second", "tie", "latest"]);
  expect(store.cursor).toBe(10);
});

test("late live asks insert before later output and notify order subscribers", () => {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(thread));
  const selected = store.select(["order"], (reader) => [...reader.order]);
  const heard: (readonly string[])[] = [];
  const stop = selected.subscribe(() => heard.push(selected.getSnapshot()));
  const events = [message("output", 30), message("ask", 10)].map((item, index) =>
    Event.parse({
      id: `event-${index}`,
      seq: index + 1,
      at: index + 1,
      threadId: thread.id,
      payload: { type: "item.created", item },
    }),
  );
  for (const event of events)
    store.delivery({
      type: "events",
      subscriptionId: "s",
      afterSeq: event.seq - 1,
      throughSeq: event.seq,
      events: [event],
    });
  expect(store.order).toEqual(["ask", "output"]);
  expect(heard.at(-1)).toEqual(["ask", "output"]);
  stop();
});
