// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vitest";
import { startWorker } from "./worker.ts";

test("a worker started inside one caller's work runs its events in no caller's context", async () => {
  const scope = new AsyncLocalStorage<string>();
  const worker = scope.run("creator", () =>
    startWorker(
      "require('node:worker_threads').parentPort.on('message', (m) => require('node:worker_threads').parentPort.postMessage(m))",
      { eval: true },
    ),
  );
  try {
    const seen = new Promise<string | undefined>((resolve) =>
      worker.once("message", () => resolve(scope.getStore())),
    );
    scope.run("later-caller", () => worker.postMessage(1));
    expect(await seen).toBeUndefined();
  } finally {
    await worker.terminate();
  }
});
