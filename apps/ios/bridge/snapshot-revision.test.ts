import { native } from "./test-host.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PatchPump } from "./patch-pump.ts";

/*
 * Explicit bounded snapshot revisions for live commits. A warm begin stages;
 * ready without a matching revision must not commit. `ThreadSession` still emits
 * ready without a revision; the pump stamps the latest begin for the same
 * thread and epoch so the phone can match them without editing the session.
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

test("a warm begin stages and only its matching ready commits", async () => {
  const queue = pump();
  queue.put("thread:snapshot.begin", () => ({
    type: "thread.snapshot.begin",
    threadId: "t",
    epoch: 1,
    revision: 2,
    before: null,
  }));
  queue.put("thread:item:a", () => ({ type: "thread.item", id: "a", row: { text: "new" } }));
  queue.put("thread:ready", () => ({ type: "thread.ready", threadId: "t", epoch: 1, count: 1 }));
  // Begin leads alone (ready waits behind it); the stamped ready follows after ack.
  for (let turn = 0; turn < 30; turn++) await vi.advanceTimersByTimeAsync(1);
  const ready = native.frames.find((frame) => frame.type === "thread.ready");
  expect(ready).toMatchObject({ threadId: "t", epoch: 1, count: 1, revision: 2 });
});

test("a ready fence follows content added while the snapshot is in flight", async () => {
  const queue = pump();
  queue.put("thread:reset", () => ({ type: "thread.reset", threadId: "t", epoch: 1, revision: 1 }));
  queue.put("thread:ready", () => ({ type: "thread.ready", threadId: "t", epoch: 1, count: 1 }));
  queue.put("thread:item:late", () => ({
    type: "thread.item",
    threadId: "t",
    epoch: 1,
    id: "late",
    row: { text: "late arrival" },
  }));
  for (let turn = 0; turn < 30; turn++) await vi.advanceTimersByTimeAsync(1);
  const row = native.frames.findIndex((frame) => frame.type === "thread.item");
  const ready = native.frames.findIndex((frame) => frame.type === "thread.ready");
  expect(row).toBeGreaterThanOrEqual(0);
  expect(ready).toBeGreaterThan(row);
});

test("a stale ready for an older revision keeps the newer staging uncommitted", async () => {
  const queue = pump();
  // Newest begin wins; the queue holds one begin and one ready task.
  queue.put("thread:snapshot.begin", () => ({
    type: "thread.snapshot.begin",
    threadId: "t",
    epoch: 1,
    revision: 2,
    before: null,
  }));
  queue.put("thread:snapshot.begin", () => ({
    type: "thread.snapshot.begin",
    threadId: "t",
    epoch: 1,
    revision: 3,
    before: null,
  }));
  queue.put("thread:ready", () => ({ type: "thread.ready", threadId: "t", epoch: 1, count: 0 }));
  for (let turn = 0; turn < 30; turn++) await vi.advanceTimersByTimeAsync(1);
  const ready = native.frames.find((frame) => frame.type === "thread.ready");
  // Stamped from the latest begin, not the superseded one.
  expect(ready).toMatchObject({ revision: 3 });
});

test("snapshot begins lead rows and block later content from starving them", async () => {
  const queue = pump();
  queue.put("thread:item:a", () => ({ type: "thread.item", id: "a", row: { text: "row" } }));
  queue.put("thread:snapshot.begin", () => ({
    type: "thread.snapshot.begin",
    threadId: "t",
    epoch: 1,
    revision: 4,
    before: 10,
  }));
  for (let turn = 0; turn < 10; turn++) await vi.advanceTimersByTimeAsync(1);
  expect(native.frames[0]).toMatchObject({
    type: "thread.snapshot.begin",
    revision: 4,
    before: 10,
  });
});
