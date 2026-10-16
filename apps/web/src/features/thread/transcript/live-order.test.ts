import { defaultLimits, ThreadStore } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Event, Item, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { buildBlocks } from "./blocks.ts";

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Live order",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
const message = (id: string, role: "user" | "assistant", createdAt: number) =>
  Item.parse({
    id,
    agentId: "root",
    type: "message",
    role,
    createdAt,
    complete: true,
    parts: [{ type: "text", text: id }],
  });

test.each([
  { changed: "ask", initial: "live", timestamp: 20 },
  { changed: "answer", initial: "live", timestamp: 30 },
  { changed: "ask", initial: "snapshot", timestamp: 10 },
  { changed: "answer", initial: "snapshot", timestamp: 10 },
])(
  "updates to $changed retain admitted prompt order after $initial admission",
  ({ changed, initial, timestamp }) => {
    const store = new ThreadStore(defaultLimits);
    store.snapshot(createThreadView(thread));
    let seq = 0;
    const deliver = (type: "item.created" | "item.updated", item: Item) => {
      const afterSeq = seq++;
      store.delivery({
        type: "events",
        subscriptionId: "s",
        afterSeq,
        throughSeq: seq,
        events: [
          Event.parse({
            id: `event-${seq}`,
            seq,
            at: seq,
            threadId: thread.id,
            payload: { type, item },
          }),
        ],
      });
    };
    const first = message("first", "user", 10);
    const ask = message("ask", "user", timestamp);
    const answer = message("answer", "assistant", timestamp === 10 ? 10 : 30);
    if (initial === "snapshot") {
      const view = createThreadView(thread, 3);
      view.items = { first, ask, answer };
      view.itemOrder = ["answer", "ask", "first"];
      view.itemSeqs = { first: 1, ask: 2, answer: 3 };
      store.snapshot(view);
      seq = 3;
    } else {
      for (const item of [first, ask, answer]) deliver("item.created", item);
    }
    const visible = () =>
      buildBlocks({
        order: store.order,
        item: (id) => store.item(id),
        background: new Map(),
      }).flatMap((block) => ("itemId" in block ? [block.itemId] : []));
    expect(visible()).toEqual(["first", "ask", "answer"]);
    deliver(
      "item.updated",
      Item.parse({
        ...(changed === "ask" ? ask : answer),
        createdAt: changed === "ask" ? 40 : 0,
        parts: [{ type: "text", text: "Updated content" }],
      }),
    );
    expect(store.order).toEqual(["first", "ask", "answer"]);
    expect(visible()).toEqual(["first", "ask", "answer"]);
    expect(store.item(changed)).toMatchObject({ parts: [{ text: "Updated content" }] });
  },
);
