import { native } from "./test-host.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PatchPump } from "./patch-pump.ts";

/*
 * How fast the pump drains: a backlog goes frame after frame without waiting, while a lone change
 * still waits a moment so streaming deltas can share its frame. `test-host.ts` acknowledges each
 * frame on the next turn, as Swift does after applying it.
 */

beforeEach(() => {
  vi.useFakeTimers();
  native.frames.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

function pump(): PatchPump {
  const value = new PatchPump();
  native.ack = (accepted) => value.ack(accepted);
  return value;
}
const row = (index: number) => () => ({ type: "thread.item", id: `item-${index}`, row: { index } });

test("opening a long thread drains its rows frame after frame without a pause between frames", async () => {
  const queue = pump();
  for (let index = 0; index < 100; index++) queue.put(`thread:item:${index}`, row(index));
  // Four frames of at most 32 rows, each acknowledged a turn later: well under the 3 × 8 ms that
  // waiting between frames would add. (Fake timers run a zero delay set during a tick 1 ms later.)
  for (let turn = 0; turn < 12; turn++) await vi.advanceTimersByTimeAsync(1);
  expect(native.frames).toHaveLength(100);
});

test("a single streaming change waits a moment so the next deltas can share its frame", async () => {
  const queue = pump();
  queue.put("thread:item:1", row(1));
  await vi.advanceTimersByTimeAsync(4);
  queue.put("thread:item:1", row(2));
  queue.put("thread:item:2", row(3));
  expect(native.frames).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(8);
  expect(native.frames.map((frame) => frame.id)).toEqual(["item-2", "item-3"]);
});
