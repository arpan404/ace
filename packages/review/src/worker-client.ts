import { Command, type CommandResult, type ReviewExecutionTarget } from "@ace/protocol";
import type { ReviewExecutor } from "./intents.ts";
import { ReviewIsolate, type ReviewWorkerOptions } from "./review-isolate.ts";
export type { ReviewWorkerOptions } from "./review-isolate.ts";

/** A physical isolate fault ends that generation, not the daemon's review service. */
export class ReviewWorker {
  private current: ReviewIsolate;
  private retiring: Promise<void> = Promise.resolve();
  private recovering: Promise<ReviewIsolate> | undefined;
  private faulted = false;
  private failures = 0;
  private pending = 0;
  private closed = false;
  private cancelWait: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private readonly path: string;
  private readonly executor: ReviewExecutor | undefined;
  private readonly options: ReviewWorkerOptions;
  constructor(path: string, executor?: ReviewExecutor, options: ReviewWorkerOptions = {}) {
    this.path = path;
    this.executor = executor;
    this.options = options;
    this.current = this.create();
  }
  private create(): ReviewIsolate {
    const isolate = new ReviewIsolate(this.path, this.executor, this.options, () => {
      if (this.closed || this.current !== isolate) return;
      this.faulted = true;
      this.failures++;
      // Drain the physical isolate and every executor observer before a new
      // generation can open the same database. Old completions remain fenced.
      this.retiring = isolate.close();
      void this.retiring.catch(() => {});
    });
    return isolate;
  }
  private owner(): Promise<ReviewIsolate> {
    if (this.closed) return Promise.reject(new Error("Review worker closed"));
    if (!this.faulted) return Promise.resolve(this.current);
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      await this.retiring;
      if (this.closed) throw new Error("Review worker closed");
      if (this.failures >= 3 || this.path === ":memory:")
        throw new Error("Review worker recovery exhausted");
      await new Promise<void>((resolve) => {
        const schedule =
          this.options.scheduleRecovery ??
          ((callback, milliseconds) => {
            const timer = setTimeout(callback, milliseconds);
            return () => clearTimeout(timer);
          });
        const cancel = schedule(resolve, 250 * 2 ** (this.failures - 1));
        this.cancelWait = () => {
          cancel();
          resolve();
        };
      });
      this.cancelWait = undefined;
      if (this.closed) throw new Error("Review worker closed");
      this.current = this.create();
      this.faulted = false;
      return this.current;
    })().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }
  private async request(
    input: unknown,
    run: (owner: ReviewIsolate, command: Command) => Promise<CommandResult>,
  ): Promise<CommandResult> {
    const command = Command.parse(input);
    if (this.closed) throw new Error("Review worker closed");
    if (this.pending >= 16) return { commandId: command.id, ok: false, error: "review_busy" };
    this.pending++;
    try {
      const owner = await this.owner();
      const result = await run(owner, command);
      if (owner === this.current && !this.faulted) this.failures = 0;
      return result;
    } finally {
      this.pending--;
    }
  }
  handle(
    input: unknown,
    worktree?: string,
    target?: ReviewExecutionTarget,
  ): Promise<CommandResult> {
    return this.request(input, (owner, command) => owner.handle(command, worktree, target));
  }
  recover(input: unknown): Promise<CommandResult> {
    return this.request(input, (owner, command) => owner.recover(command));
  }
  async afterFix(sessionId: string, requestId: string): Promise<CommandResult> {
    return this.request(
      {
        id: `${requestId}:review-source`,
        deviceId: "review-engine",
        payload: { type: "review.list", sessionId, limit: 1 },
      },
      (owner) => owner.afterFix(sessionId, requestId),
    );
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.cancelWait?.();
    this.closing = Promise.allSettled([this.retiring, this.recovering, this.current.close()]).then(
      (results) => {
        const failure = results.find(
          (result) =>
            result.status === "rejected" &&
            !(result.reason instanceof Error && result.reason.message === "Review worker closed"),
        );
        if (failure?.status === "rejected") throw failure.reason;
      },
    );
    return this.closing;
  }
}
