import { DatabaseSync } from "node:sqlite";
import { Store, createDevThread } from "./index.ts";
import { message as transcriptMessage } from "./payload-test-support.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, AgentId, ItemId, ThreadId, type ServerMessage } from "@ace/protocol";
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
    getThread: store.getThread.bind(store),
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
  it("snapshots include committed work queued behind the current publication", async () => {
    const f = await setup();
    f.store.acquireThread(f.thread.id);
    cleanups.push(() => f.store.releaseThread(f.thread.id));
    const agent = Agent.parse({
      id: "new-work",
      threadId: f.thread.id,
      parentId: null,
      origin: "root",
      fidelity: "full",
      native: { provider: "codex" },
      cwd: "/repo",
      status: { state: "working", activity: "tool" },
      createdAt: 1,
    });
    const messages: ServerMessage[] = [];
    cleanups.push(
      f.store.subscribe((events) => {
        if (events[0]?.seq === 2)
          f.store.appendEvents(f.thread.id, [
            { type: "agent.created", agent },
            { type: "thread.updated", status: { state: "working", agents: 1 } },
          ]);
      }),
    );
    cleanups.push(
      f.store.subscribe((events) => {
        if (events[0]?.seq === 2)
          cleanups.push(
            subscribe(
              f.store,
              "s",
              { kind: "thread", threadId: f.thread.id },
              undefined,
              5000,
              (message) => messages.push(message),
            ),
          );
      }),
    );
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "snapshot",
      seq: f.store.headSeq(),
      view: { agents: { [agent.id]: agent }, thread: { status: { state: "working", agents: 1 } } },
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

it.each([0, 1])("reconnects with a gap of %s without reading transcript bodies", (gap) => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  cleanups.push(() => store.close());
  const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
  store.appendEvents(
    thread.id,
    Array.from({ length: 2500 }, (_, i) => ({
      type: "item.created" as const,
      item: transcriptMessage(`i${i}`, "x".repeat(1024)),
    })),
  );
  store.appendEvents(thread.id, [{ type: "thread.updated", title: "Head" }]);
  // Meter actual SQLite body reads, independent of machine speed.
  db.function("read_body", (_value) => {
    throw new Error("Reconnect read a historical item body");
  });
  db.exec(
    "ALTER TABLE items RENAME TO metered_items; CREATE VIEW items AS SELECT thread_id, id, created_seq, read_body(item) AS item FROM metered_items",
  );
  const messages: ServerMessage[] = [];
  cleanups.push(
    subscribe(
      store,
      "s",
      { kind: "thread", threadId: thread.id },
      store.headSeq() - gap,
      5000,
      (m) => messages.push(m),
    ),
  );
  expect(messages).toHaveLength(gap);
  if (gap)
    expect(messages[0]).toMatchObject({
      type: "events",
      events: [{ payload: { type: "thread.updated", title: "Head" } }],
    });
});

it("rejects an unknown thread even when replay starts at the current head", async () => {
  const f = await setup();
  const messages: ServerMessage[] = [];
  expect(() =>
    subscribe(
      f.store,
      "missing",
      { kind: "thread", threadId: ThreadId.parse("missing") },
      f.store.headSeq(),
      5000,
      (message) => messages.push(message),
    ),
  ).toThrow("Unknown thread");
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Later" }]);
  expect(messages).toEqual([]);
});

it("thread replay never reads another thread's event payloads", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  cleanups.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "repo");
  const thread = createDevThread(store, workspace);
  const other = createDevThread(store, workspace);
  const before = store.headSeq();
  for (let i = 0; i < 20; i++) {
    store.appendEvents(other.id, [{ type: "thread.updated", title: `Other ${i}` }]);
    store.appendEvents(thread.id, [{ type: "thread.updated", title: `Mine ${i}` }]);
  }
  db.function("read_foreign", (_value) => {
    throw new Error("Replay read another thread's event");
  });
  db.exec(
    `ALTER TABLE events RENAME TO metered_events; CREATE VIEW events AS SELECT seq, id, thread_id, at, CASE WHEN thread_id = '${other.id}' THEN read_foreign(payload) ELSE payload END AS payload FROM metered_events`,
  );
  const messages: ServerMessage[] = [];
  cleanups.push(
    subscribe(store, "s", { kind: "thread", threadId: thread.id }, before, 5000, (m) =>
      messages.push(m),
    ),
  );
  expect(
    messages.flatMap((m) =>
      m.type === "events"
        ? m.events.map((e) => (e.payload.type === "thread.updated" ? e.payload.title : ""))
        : [],
    ),
  ).toEqual(Array.from({ length: 20 }, (_, i) => `Mine ${i}`));
  expect(messages.at(-1)).toMatchObject({ throughSeq: store.headSeq() });
});

it.each([2, 4])(
  "a replay with %s large items splits within budget or falls back to a snapshot",
  async (count) => {
    const f = await setup();
    const view = createThreadView(f.thread);
    const before = f.store.headSeq();
    view.seq = before;
    const texts = Array.from({ length: count }, (_, i) => String(i).repeat(700 * 1024));
    for (const [i, text] of texts.entries())
      f.store.appendEvents(f.thread.id, [
        { type: "item.created", item: transcriptMessage(`big-${i}`, text) },
      ]);
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Head" }]);
    const messages: ServerMessage[] = [];
    cleanups.push(
      subscribe(f.store, "s", { kind: "thread", threadId: f.thread.id }, before, 5000, (m) =>
        messages.push(m),
      ),
    );
    if (count === 4) {
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "snapshot",
        seq: f.store.headSeq(),
        view: { thread: { title: "Head" } },
      });
      const snapshot = messages[0];
      if (snapshot?.type !== "snapshot" || !("thread" in snapshot.view))
        throw new Error("Missing thread snapshot");
      const recovered = new Map(Object.values(snapshot.view.items).map((item) => [item.id, item]));
      let cursor = snapshot.view.itemsBefore;
      while (cursor !== null && cursor !== undefined) {
        const page = f.store.readItemPage(f.thread.id, cursor, 200);
        for (const item of page.items) recovered.set(item.id, item);
        cursor = page.itemsBefore;
      }
      expect(
        Array.from(recovered.values()).filter((item) => item.id.startsWith("big-")).length,
      ).toBe(count);
      for (const [i, text] of texts.entries()) {
        const item = recovered.get(ItemId.parse(`big-${i}`));
        if (item?.type !== "message") throw new Error("Missing recovered message");
        const actual = item.parts
          .map((part) => {
            if (part.type !== "text") return "";
            if (!part.source) return part.text;
            const bytes: Buffer[] = [];
            for (let offset = 0; offset < part.source.bytes;) {
              const chunk = f.store.readOutputBytes(
                part.source.streamId,
                offset,
                Math.min(256 * 1024, part.source.bytes - offset),
              );
              expect(chunk.nextOffset).toBeGreaterThan(offset);
              bytes.push(chunk.bytes);
              offset = chunk.nextOffset;
            }
            return Buffer.concat(bytes).toString("utf16le");
          })
          .join("");
        expect(actual === text).toBe(true);
      }
      return;
    }
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(2 * 1024 * 1024);
      if (message.type !== "events") throw new Error(`Unexpected ${message.type}`);
      expect(applyDelivery(view, message).kind).toBe("applied");
    }
    expect(view.seq).toBe(f.store.headSeq());
    expect(view.thread.title).toBe("Head");
    expect(Object.values(view.items)).toHaveLength(count);
    for (const [i, text] of texts.entries())
      expect(view.items[`big-${i}`]).toMatchObject({ parts: [{ type: "text", text }] });
  },
);
