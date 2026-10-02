import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GitService } from "@ace/git";
import { ReviewService } from "./service.ts";
import { WorkerInput } from "./worker-protocol.ts";
const port = parentPort;
if (!port) throw new Error("Review worker requires a parent");
const config = z
  .object({
    path: z.string(),
    executor: z.boolean(),
    gitBinary: z.string().min(1).max(4096).optional(),
  })
  .parse(workerData);
let execution:
  | { key: number; resolve: (value: unknown) => void; reject: (error: Error) => void }
  | undefined;
let key = 0;
const execute = (intent: unknown, signal: AbortSignal) =>
  new Promise<unknown>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("review_closed"));
      return;
    }
    if (execution) {
      reject(new Error("review_executor_busy"));
      return;
    }
    const cancel = () => {
      execution = undefined;
      reject(new Error("review_closed"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    execution = {
      key: ++key,
      resolve: (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      reject: (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    };
    port.postMessage({ type: "execute", key, intent });
  });
const service = new ReviewService({
  path: config.path,
  now: Date.now,
  id: randomUUID,
  git: new GitService(config.gitBinary ? { gitBinary: config.gitBinary } : {}),
  ...(config.executor
    ? {
        executor: {
          async fix(intent, signal) {
            await execute(intent, signal);
          },
          review: execute,
        },
      }
    : {}),
});
port.on("message", (input: unknown) => {
  const message = WorkerInput.parse(input);
  if (message.type === "close") {
    void service.close().then(() => {
      port.postMessage({ type: "closed" });
      port.close();
    });
    return;
  }
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
        : await service.handle(message.command, message.worktree, message.target);
    } catch {
      return { commandId: message.command.id, ok: false, error: "review_rejected" };
    }
  };
  void run().then((result) => port.postMessage({ type: "result", key: message.key, result }));
});
