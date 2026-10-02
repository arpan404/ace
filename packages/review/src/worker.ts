import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ReviewService } from "./service.ts";
import { WorkerInput } from "./worker-protocol.ts";
const port = parentPort;
if (!port) throw new Error("Review worker requires a parent");
const config = z.object({ path: z.string(), executor: z.boolean() }).parse(workerData);
let execution:
  | { key: number; resolve: (value: unknown) => void; reject: (error: Error) => void }
  | undefined;
let key = 0;
const execute = (intent: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    if (execution) {
      reject(new Error("review_executor_busy"));
      return;
    }
    execution = { key: ++key, resolve, reject };
    port.postMessage({ type: "execute", key, intent });
  });
const service = new ReviewService({
  path: config.path,
  now: Date.now,
  id: randomUUID,
  ...(config.executor
    ? {
        executor: {
          async fix(intent) {
            await execute(intent);
          },
          review: execute,
        },
      }
    : {}),
});
port.on("message", (input: unknown) => {
  const message = WorkerInput.parse(input);
  if (message.type === "execution") {
    if (execution?.key !== message.key) return;
    if (message.ok) execution.resolve(message.output);
    else execution.reject(new Error("review_executor_failed"));
    execution = undefined;
    return;
  }
  const run = async () => {
    try {
      return message.type === "receipt"
        ? await service.recover(message.command)
        : await service.handle(message.command, message.worktree);
    } catch {
      return { commandId: message.command.id, ok: false, error: "review_rejected" };
    }
  };
  void run().then((result) => port.postMessage({ type: "result", key: message.key, result }));
});
