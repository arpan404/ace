import { expect, test } from "vitest";
import { Engine, Store } from "@ace/daemon";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const input = [{ type: "text" as const, text: "try again" }];

test("a translator failure stops its session and the next send rebuilds the actor", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "send", frames: [frames.frame(start)] },
    ],
    frames,
    {
      createTranslator: () => ({
        translate(frame) {
          if (frame.channel === "unexpected") throw new Error("Malformed provider frame");
          return frames.translate(frame);
        },
        tick: () => [],
      }),
    },
  );
  try {
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing context");
    const ack = Promise.resolve(
      context.onFrame({ seq: 100, t: 100, dir: "recv", channel: "unexpected", data: {} }),
    );
    const rejected = expect(ack).rejects.toThrow("failed to commit");
    await h.engine.flush();
    await rejected;
    expect(context.signal.aborted).toBe(true);
    h.clock.advance(1100);
    expect(h.command({ type: "thread.send", threadId: id, input, delivery: "queue" }).ok).toBe(
      true,
    );
    await h.engine.flush();
    expect(h.contexts).toHaveLength(2);
    const resumed = h.contexts[1];
    if (!resumed) throw new Error("Missing resumed provider");
    resumed.onFrame(frames.frame(end));
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});

test("raw stream overflow drops optional bytes and process exit frees incomplete stream slots", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    for (let i = 0; i < 12; i++) {
      h.store.atomic(() =>
        h.store.appendRawChunk(id, { id: `blob-${i}`, offset: 0, text: "partial" }),
      );
      h.store.atomic(() =>
        h.store.appendRawChunk(id, { id: `blob-${i}`, offset: 7, text: "tail" }),
      );
    }
    const context = h.contexts[0];
    if (!context) throw new Error("Missing context");
    context.onFrame(frames.frame({ type: "process.exited", deliberate: true }));
    await h.engine.flush();
    h.store.atomic(() => {
      h.store.appendRawChunk(id, { id: "finished", offset: 0, text: "new" });
      h.store.appendRawChunk(id, { id: "finished", offset: 3, done: true });
    });
    expect(Buffer.from(h.store.readRawChunk("finished", 0, 16)).toString()).toBe("new");
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
});

test("startup removes interrupted raw streams and leaves completed blobs readable", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  let resumed: Engine | undefined;
  let store: Store | undefined;
  try {
    const id = await h.create();
    await h.engine.close();
    for (let i = 0; i < 8; i++)
      h.store.atomic(() =>
        h.store.appendRawChunk(id, { id: `stale-${i}`, offset: 0, text: "old" }),
      );
    store = new Store(h.path);
    resumed = new Engine(store, { registry: h.registry, clock: h.clock });
    await resumed.flush();
    const opened = store;
    opened.atomic(() => {
      opened.appendRawChunk(id, { id: "recovered", offset: 0, text: "recovered" });
      opened.appendRawChunk(id, { id: "recovered", offset: 9, done: true });
    });
    expect(Buffer.from(opened.readRawChunk("recovered", 0, 16)).toString()).toBe("recovered");
  } finally {
    await resumed?.close();
    store?.close();
    await h.close();
  }
});

test("startup recovers active work without decoding an unrelated completed thread's snapshot", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start)] },
    ],
    frames,
  );
  let resumed: Engine | undefined;
  let store: Store | undefined;
  try {
    const cold = await h.create();
    const active = await h.create();
    await h.engine.close();
    h.store.atomic((db) =>
      db
        .prepare("UPDATE thread_state SET state='unreadable cold snapshot' WHERE thread_id=?")
        .run(cold),
    );
    store = new Store(h.path);
    resumed = new Engine(store, { registry: h.registry, clock: h.clock });
    await resumed.flush();
    expect(store.getThread(cold)?.status.state).toBe("done");
    expect(store.getThread(active)?.status.state).not.toBe("working");
  } finally {
    await resumed?.close();
    store?.close();
    await h.close();
  }
});
