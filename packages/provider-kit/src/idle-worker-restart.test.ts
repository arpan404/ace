/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { IdleWorker } from "./idle-worker.ts";

class Port extends EventEmitter {
  rejectMessage = false;
  messages: unknown[] = [];
  postMessage(message: unknown): void {
    if (this.rejectMessage) throw new Error("message refused");
    this.messages.push(message);
  }
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

test.each(["spawn", "message"])(
  "queued RPCs report a replacement %s failure and later requests recover",
  async (failure) => {
    const first = new Port();
    const replacement = new Port();
    const recovered = new Port();
    let spawned = 0;
    let resume: (() => void) | undefined;
    const worker = new IdleWorker(
      new URL("./testing/idle-worker.mjs", import.meta.url),
      {},
      {
        spawn() {
          spawned++;
          if (spawned === 1) return first;
          if (spawned === 2) {
            if (failure === "spawn") throw new Error("spawn refused");
            replacement.rejectMessage = true;
            return replacement;
          }
          return recovered;
        },
        delay(callback) {
          resume = callback;
          return () => {
            resume = undefined;
          };
        },
      },
    );
    const errors: string[] = [];
    worker.on("error", (error: Error) => errors.push(error.message));
    try {
      worker.postMessage("before");
      first.emit("exit", 1);
      worker.postMessage("queued");
      resume?.();
      await setImmediate();
      expect(errors).toEqual([`${failure} refused`]);
      if (failure === "message") {
        replacement.emit("exit", 1);
        resume?.();
        await setImmediate();
      }
      worker.postMessage("later");
      expect(recovered.messages).toEqual(["later"]);
    } finally {
      await worker.terminate();
    }
  },
);
