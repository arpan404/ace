import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { ThreadStore, defaultLimits, windowSource, type ThreadSource } from "./index.ts";
import { setup, ready, agentId, itemId } from "./test-support.ts";

/**
 * Explicit GC is a controllable memory edge, not a timing or RSS threshold. A context created
 * after the flag is set exposes `gc` without starting a child process with `--expose-gc`.
 */
async function collect(): Promise<void> {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("explicit GC required");
  // A macrotask boundary ends WeakRef's keep-alive job.
  await setImmediate();
  gc();
}

test("a paused output consumer does not retain chunks it already consumed", async () => {
  const h = await setup();
  try {
    const item = Item.parse({
      type: "tool_call",
      id: itemId,
      agentId,
      createdAt: 0,
      complete: true,
      call: {
        id: itemId,
        agentId,
        kind: "shell",
        title: "retention",
        startedAt: 0,
        status: "succeeded",
        raw: [],
        detail: { kind: "shell", command: "synthetic" },
      },
    });
    h.daemon.store.appendEvents(h.thread.id, [
      { type: "item.created", item },
      {
        type: "item.delta",
        itemId,
        agentId,
        field: "output",
        append: "x".repeat(8 * 1024 * 1024),
      },
    ]);
    const { client } = h.make();
    await ready(client);
    const stream = client.output({ streamId: `output:${itemId}`, offset: 0, limit: 256 * 1024 });
    const reference = await (async () => {
      const first = await stream.next();
      if (!first.value) throw new Error("first chunk");
      return new WeakRef(first.value);
    })();
    const sizes: number[] = [];
    for (let index = 0; index < 16; index++)
      sizes.push((await stream.next()).value?.byteLength ?? 0);
    expect(sizes).toEqual(Array.from({ length: 16 }, () => 256 * 1024));
    await collect();
    expect(reference.deref(), "consumed output chunks must be released").toBeUndefined();
    await stream.return(undefined);
  } finally {
    await h.cleanup();
  }
});

test("the live thread does not keep jumped windows alive after the reader drops them", async () => {
  // A jumped window observed for its life by a cache keyed by the window (as a thread's ledger
  // and turn tree do), never unsubscribed, and then dropped. The live store outlives it.
  const live = new ThreadStore(defaultLimits);
  const page = (n: number) =>
    Array.from({ length: 64 }, (_, index) =>
      Item.parse({
        type: "message",
        id: `item-${n}-${index}`,
        agentId: "root",
        createdAt: index,
        complete: true,
        role: "assistant",
        parts: [{ type: "text", text: `window ${n} item ${index} ${"x".repeat(1024)}` }],
      }),
    );
  const changes = { dropped: 0, held: 0, stopped: 0 };
  const cache = new WeakMap<ThreadSource, { changes: number }>();
  const observeForLife = (source: ThreadSource, count: "dropped" | "held") => {
    cache.set(source, { changes: 0 });
    source.observe(() => changes[count]++);
  };
  const openAndDrop = (n: number) => {
    const source = windowSource(live, { items: page(n), before: null });
    observeForLife(source, "dropped");
    return new WeakRef(source);
  };
  const dropped = Array.from({ length: 8 }, (_, n) => openAndDrop(n));
  const held = windowSource(live, { items: page(99), before: null });
  observeForLife(held, "held");
  const stopped = windowSource(live, { items: page(100), before: null });
  stopped.observe(() => changes.stopped++)();

  live.setSyncing(true);
  expect(changes, "every open window hears changes").toEqual({ dropped: 8, held: 1, stopped: 0 });
  await collect();
  expect(
    dropped.filter((ref) => ref.deref()),
    "the live store must not keep dropped windows alive",
  ).toHaveLength(0);
  live.setSyncing(false);
  expect(changes, "only the window still held hears later changes").toEqual({
    dropped: 8,
    held: 2,
    stopped: 0,
  });
  expect(cache.has(held)).toBe(true);
});
