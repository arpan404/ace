import { afterEach, expect, test } from "vitest";
import { DatabaseSync, backup } from "node:sqlite";
import { join } from "node:path";
import { Store } from "@ace/daemon";
import type { Event } from "@ace/protocol";
import { subscribe } from "../subscription.ts";
import { harness, scriptFrames, start, end, ManualClock, until } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function streaming() {
  const frames = scriptFrames();
  const scheduler = new ManualClock();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "item.upsert",
            agent: "root",
            item: "answer",
            draft: { type: "message", role: "assistant", parts: [{ type: "text", text: "" }] },
          }),
        ],
      },
    ],
    frames,
    { storeOptions: { bufferScheduler: { delay: scheduler.setTimer } } },
  );
  cleanups.push(h.close);
  const id = await h.create();
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider");
  const append = (text: string) =>
    context.onFrame(
      frames.frame({
        type: "item.delta",
        agent: "root",
        item: "answer",
        field: "text",
        append: text,
      }),
    );
  return { ...h, id, context, frames, append, scheduler };
}

test("awaited provider deltas stream immediately while SQLite commits fewer than one batch per ten tokens", async () => {
  const h = await streaming();
  const reader = new DatabaseSync(h.path, { readOnly: true });
  try {
    const client = await h.connect("live-buffer");
    client.send({
      type: "subscribe",
      subscriptionId: "live-buffer",
      scope: { kind: "thread", threadId: h.id },
    });
    await until(client, (message) => message.type === "snapshot");
    const live: Event[] = [];
    const stop = h.store.subscribe((events) => live.push(...events));
    const before = h.store.streamingMetrics();
    await h.append("x");
    const delivered = await until(client, (message) => message.type === "events");
    expect(delivered).toMatchObject({
      type: "events",
      events: [
        expect.objectContaining({
          payload: expect.objectContaining({ type: "item.delta", append: "x" }),
        }),
      ],
    });
    expect(live.at(-1)?.payload).toMatchObject({ type: "item.delta", append: "x" });
    expect(
      reader.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item.delta'").get()?.n,
    ).toBe(0);
    for (let i = 1; i < 300; i++) await h.append("x");
    await h.engine.flush();
    stop();
    const after = h.store.streamingMetrics();
    expect(after.transactions - before.transactions).toBeLessThan(30);
    expect(after.rows - before.rows).toBeLessThan(30);
    expect(live.filter((event) => event.payload.type === "item.delta")).toHaveLength(300);
    expect(h.store.readItems(h.id, h.store.headSeq() + 1, 10).items.at(-1)).toMatchObject({
      parts: [{ type: "text", text: "x".repeat(300) }],
    });
    expect(h.errors).toEqual([]);
  } finally {
    reader.close();
  }
});

test("the timer flushes a pinned tail and turn completion cannot overtake it", async () => {
  const h = await streaming();
  await h.append("first");
  expect(h.store.streamingMetrics().bufferedBytes).toBeGreaterThan(0);
  h.scheduler.advance(1075);
  expect(h.store.streamingMetrics().bufferedBytes).toBe(0);
  await h.append(" second");
  await h.context.onFrame(h.frames.frame(end));
  const events = h.store.readEvents({ afterSeq: 0, threadId: h.id, limit: 100 });
  const deltaIndex = events.findLastIndex((event) => event.payload.type === "item.delta");
  const endedIndex = events.findIndex((event) => event.payload.type === "run.ended");
  expect(endedIndex).toBeGreaterThan(deltaIndex);
  expect(h.store.snapshotThread(h.id).thread.status.state).toBe("done");
  expect(h.store.streamingMetrics().bufferedBytes).toBe(0);
});

test("a failed batch stays pinned and retries its events and engine snapshot exactly once", async () => {
  const h = await streaming();
  h.store.atomic((db) =>
    db.exec(
      "CREATE TRIGGER fail_delta BEFORE INSERT ON events WHEN NEW.type='item.delta' BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END",
    ),
  );
  await h.append("saved ");
  await h.append("on retry");
  h.scheduler.advance(1075);
  expect(h.store.streamingMetrics().failures).toBe(1);
  expect(h.store.streamingMetrics().bufferedBytes).toBeGreaterThan(0);
  // Repair through another connection: the normal write barrier correctly refuses to overtake
  // the failed buffer, including an attempted repair on its own connection.
  const repair = new DatabaseSync(h.path);
  repair.exec("DROP TRIGGER fail_delta");
  repair.close();
  h.scheduler.advance(1175);
  expect(h.store.streamingMetrics().bufferedBytes).toBe(0);
  expect(h.store.readItems(h.id, h.store.headSeq() + 1, 10).items.at(-1)).toMatchObject({
    parts: [{ type: "text", text: "saved on retry" }],
  });
  await h.append("!");
  await h.engine.flush();
  expect(h.store.readItems(h.id, h.store.headSeq() + 1, 10).items.at(-1)).toMatchObject({
    parts: [{ type: "text", text: "saved on retry!" }],
  });
});

test("reconnecting inside a compacted delta batch replaces the tail with a snapshot", async () => {
  const h = await streaming();
  await h.append("a");
  const cursor = h.store.headSeq();
  await h.append("b");
  await h.append("c");
  const messages: unknown[] = [];
  const stop = subscribe(
    h.store,
    "reconnect",
    { kind: "thread", threadId: h.id },
    cursor,
    1000,
    (message) => messages.push(message),
  );
  stop();
  expect(messages[0]).toMatchObject({ type: "snapshot", view: { itemOrder: expect.any(Array) } });
  expect(h.store.snapshotThread(h.id).items).toEqual(
    expect.objectContaining({
      [h.store.snapshotThread(h.id).itemOrder.at(-1) ?? "missing"]: expect.objectContaining({
        parts: [{ type: "text", text: "abc" }],
      }),
    }),
  );
});

test("read snapshots are isolated and invalidated by local and cross-connection writes", async () => {
  const h = await streaming();
  const first = h.store.snapshotThread(h.id);
  first.thread.title = "caller mutation";
  expect(h.store.snapshotThread(h.id).thread.title).not.toBe("caller mutation");
  expect(h.store.streamingMetrics().reads.hits).toBeGreaterThan(0);
  await h.append("fresh");
  expect(h.store.snapshotThread(h.id).items).not.toEqual(first.items);
  const writer = new DatabaseSync(h.path);
  writer.prepare("UPDATE threads SET title=? WHERE id=?").run("outside", h.id);
  writer.close();
  expect(h.store.snapshotThread(h.id).thread.title).toBe("outside");
  h.store.appendEvents(h.id, [{ type: "thread.updated", title: "inside" }]);
  expect(h.store.snapshotThread(h.id).thread.title).toBe("inside");
});

test("large unicode chunks drain at the size bound and an idle checkpoint stops disk growth", async () => {
  const h = await streaming();
  const chunk = "🌊".repeat(20000);
  await h.append(chunk);
  await h.append(chunk);
  const metrics = h.store.streamingMetrics();
  expect(metrics.peakBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(metrics.bufferedBytes).toBe(0);
  expect(h.store.readItems(h.id, h.store.headSeq() + 1, 10).items.at(-1)).toMatchObject({
    parts: [{ type: "text", text: chunk + chunk }],
  });
  h.scheduler.advance(6000);
  expect(h.store.streamingMetrics().walBytes).toBe(0);
  const idle = h.store.streamingMetrics();
  h.scheduler.advance(12000);
  expect(h.store.streamingMetrics().transactions).toBe(idle.transactions);
  expect(h.store.streamingMetrics().walBytes).toBe(0);
});

test("a raw write on the Store connection invalidates previously cached snapshots", async () => {
  const h = await streaming();
  h.store.snapshotThread(h.id);
  h.store.snapshotThread(h.id);
  h.store.statement("UPDATE threads SET title=? WHERE id=?").run("raw update", h.id);
  expect(h.store.snapshotThread(h.id).thread.title).toBe("raw update");
});

test("a cursor ahead of the recovered durable head receives a replacement snapshot", async () => {
  const h = await streaming();
  await h.append("reserved");
  const messages: unknown[] = [];
  const stop = subscribe(
    h.store,
    "crash",
    { kind: "thread", threadId: h.id },
    h.store.headSeq() + 10,
    1000,
    (message) => messages.push(message),
  );
  stop();
  expect(messages[0]).toMatchObject({ type: "snapshot", seq: h.store.headSeq() });
  expect(h.store.streamingMetrics().replayResyncs).toBeGreaterThan(0);
});

test("restart never reuses a sequence already delivered by a lost buffered tail", async () => {
  const h = await streaming();
  await h.append("live only");
  const lostCursor = h.store.headSeq();
  const durable = new DatabaseSync(h.path, { readOnly: true });
  const crashPath = join(h.home, "crash.sqlite");
  try {
    await backup(durable, crashPath);
  } finally {
    durable.close();
  }
  const recovered = new Store(crashPath);
  try {
    recovered.appendEvents(h.id, [{ type: "thread.updated", title: "recovered" }]);
    expect(recovered.headSeq()).toBeGreaterThan(lostCursor);
    const messages: unknown[] = [];
    const stop = subscribe(
      recovered,
      "recovered",
      { kind: "thread", threadId: h.id },
      lostCursor,
      1000,
      (message) => messages.push(message),
    );
    stop();
    expect(messages[0]).toMatchObject({ type: "snapshot" });
    expect(recovered.readItems(h.id, recovered.headSeq() + 1, 10).items.at(-1)).toMatchObject({
      parts: [{ type: "text", text: "" }],
    });
  } finally {
    await recovered.close();
  }
});

test("a snapshot-patch failure rolls back event rows and retains patches for retry", async () => {
  const h = await streaming();
  h.store.atomic((db) =>
    db.exec(
      "CREATE TRIGGER fail_patch BEFORE INSERT ON engine_state_appends BEGIN SELECT RAISE(ABORT, 'patch unavailable'); END",
    ),
  );
  await h.append("one");
  await h.append(" two");
  h.scheduler.advance(1075);
  const reader = new DatabaseSync(h.path);
  try {
    expect(
      reader.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item.delta'").get()?.n,
    ).toBe(0);
    reader.exec("DROP TRIGGER fail_patch");
  } finally {
    reader.close();
  }
  h.scheduler.advance(1175);
  expect(h.store.streamingMetrics().bufferedBytes).toBe(0);
  await h.append(" three");
  await h.engine.flush();
  expect(h.store.readItems(h.id, h.store.headSeq() + 1, 10).items.at(-1)).toMatchObject({
    parts: [{ type: "text", text: "one two three" }],
  });
});

test("compacted sequence spans keep turn navigation, search and usage replay current", async () => {
  const h = await streaming();
  await h.append("needle");
  await h.append(" in a batch");
  await h.context.onFrame(h.frames.frame(end));
  const turns = h.store.turnsPage({ threadId: h.id, limit: 10 });
  expect(turns.ready).toBe(true);
  expect(turns.turns.at(-1)).toMatchObject({
    outcome: "completed",
    latestAgentMessagePreview: "needle in a batch",
  });
  while (h.store.search.flush(128) > 0) {
    /* Drain bounded FTS work. */
  }
  const search = h.store.threadSearch({
    threadId: h.id,
    text: "needle",
    scope: "thread",
    limit: 10,
  });
  expect(search.ready).toBe(true);
  expect(search.hits).toHaveLength(1);
  expect(h.store.readUsagePage({ afterSeq: 0, limit: 256 }).throughSeq).toBe(h.store.headSeq());
});
