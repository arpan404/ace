import { ThreadStore, defaultLimits } from "@ace/client";
import { Event, Item, Thread, ThreadView } from "@ace/protocol";
import { expect, test } from "vitest";
import { windowSource } from "./index.ts";

const message = (id: string) =>
  Item.parse({
    type: "message",
    id,
    agentId: "root",
    role: "user",
    complete: true,
    createdAt: 0,
    parts: [{ type: "text", text: id }],
  });

for (const action of ["delete", "evict"] as const) {
  test(`a joined history window ${action === "delete" ? "removes deleted input" : "retains input evicted from the tail"}`, () => {
    const thread = Thread.parse({
      id: "thread",
      workspaceId: "workspace",
      provider: "codex",
      title: "History",
      status: { state: "done" },
      createdAt: 0,
      updatedAt: 0,
    });
    const store = new ThreadStore({ ...defaultLimits, items: 2 });
    const view = ThreadView.parse({
      kind: "thread",
      thread,
      seq: 0,
      agents: {},
      runs: {},
      items: {},
      itemOrder: [],
      interactions: {},
      backgroundTasks: {},
      usage: {},
      usageSnapshots: {},
      agentChildren: {},
    });
    view.items = { queued: message("queued"), newer: message("newer") };
    view.itemOrder = ["queued", "newer"];
    view.itemSeqs = { queued: 1, newer: 2 };
    view.seq = 2;
    store.snapshot(view);
    const source = windowSource(store, {
      items: [message("older"), message("queued")],
      before: null,
      joined: true,
    });
    const selection = source.select(["order", "item:queued"], (reader) => ({
      order: reader.order,
      queued: reader.item("queued"),
    }));
    const seen: unknown[] = [];
    const stop = selection.subscribe(() => seen.push(selection.getSnapshot()));
    store.delivery({
      type: "events",
      subscriptionId: "thread",
      afterSeq: 2,
      throughSeq: 3,
      events: [
        Event.parse({
          id: "change",
          threadId: thread.id,
          seq: 3,
          at: 0,
          payload:
            action === "delete"
              ? { type: "item.deleted", itemId: "queued" }
              : { type: "item.created", item: message("latest") },
        }),
      ],
    });
    expect(store.item("queued")).toBeUndefined();
    if (action === "delete") {
      expect(selection.getSnapshot().order).toEqual(["older", "newer"]);
      expect(source.item("queued")).toBeUndefined();
      expect(seen).toHaveLength(1);
    } else {
      expect(source.order).toEqual(["older", "queued", "newer", "latest"]);
      expect(source.item("queued")).toEqual(message("queued"));
    }
    stop();
  });
}
