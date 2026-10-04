import { afterEach, expect, test } from "vitest";
import { Store } from "@ace/daemon";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const input = [{ type: "text" as const, text: "next" }];
function track<T extends Awaited<ReturnType<typeof harness>>>(h: T): T {
  cleanups.push(h.close);
  return h;
}
function view(store: Store, id: Parameters<Store["snapshotThread"]>[0]) {
  const result = store.snapshotThread(id);
  return result;
}

test("a full mailbox drains accepted frames before reporting overload and closing the provider", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
      limits: { maxQueuedFrames: 2 },
    }),
  );
  const id = await h.create();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing provider");
  for (const text of ["accepted one", " accepted two", " rejected three"])
    ctx.onFrame(
      frames.frame({
        type: "item.delta",
        agent: "root",
        item: "answer",
        field: "text",
        append: text,
      }),
    );
  await h.engine.flush();
  const items = Object.values(view(h.store, id).items);
  expect(items.find((item) => item.type === "message")).toMatchObject({
    parts: [{ type: "text", text: "accepted one accepted two" }],
  });
  expect(
    items.some((item) => item.type === "notice" && item.text.includes("capacity exceeded")),
  ).toBe(true);
  expect(h.store.getThread(id)?.status.state).toBe("failed");
  expect(ctx.signal.aborted).toBe(true);
  expect(h.command({ type: "thread.send", threadId: id, input, delivery: "queue" }).ok).toBe(true);
  await h.engine.flush();
  const resumed = h.contexts[1];
  if (!resumed) throw new Error("Thread did not reopen after overload");
  resumed.onFrame(frames.frame(start, end));
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("one stdout read worth of streamed deltas is folded without failing the thread", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start)] }], frames));
  const id = await h.create();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing provider");
  // A 64 KiB pipe read of ~200-byte delta lines reaches the adapter as one synchronous burst.
  const burst = Array.from({ length: 330 }, (_, index) => `${index},`);
  for (const append of burst)
    ctx.onFrame(
      frames.frame({ type: "item.delta", agent: "root", item: "answer", field: "text", append }),
    );
  await h.engine.flush();
  expect(h.errors).toEqual([]);
  expect(ctx.signal.aborted).toBe(false);
  expect(h.store.getThread(id)?.status.state).not.toBe("failed");
  expect(
    Object.values(view(h.store, id).items).find((item) => item.type === "message"),
  ).toMatchObject({ parts: [{ type: "text", text: burst.join("") }] });
});

test("mailbox overload remains resumable when its durable notice encounters a writer lock", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
      limits: { maxQueuedFrames: 2 },
    }),
  );
  const id = await h.create();
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider");
  const writer = new DatabaseSync(h.path);
  h.store.statement("PRAGMA busy_timeout=0").get();
  let locked = false;
  const unsubscribe = h.store.subscribe((events) => {
    if (!locked && events.some((event) => event.payload.type === "item.delta")) {
      writer.exec("BEGIN IMMEDIATE");
      locked = true;
    }
  });
  try {
    for (const append of ["one", "two", "rejected"])
      void Promise.resolve(
        context.onFrame(
          frames.frame({
            type: "item.delta",
            agent: "root",
            item: "answer",
            field: "text",
            append,
          }),
        ),
      ).catch(() => {});
    const flushed = h.engine.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(locked).toBe(true);
    writer.exec("COMMIT");
    unsubscribe();
    h.clock.advance(1100);
    await flushed;
    expect(h.errors).toEqual([]);
    expect(
      Object.values(view(h.store, id).items).some(
        (item) => item.type === "notice" && item.text.includes("capacity exceeded"),
      ),
    ).toBe(true);
    expect(h.command({ type: "thread.send", threadId: id, input, delivery: "queue" }).ok).toBe(
      true,
    );
    await h.engine.flush();
    expect(h.contexts).toHaveLength(2);
  } finally {
    unsubscribe();
    writer.close();
  }
});

test("actor capacity is receipt-bound and idle retirement frees a slot for another thread", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      idleMs: 500,
      limits: { maxActiveThreads: 1 },
    }),
  );
  await h.create();
  const create = {
    type: "thread.create" as const,
    workspaceId: h.workspace,
    provider: "codex" as const,
    input,
  };
  expect(h.command(create).error).toBe("engine_capacity_exceeded");
  expect(h.store.listThreads()).toHaveLength(1);
  h.clock.advance(1500);
  await h.engine.flush();
  expect(h.command(create).ok).toBe(true);
  await h.engine.flush();
  expect(h.store.listThreads()).toHaveLength(2);
  expect(h.adapter.sessions).toHaveLength(2);
});

test.each([{ maxFrameBytes: 200 }, { maxQueuedBytes: 200 }])(
  "mailbox byte limits report a large frame instead of retaining it: %j",
  async (limits) => {
    const frames = scriptFrames();
    const h = track(
      await harness([{ on: "send", frames: [frames.frame(start)] }], frames, { limits }),
    );
    const id = await h.create();
    const ctx = h.contexts[0];
    if (!ctx) throw new Error("Missing provider");
    const frame = frames.frame({
      type: "item.delta",
      agent: "root",
      item: "rejected",
      field: "text",
      append: "rejected",
    });
    ctx.onFrame({ ...frame, data: { bytes: "x".repeat(300) } });
    await h.engine.flush();
    expect(ctx.signal.aborted).toBe(true);
    expect(
      Object.values(view(h.store, id).items).some(
        (item) => item.type === "notice" && item.text.includes("capacity exceeded"),
      ),
    ).toBe(true);
    expect(Object.values(view(h.store, id).items).some((item) => item.type === "message")).toBe(
      false,
    );
  },
);

test("malformed frame envelopes fail visibly without throwing into the adapter callback", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start)] }], frames));
  const id = await h.create();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing provider");
  expect(() => ctx.onFrame({ ...frames.frame(), seq: -1 })).not.toThrow();
  await h.engine.flush();
  expect(ctx.signal.aborted).toBe(true);
  expect(
    Object.values(view(h.store, id).items).some(
      (item) => item.type === "notice" && item.level === "error",
    ),
  ).toBe(true);
});
