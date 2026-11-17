import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { createProbeThread } from "./probe-thread.ts";
import type { IdleWorkerRuntime, WorkerPort } from "./idle-worker.ts";

test("a shared probe thread handles each reply in the context of the caller that asked, not the one that started it", async () => {
  const scope = new AsyncLocalStorage<string>();
  const handledIn: (string | undefined)[] = [];
  const runtime: IdleWorkerRuntime = {
    spawn() {
      // Node runs a worker's events in the context it was created in; this worker does the same.
      const created = AsyncLocalStorage.snapshot();
      const port = new EventEmitter() as EventEmitter & WorkerPort;
      port.postMessage = (message: unknown) => {
        const run = message as { type: string; id: number };
        if (run.type !== "run") return;
        setImmediate(() =>
          created(() =>
            port.emit("message", {
              type: "exit",
              id: run.id,
              code: 0,
              signal: null,
              reason: "exit",
              stdout: "",
              stderr: "",
            }),
          ),
        );
      };
      port.terminate = async () => 0;
      return port;
    },
    // Armed while the last reply is handled: records whose context that was.
    delay(_callback, _milliseconds) {
      handledIn.push(scope.getStore());
      return () => {};
    },
  };
  const thread = scope.run("first-user", () =>
    createProbeThread(new URL("file:///unused.ts"), runtime),
  );
  const request = { command: "cli", args: [], env: {}, maxBytes: 1024 };
  await scope.run("first-user", () => thread.run(request, new AbortController().signal));
  await scope.run("later-caller", () => thread.run(request, new AbortController().signal));
  expect(handledIn.at(-1)).toBe("later-caller");
});
