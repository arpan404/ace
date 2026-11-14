import { expect, it } from "vitest";
import { BULK, INTERACTIVE, fragmentKinds, type Lane } from "@ace/secure-channel";
import { INTERACTIVE_RUN, SendQueue, type QueuedMessage } from "./send-queue.ts";

const message = (lane: Lane, ready = true): QueuedMessage => ({
  lane,
  kind: fragmentKinds.json,
  data: ready ? new Uint8Array(10) : undefined,
  offset: 0,
  bytes: 10,
  settle() {},
});

function lanes() {
  const queue = new SendQueue();
  queue.interleave();
  return queue;
}

it("a close queued in bulk waits for an earlier interactive message still being deflated", () => {
  const queue = lanes();
  const deflating = message(INTERACTIVE, false);
  queue.push(deflating);
  const close = message(BULK);
  queue.push(close);
  expect(queue.next()).toBeUndefined();
  deflating.data = new Uint8Array(10);
  expect(queue.next()).toBe(deflating);
  queue.finish(deflating);
  expect(queue.next()).toBe(close);
});

it("an interactive message still being deflated holds back no bulk message admitted before it", () => {
  const queue = lanes();
  const snapshot = message(BULK);
  queue.push(snapshot);
  queue.push(message(INTERACTIVE, false));
  expect(queue.next()).toBe(snapshot);
});

it("a busy interactive lane still lets bulk send one fragment in every few", () => {
  const queue = lanes();
  const snapshot = message(BULK);
  queue.push(snapshot);
  let bulkFragments = 0;
  for (let index = 0; index < 10 * (INTERACTIVE_RUN + 1); index++) {
    // A fresh interactive message is always waiting.
    if (queue.bytesIn(INTERACTIVE) === 0) queue.push(message(INTERACTIVE));
    const next = queue.next();
    if (!next) throw new Error("Expected a message");
    queue.sent(next);
    if (next.lane === BULK) bulkFragments++;
    else queue.finish(next);
  }
  expect(bulkFragments).toBe(10);
});

it("without lanes nothing goes ahead of a message still being deflated", () => {
  const queue = new SendQueue();
  queue.push(message(queue.laneFor(INTERACTIVE), false));
  queue.push(message(queue.laneFor(BULK)));
  expect(queue.next()).toBeUndefined();
});
