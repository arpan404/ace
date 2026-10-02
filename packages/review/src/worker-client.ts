// Node worker_threads.postMessage has no browser targetOrigin.
/* eslint-disable unicorn/require-post-message-target-origin */
import { Worker } from "node:worker_threads";
import { Command, ReviewerOutput, type CommandResult } from "@ace/protocol";
import type { ReviewExecutor } from "./intents.ts";
import { WorkerOutput } from "./worker-protocol.ts";

export class ReviewWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve: (result: CommandResult) => void; reject: (error: Error) => void }
  >();
  private readonly lifetime = new AbortController();
  private key = 0;
  private closed = false;
  constructor(path: string, executor?: ReviewExecutor) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { path, executor: Boolean(executor) },
    });
    this.worker.on("error", (error) =>
      this.fail(error instanceof Error ? error : new Error("Review worker failed")),
    );
    this.worker.on("exit", () => this.fail(new Error("Review worker stopped")));
    this.worker.on("message", (input: unknown) => {
      const parsed = WorkerOutput.safeParse(input);
      if (!parsed.success) {
        this.fail(new Error("Invalid review worker response"));
        void this.worker.terminate();
        return;
      }
      const message = parsed.data;
      if (message.type === "result") {
        this.pending.get(message.key)?.resolve(message.result);
        this.pending.delete(message.key);
        return;
      }
      const run = async () => {
        if (!executor) throw new Error("Executor unavailable");
        if (message.intent.kind === "review-fix") {
          await executor.fix(message.intent, this.lifetime.signal);
          return undefined;
        }
        return ReviewerOutput.parse(await executor.review(message.intent, this.lifetime.signal));
      };
      void run().then(
        (output) => {
          if (!this.closed)
            this.worker.postMessage({
              type: "execution",
              key: message.key,
              ok: true,
              ...(output ? { output } : {}),
            });
        },
        () => {
          if (!this.closed)
            this.worker.postMessage({ type: "execution", key: message.key, ok: false });
        },
      );
    });
  }
  handle(input: unknown, worktree?: string): Promise<CommandResult> {
    if (this.closed) return Promise.reject(new Error("Review worker closed"));
    const command = Command.parse(input);
    if (this.pending.size >= 16)
      return Promise.resolve({ commandId: command.id, ok: false, error: "review_busy" });
    const key = ++this.key;
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      this.worker.postMessage({ type: "command", key, command, ...(worktree ? { worktree } : {}) });
    });
  }
  /** The engine calls this only after the fixing agent's whole tree settles. */
  async afterFix(sessionId: string, requestId: string): Promise<CommandResult> {
    const listed = await this.handle(
      Command.parse({
        id: `${requestId}:review-source`,
        deviceId: "review-engine",
        payload: { type: "review.list", sessionId, limit: 1 },
      }),
    );
    const source = listed.review?.session?.source;
    if (!listed.ok || !source) return listed;
    return this.handle(
      Command.parse({
        id: `${requestId}:review-refresh`,
        deviceId: "review-engine",
        payload: {
          type: "review.refresh",
          sessionId,
          from: source.from,
          to: { kind: "working-tree" },
        },
      }),
    );
  }
  private fail(error: Error) {
    this.closed = true;
    this.lifetime.abort();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  async close(): Promise<void> {
    this.fail(new Error("Review worker closed"));
    await this.worker.terminate();
  }
}
