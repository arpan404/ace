import { strict as assert } from "node:assert";
import { setImmediate } from "node:timers/promises";
import { Item } from "@ace/protocol";
import { ThreadStore, defaultLimits, windowSource, type ThreadSource } from "./index.ts";

// A jumped window observed for its life by a cache keyed by the window (as a thread's ledger and
// turn tree do), never unsubscribed, and then dropped. The live store outlives it.
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
assert.deepEqual(changes, { dropped: 8, held: 1, stopped: 0 }, "every open window hears changes");

// A macrotask boundary ends WeakRef's keep-alive job; only this child gets --expose-gc.
const gc = globalThis.gc;
if (!gc) throw new Error("explicit GC required");
// One collection can miss the most recently made window (V8 may still see a stale pointer to
// it); it goes on the next turn's collection. A window the store retains never goes, so a few
// turns still fail on a leak.
for (let turn = 0; turn < 10 && dropped.some((ref) => ref.deref()); turn++) {
  await setImmediate();
  gc();
}
assert.equal(
  dropped.filter((ref) => ref.deref()).length,
  0,
  "the live store must not keep dropped windows alive",
);
live.setSyncing(false);
assert.deepEqual(
  changes,
  { dropped: 8, held: 2, stopped: 0 },
  "only the window still held hears later changes",
);
assert.ok(cache.has(held));
