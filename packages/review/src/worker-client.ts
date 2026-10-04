// Node worker_threads.postMessage has no browser targetOrigin.
/* eslint-disable unicorn/require-post-message-target-origin */
import { Worker, type WorkerOptions } from "node:worker_threads";
import { IdleWorker } from "@ace/provider-kit/idle-worker";
import {
  Command,
  ReviewerOutput,
  type CommandResult,
  type ReviewExecutionTarget,
} from "@ace/protocol";
import type { ReviewExecutor } from "./intents.ts";
import { WorkerInput, WorkerOutput } from "./worker-protocol.ts";

export interface ReviewWorkerOptions {
  gitBinary?: string;
  createWorker?: (url: URL, options: WorkerOptions) => Worker;
}

export class ReviewWorker {
  private readonly worker: IdleWorker;
  private readonly persistent: boolean;
  private readonly pending = new Map<
    number,
    { resolve: (result: CommandResult) => void; reject: (error: Error) => void }
  >();
  private readonly lifetime = new AbortController();
  private key = 0;
  private closed = false;
  private readonly executions = new Set<Promise<void>>();
  private readonly exit = Promise.withResolvers<void>();
  private exited = false;
  private closing: Promise<void> | undefined;
  constructor(path: string, executor?: ReviewExecutor, options: ReviewWorkerOptions = {}) {
    this.persistent = path !== ":memory:";
    const create = options.createWorker ?? ((url, init) => new Worker(url, init));
    this.worker = new IdleWorker(
      new URL("./worker.ts", import.meta.url),
      {
        workerData: {
          path,
          executor: Boolean(executor),
          ...(options.gitBinary ? { gitBinary: options.gitBinary } : {}),
        },
      },
      {
        spawn: create,
        delay(callback, milliseconds) {
          const timer = setTimeout(callback, milliseconds);
          timer.unref();
          return () => clearTimeout(timer);
        },
      },
    );
    this.worker.on("error", (error) =>
      this.fail(error instanceof Error ? error : new Error("Review worker failed")),
    );
    this.worker.on("exit", () => {
      this.exited = true;
      this.fail(new Error("Review worker stopped"));
      this.exit.resolve();
    });
    this.worker.on("message", (input: unknown) => {
      const parsed = WorkerOutput.safeParse(input);
      if (!parsed.success) {
        this.fail(new Error("Invalid review worker response"));
        void this.close();
        return;
      }
      const message = parsed.data;
      if (message.type === "closed") return;
      if (message.type === "result") {
        this.pending.get(message.key)?.resolve(message.result);
        this.pending.delete(message.key);
        this.retireIfIdle();
        return;
      }
      if (this.closed) return;
      if (this.executions.size >= 16) {
        this.worker.postMessage({ type: "execution", key: message.key, ok: false });
        return;
      }
      const run = async () => {
        if (this.closed) throw new Error("Review worker closed");
        if (!executor) throw new Error("Executor unavailable");
        if (message.intent.kind === "review-fix") {
          await executor.fix(message.intent, this.lifetime.signal);
          return undefined;
        }
        return ReviewerOutput.parse(await executor.review(message.intent, this.lifetime.signal));
      };
      // Register ownership before invoking an executor, including reentrant close.
      const execution = Promise.resolve()
        .then(run)
        .then(
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
      this.executions.add(execution);
      void execution.then(
        () => {
          this.executions.delete(execution);
          this.retireIfIdle();
        },
        () => {
          this.executions.delete(execution);
          this.retireIfIdle();
        },
      );
    });
  }
  handle(
    input: unknown,
    worktree?: string,
    target?: ReviewExecutionTarget,
  ): Promise<CommandResult> {
    return this.request("command", input, worktree, target);
  }
  recover(input: unknown): Promise<CommandResult> {
    return this.request("receipt", input);
  }
  private request(
    type: "command" | "receipt",
    input: unknown,
    worktree?: string,
    target?: ReviewExecutionTarget,
  ): Promise<CommandResult> {
    if (this.closed) return Promise.reject(new Error("Review worker closed"));
    const command = Command.parse(input);
    if (this.pending.size >= 16)
      return Promise.resolve({ commandId: command.id, ok: false, error: "review_busy" });
    const key = ++this.key;
    const message = WorkerInput.parse({
      type,
      key,
      command,
      ...(worktree ? { worktree } : {}),
      ...(target ? { target } : {}),
    });
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      try {
        this.worker.postMessage(message);
      } catch (error) {
        this.pending.delete(key);
        reject(error);
      }
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
  private retireIfIdle() {
    if (this.persistent && !this.pending.size && !this.executions.size) this.worker.idle();
  }
  private fail(error: Error) {
    this.closed = true;
    this.lifetime.abort();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    this.fail(new Error("Review worker closed"));
    if (!this.exited) {
      if (this.worker.started) this.worker.postMessage({ type: "close" });
      else void this.worker.terminate();
    }
    void Promise.all([this.exit.promise, Promise.allSettled(this.executions)]).then(
      () => completion.resolve(),
      completion.reject,
    );
    return this.closing;
  }
}
