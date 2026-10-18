/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { IdleWorker } from "./idle-worker.ts";

class Port extends EventEmitter {
  postMessage(): void {}
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

/** A manual clock: `advance` fires due timers in order, like real time passing. */
function harness() {
  let now = 0;
  let spawned = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const runtime = {
    spawn() {
      spawned++;
      return new Port();
    },
    delay(run: () => void, milliseconds: number) {
      const timer = { at: now + milliseconds, run };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    now: () => now,
  };
  const worker = new IdleWorker(new URL("./testing/idle-worker.mjs", import.meta.url), {}, runtime);
  const advance = async (milliseconds: number) => {
    const end = now + milliseconds;
    for (;;) {
      const due = [...timers].filter((t) => t.at <= end).toSorted((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due);
      now = due.at;
      due.run();
      await setImmediate();
    }
    now = end;
  };
  /** One request/reply cycle: the RPC owner declares idle once the reply is in. */
  const request = () => {
    worker.postMessage("call");
    worker.idle();
  };
  return { worker, advance, request, spawned: () => spawned };
}

test("a worker woken every 15 seconds stops paying a cold start for every request", async () => {
  const { worker, advance, request, spawned } = harness();
  try {
    for (let i = 0; i < 12; i++) {
      request();
      await advance(15_000);
    }
    // Fixed 5 s retirement would spawn twelve isolates; the window grows past the gap instead.
    expect(spawned()).toBeLessThanOrEqual(3);
  } finally {
    await worker.terminate();
  }
});

test("a worker left quiet still retires, and a later burst starts from the short window", async () => {
  const { worker, advance, request, spawned } = harness();
  try {
    for (let i = 0; i < 6; i++) {
      request();
      await advance(15_000);
    }
    const busy = spawned();
    // Ten quiet minutes: the isolate must be gone, whatever window it had grown to.
    await advance(600_000);
    request();
    expect(spawned()).toBe(busy + 1);
    // Back on the base window: a 6 s pause after this reply retires the isolate again.
    await advance(6_000);
    request();
    expect(spawned()).toBe(busy + 2);
  } finally {
    await worker.terminate();
  }
});

test("a worker whose requests stay minutes apart keeps the short window", async () => {
  const { worker, advance, request, spawned } = harness();
  try {
    for (let i = 0; i < 4; i++) {
      request();
      await advance(300_000);
    }
    expect(spawned()).toBe(4);
    // Still retiring after five seconds, so the isolate is not held between rare requests.
    request();
    await advance(6_000);
    request();
    expect(spawned()).toBe(6);
  } finally {
    await worker.terminate();
  }
});
