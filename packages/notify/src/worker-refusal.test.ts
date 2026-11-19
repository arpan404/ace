import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { incompatibleData } from "@ace/provider-kit/incompatible-data";
import { expect, test } from "vitest";
import { NotificationWorker } from "./worker.ts";
import { incompatibleFrame } from "./worker-wire.ts";

/** A worker that refuses its store at once, as worker-entry does, and then waits. */
class RefusingWorker extends EventEmitter {
  constructor(refusal: { path: string; message: string }) {
    super();
    queueMicrotask(() => this.emit("message", incompatibleFrame(refusal)));
  }
  postMessage() {}
  unref() {}
  async terminate() {
    return 0;
  }
}

test("a refusal longer than the worker wire allows still stops the daemon on incompatible data", async () => {
  const path = `/data/${"deep/".repeat(1200)}notifications.sqlite`;
  const message = `${path}: The notification database is format 3${".".repeat(20_000)}`;
  const worker = new NotificationWorker({
    path: "/data/notifications.sqlite",
    transport: { send: async () => "accepted" },
    // A stand-in for node:worker_threads' Worker with only what the parent uses.
    spawn: () => new RefusingWorker({ path, message }) as unknown as Worker,
    schedule: () => () => {},
  });
  const failure = await worker.cursor().catch((error: unknown) => error);
  // Recognised as a refusal (not "Invalid notification worker reply"), so startup stops on it.
  const refused = incompatibleData(failure);
  expect(refused).toBeDefined();
  expect(path.startsWith(refused?.path ?? "-")).toBe(true);
  expect(message.startsWith(refused?.message ?? "-")).toBe(true);
  await worker.close().catch(() => undefined);
});
