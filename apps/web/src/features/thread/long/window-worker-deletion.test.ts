import { ClientCore, type TransportEvents } from "@ace/client";
import { windowSource } from "@ace/client-react";
import { ClientHost, RemoteClient } from "@ace/client-worker";
import { ClientMessage, DeviceId, Event, Item, Thread, ThreadView } from "@ace/protocol";
import { expect, test, vi } from "vitest";
import { Jump } from "./jump.ts";

const timers = {
  set(ms: number, run: () => void) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
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

test("a worker-backed jumped window never restores a deleted input when its tail detaches or resets", async () => {
  let socket: TransportEvents | undefined;
  let wire = "";
  let ids = 0;
  const thread = Thread.parse({
    id: "thread",
    workspaceId: "workspace",
    provider: "codex",
    title: "History",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  });
  let view = ThreadView.parse({
    kind: "thread",
    thread,
    seq: 3,
    agents: {},
    agentChildren: {},
    runs: {},
    interactions: {},
    backgroundTasks: {},
    usage: {},
    items: { queued: message("queued"), newer: message("newer") },
    itemOrder: ["queued", "newer"],
    itemSeqs: { queued: 2, newer: 3 },
    itemsBefore: 2,
  });
  const deliver = (frame: unknown) => socket?.message(JSON.stringify(frame));
  const core = new ClientCore({
    deviceId: DeviceId.parse("device"),
    storage: { load: async () => null, save: async () => {} },
    scheduler: timers,
    random: () => 0.5,
    id: () => `id-${++ids}`,
    credential: async () => "a".repeat(64),
    limits: { items: 2 },
    transport: () => ({
      open(events) {
        socket = events;
        queueMicrotask(() =>
          deliver({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 3 }),
        );
      },
      send(text) {
        const request = ClientMessage.parse(JSON.parse(text));
        if (request.type === "subscribe" && request.scope.kind === "thread") {
          wire = request.subscriptionId;
          queueMicrotask(() =>
            deliver({ type: "snapshot", subscriptionId: wire, seq: view.seq, view }),
          );
        } else if (request.type === "items.window") {
          queueMicrotask(() =>
            deliver({
              type: "items.window",
              requestId: request.requestId,
              threadId: thread.id,
              seq: 3,
              targetSeq: 1,
              items: [message("older"), message("queued")],
              itemSeqs: { older: 1, queued: 2 },
              itemsBefore: null,
              itemsAfter: 2,
            }),
          );
        } else if (request.type === "turns.page") {
          queueMicrotask(() =>
            deliver({
              type: "turns.page",
              requestId: request.requestId,
              threadId: thread.id,
              seq: view.seq,
              indexedSeq: view.seq,
              ready: true,
              turns: [],
              before: null,
              after: null,
            }),
          );
        }
      },
      close() {},
    }),
  });
  const host = new ClientHost({
    target: () => ({ key: "same-host", create: () => core }),
    scheduler: timers,
    now: () => 0,
    frameMs: 1,
    lingerMs: 1,
  });
  const tab = () => {
    const { port1, port2 } = new MessageChannel();
    host.attach(port1);
    return new RemoteClient(port2, {}, { scheduler: timers });
  };
  const first = tab();
  const second = tab();
  try {
    await first.start();
    const held = first.thread(thread.id);
    await vi.waitFor(() => expect(held.store.order).toEqual(["queued", "newer"]));
    const jump = new Jump(first, thread.id);
    jump.setTail(() => ({
      order: held.store.order,
      before: held.store.itemsBefore,
      firstItemOf: () => undefined,
    }));
    await jump.toSeq(1);
    const window = jump.snapshot().window;
    if (!window) throw new Error("Expected jumped window");
    expect(jump.snapshot().joined).toBe(true);
    const joined = jump.source(held.store, window, true);
    if (!joined) throw new Error("Expected source");
    const selection = joined.select(["order", "item:queued"], (reader) => reader.order);
    const stop = selection.subscribe(() => {});
    deliver({
      type: "events",
      subscriptionId: wire,
      afterSeq: 3,
      throughSeq: 4,
      events: [
        Event.parse({
          id: "delete",
          threadId: thread.id,
          seq: 4,
          at: 0,
          payload: { type: "item.deleted", itemId: "queued" },
        }),
      ],
    });
    await vi.waitFor(() => expect(selection.getSnapshot()).toEqual(["older", "newer"]));
    expect(joined.item("queued")).toBeUndefined();
    // A newly attached tab receives deletion facts in its initial full mirror reset.
    await second.start();
    const late = second.thread(thread.id);
    await vi.waitFor(() => expect(late.store.order).toEqual(["newer"]));
    const lateWindow = windowSource(late.store, {
      items: window.items,
      before: null,
      joined: false,
    });
    expect(lateWindow.order).toEqual(["older"]);
    expect(lateWindow.item("queued")).toBeUndefined();
    deliver({
      type: "events",
      subscriptionId: wire,
      afterSeq: 4,
      throughSeq: 6,
      events: ["latest-a", "latest-b"].map((id, index) =>
        Event.parse({
          id,
          threadId: thread.id,
          seq: 5 + index,
          at: 0,
          payload: { type: "item.created", item: message(id) },
        }),
      ),
    });
    await vi.waitFor(() => expect(held.store.order).toEqual(["latest-a", "latest-b"]));
    jump.tailMoved();
    expect(jump.snapshot().joined).toBe(false);
    const detached = jump.source(held.store, window, false);
    expect(detached?.order).toEqual(["older"]);
    expect(detached?.item("queued")).toBeUndefined();
    // A cursor gap forces a fresh authoritative snapshot, replacing the live tombstones.
    view = ThreadView.parse({
      ...view,
      seq: 6,
      items: { "latest-a": message("latest-a"), "latest-b": message("latest-b") },
      itemOrder: ["latest-a", "latest-b"],
      itemSeqs: { "latest-a": 5, "latest-b": 6 },
      itemsBefore: 5,
    });
    const oldWire = wire;
    deliver({ type: "progress", subscriptionId: wire, afterSeq: 99, throughSeq: 100 });
    await vi.waitFor(() => expect(wire).not.toBe(oldWire));
    await vi.waitFor(() => expect(held.store.deleted?.("queued")).toBe(false));
    const recreated = jump.source(held.store, window, false);
    expect(recreated?.order).toEqual(["older"]);
    expect(recreated?.item("queued")).toBeUndefined();
    stop();
    held.release();
    late.release();
    jump.dispose();
  } finally {
    await first.close();
    await second.close();
    await core.close();
  }
});
