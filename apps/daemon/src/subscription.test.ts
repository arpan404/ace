import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentId, ThreadId, type ServerMessage } from "@ace/protocol";
import { applyDelivery, createThreadView } from "@ace/projection";
import { fixture } from "./socket-test-support.ts";
import { subscribe, type SubscriptionStore } from "./subscription.ts";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
  vi.useRealTimers();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  return f;
}
function port(store: SubscriptionStore): SubscriptionStore {
  return {
    snapshotThread: store.snapshotThread.bind(store),
    subscribe: store.subscribe.bind(store),
    headSeq: store.headSeq.bind(store),
    acquireThread: store.acquireThread.bind(store),
    releaseThread: store.releaseThread.bind(store),
    listThreads: store.listThreads.bind(store),
    readEvents: store.readEvents.bind(store),
  };
}
describe("subscription bootstrap", () => {
  it.each([undefined, 0])(
    "queues commits made inside snapshot or replay delivery, afterSeq=%s",
    async (afterSeq) => {
      const f = await setup();
      const messages: ServerMessage[] = [];
      let first = true;
      const stop = subscribe(
        f.store,
        "s",
        { kind: "thread", threadId: f.thread.id },
        afterSeq,
        5000,
        (message) => {
          // The event source commits while the initial delivery is still in progress.
          if (first) {
            first = false;
            f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "During send" }]);
          }
          messages.push(structuredClone(message));
        },
      );
      cleanups.push(stop);
      expect(messages.map((m) => m.type)).toEqual([
        afterSeq === undefined ? "snapshot" : "events",
        "events",
      ]);
      const view = createThreadView(f.thread);
      for (const message of messages) {
        if (message.type === "snapshot") {
          expect(message.view.seq).toBe(1);
          view.seq = message.seq;
        } else if (message.type === "events")
          expect(applyDelivery(view, message).kind).toBe("applied");
      }
      expect(view.seq).toBe(2);
      expect(view.thread.title).toBe("During send");
      expect(
        messages.flatMap((m) => (m.type === "events" ? m.events.map((e) => e.seq) : [])),
      ).toEqual(afterSeq === undefined ? [2] : [1, 2]);
    },
  );
  it("does not redeliver a buffered commit already covered by the snapshot", async () => {
    const f = await setup();
    const input = port(f.store);
    const messages: ServerMessage[] = [];
    input.listThreads = () => {
      f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Before head" }]);
      return f.store.listThreads();
    };
    cleanups.push(
      subscribe(input, "s", { kind: "threads" }, undefined, 5000, (m) => messages.push(m)),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "snapshot",
      seq: 2,
      view: { threads: { [f.thread.id]: { title: "Before head" } } },
    });
  });
  it("deduplicates commits straddling listThreads and snapshot delivery", async () => {
    const f = await setup();
    const input = port(f.store);
    const messages: ServerMessage[] = [];
    input.listThreads = () => {
      f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Before head" }]);
      return f.store.listThreads();
    };
    cleanups.push(
      subscribe(input, "s", { kind: "threads" }, undefined, 5000, (message) => {
        messages.push(structuredClone(message));
        if (message.type === "snapshot")
          f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "During send" }]);
      }),
    );
    expect(messages.map((m) => m.type)).toEqual(["snapshot", "events"]);
    expect(messages[0]).toMatchObject({
      seq: 2,
      view: { threads: { [f.thread.id]: { title: "Before head" } } },
    });
    expect(messages[1]).toMatchObject({ afterSeq: 2, throughSeq: 3 });
    expect(
      messages.flatMap((m) => (m.type === "events" ? m.events.map((e) => e.seq) : [])),
    ).toEqual([3]);
  });
  it("immediately advances replay containing only other threads without a progress timer", async () => {
    vi.useFakeTimers();
    const f = await setup();
    const other = { ...f.thread, id: ThreadId.parse("other") };
    f.store.appendEvents(other.id, [
      { type: "thread.created", thread: other },
      { type: "thread.updated", title: "Other only" },
    ]);
    const messages: ServerMessage[] = [];
    cleanups.push(
      subscribe(f.store, "s", { kind: "thread", threadId: f.thread.id }, 1, 5000, (m) =>
        messages.push(m),
      ),
    );
    expect(messages).toEqual([
      { type: "progress", subscriptionId: "s", afterSeq: 1, throughSeq: 3 },
    ]);
    vi.advanceTimersByTime(250);
    expect(messages).toHaveLength(1);
  });
  it("captures commits between reading the head and delivering the snapshot", async () => {
    const f = await setup();
    const input = port(f.store);
    const messages: ServerMessage[] = [];
    let first = true;
    // Model the event source committing at the head-read boundary, using real SQLite.
    input.headSeq = () => {
      const head = f.store.headSeq();
      if (first) {
        first = false;
        f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "After head" }]);
      }
      return head;
    };
    cleanups.push(
      subscribe(input, "s", { kind: "thread", threadId: f.thread.id }, undefined, 5000, (m) =>
        messages.push(m),
      ),
    );
    expect(messages.map((m) => m.type)).toEqual(["snapshot", "events"]);
    expect(messages[0]).toMatchObject({ type: "snapshot", seq: 1 });
    expect(messages[1]).toMatchObject({
      type: "events",
      afterSeq: 1,
      throughSeq: 2,
      events: [{ seq: 2 }],
    });
  });
  it("replays at the gap limit and snapshots only beyond it", async () => {
    const f = await setup();
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Head" }]);
    for (const [limit, expected] of [
      [3, "events"],
      [2, "events"],
      [1, "snapshot"],
    ] as const) {
      const messages: ServerMessage[] = [];
      const stop = subscribe(
        f.store,
        "s",
        { kind: "thread", threadId: f.thread.id },
        0,
        limit,
        (m) => messages.push(m),
      );
      stop();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe(expected);
      if (messages[0]?.type === "events")
        expect(messages[0].events.map((e) => e.seq)).toEqual([1, 2]);
    }
  });
  it("bounds progress delivery and cancels pending progress on unsubscribe", async () => {
    vi.useFakeTimers();
    const f = await setup();
    const messages: ServerMessage[] = [];
    const stop = subscribe(f.store, "s", { kind: "threads" }, undefined, 5000, (m) =>
      messages.push(m),
    );
    cleanups.push(stop);
    const payload = {
      type: "usage.updated",
      agentId: AgentId.parse("a"),
      inputTokens: 1,
      outputTokens: 1,
    } as const;
    f.store.appendEvents(f.thread.id, [payload]);
    f.store.appendEvents(f.thread.id, [payload]);
    vi.advanceTimersByTime(249);
    expect(messages).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(messages[1]).toMatchObject({ type: "progress", afterSeq: 1, throughSeq: 3 });
    f.store.appendEvents(f.thread.id, [payload]);
    stop();
    vi.advanceTimersByTime(250);
    expect(messages).toHaveLength(2);
  });
});
