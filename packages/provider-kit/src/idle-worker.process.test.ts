/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { IdleWorker } from "./idle-worker.ts";
import { z } from "zod";
const Echo = z.object({ input: z.number(), count: z.number() });
const entry = new URL("./testing/idle-worker.mjs", import.meta.url);
function scheduler() {
  let callback: (() => void) | undefined;
  return {
    delay(next: () => void) {
      callback = next;
      return () => {
        callback = undefined;
      };
    },
    advance() {
      const next = callback;
      callback = undefined;
      next?.();
    },
  };
}
async function echo(worker: IdleWorker, input: number) {
  const reply = once(worker, "message");
  worker.postMessage(input);
  return Echo.parse((await reply)[0]);
}
test("an unused worker closes without starting an isolate", async () => {
  const time = scheduler();
  const worker = new IdleWorker(
    entry,
    {},
    {
      delay: time.delay,
      spawn() {
        throw new Error("Unexpected worker start");
      },
    },
  );
  expect(await worker.terminate()).toBe(0);
  expect(() => worker.postMessage(1)).toThrow("Worker closed");
});
test("idle retirement releases the isolate and later work starts with a fresh process state", async () => {
  const time = scheduler();
  const worker = new IdleWorker(
    entry,
    {},
    { spawn: (url, options) => new Worker(url, options), delay: time.delay },
  );
  try {
    expect(await echo(worker, 1)).toEqual({ input: 1, count: 1 });
    expect(await echo(worker, 2)).toEqual({ input: 2, count: 2 });
    worker.idle();
    time.advance();
    expect(await echo(worker, 3)).toEqual({ input: 3, count: 1 });
  } finally {
    await worker.terminate();
  }
});
test("new work cancels retirement and keeps the current isolate until its owner declares idle again", async () => {
  const time = scheduler();
  const worker = new IdleWorker(
    entry,
    {},
    { spawn: (url, options) => new Worker(url, options), delay: time.delay },
  );
  try {
    expect((await echo(worker, 1)).count).toBe(1);
    worker.idle();
    expect((await echo(worker, 2)).count).toBe(2);
    time.advance();
    expect((await echo(worker, 3)).count).toBe(3);
  } finally {
    await worker.terminate();
  }
});
