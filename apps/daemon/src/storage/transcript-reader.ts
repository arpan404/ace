import { fork, type ChildProcess } from "node:child_process";
import type { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { UsageWorkerReply } from "./usage-worker-wire.ts";
import { storageUsageWorkerEntry } from "./usage-scanner.ts";

/**
 * Bounds for one measurement. A batch scales with its thread count because the worker reports
 * no progress between the request and its single reply; a fenced recheck stays short so a
 * stalled worker cannot hold the storage serializer.
 */
export const TranscriptLimits = z.object({
  recheckMs: z.number().int().positive().max(60_000).default(3_000),
  batchMs: z.number().int().positive().max(300_000).default(5_000),
  perThreadMs: z.number().int().positive().max(10_000).default(100),
  reapMs: z.number().int().positive().max(60_000).default(2_000),
});

export interface TranscriptReaderOptions {
  limits?: Partial<z.infer<typeof TranscriptLimits>>;
  /** Process boundary injection for crash, failed-start and stalled-worker tests. */
  spawn?(entry: URL): ChildProcess;
}

interface PendingRead {
  count: number;
  resolve(bytes: number[]): void;
  reject(error: Error): void;
  deadline: ReturnType<typeof setTimeout>;
}

/** One read-only process per cleanup, reused for the final measurement of each fenced thread. */
export class TranscriptReader {
  private worker: ChildProcess | undefined;
  private pending: PendingRead | undefined;
  private reaping: Promise<void> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly root: string;
  private readonly options: TranscriptReaderOptions;
  /** One slot: a read that arrives while another is in flight waits instead of failing. */
  private chain: Promise<unknown> = Promise.resolve();
  constructor(root: string, options: TranscriptReaderOptions = {}) {
    this.root = root;
    this.options = options;
  }
  read(threads: readonly ThreadId[]): Promise<number[]> {
    const run = this.chain.then(() => this.measure(threads));
    this.chain = run.catch(() => {});
    return run;
  }
  private async measure(threads: readonly ThreadId[]): Promise<number[]> {
    await this.reaping;
    if (this.stopped) throw new Error("storage_usage_cancelled");
    if (!threads.length) return [];
    clearTimeout(this.idle);
    const worker = (this.worker ??= this.open());
    const limits = TranscriptLimits.parse(this.options.limits ?? {});
    const budget =
      threads.length === 1
        ? limits.recheckMs
        : limits.batchMs + threads.length * limits.perThreadMs;
    const result = Promise.withResolvers<number[]>();
    this.pending = {
      ...result,
      count: threads.length,
      deadline: setTimeout(() => this.retire("storage_usage_timeout"), budget),
    };
    try {
      worker.send({ op: "transcripts", root: this.root, threads }, (error) => {
        if (error && this.worker === worker) this.retire("storage_usage_worker_failed");
      });
    } catch {
      this.retire("storage_usage_worker_failed");
    }
    return result.promise;
  }
  stop(): void {
    this.stopped = true;
    this.retire("storage_usage_cancelled");
  }
  async closed(): Promise<void> {
    // Stopping rejects every queued read, so draining the chain cannot wait on a new worker.
    await this.chain;
    await this.reaping;
  }
  private takePending(): PendingRead | undefined {
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending?.deadline);
    return pending;
  }
  private retire(code: string): void {
    clearTimeout(this.idle);
    this.idle = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker && worker.exitCode === null && worker.signalCode === null) this.reap(worker);
    this.takePending()?.reject(new Error(code));
  }
  /**
   * Bounds how long a caller waits for a killed worker. The slot stays occupied until the
   * process itself reports exit: a SQLite syscall need not return before the kernel reaps it.
   */
  private reap(worker: ChildProcess): void {
    const limits = TranscriptLimits.parse(this.options.limits ?? {});
    const released = Promise.withResolvers<void>();
    // close() may never be called. Keep the rejection observed without changing its meaning.
    void released.promise.catch(() => {});
    this.reaping = released.promise;
    let observed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observeExit = () => {
      if (observed) return;
      observed = true;
      clearTimeout(timer);
      if (this.reaping === released.promise) this.reaping = undefined;
      released.resolve();
    };
    worker.once("exit", observeExit);
    worker.once("close", () => {
      // A spawn that never started has no process to reap; closing its pipes is its exit.
      if (worker.pid === undefined) observeExit();
    });
    timer = setTimeout(
      () => released.reject(new Error("storage_usage_cleanup_timeout")),
      limits.reapMs,
    );
    try {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    } catch {
      // Kill failure is not proof of exit. The cleanup deadline above still applies.
    }
  }
  private open(): ChildProcess {
    const worker = (this.options.spawn ?? start)(storageUsageWorkerEntry());
    const failed = () => {
      if (this.worker === worker) this.retire("storage_usage_worker_failed");
    };
    worker.once("error", failed);
    worker.once("exit", failed);
    worker.once("disconnect", failed);
    worker.on("message", (input: unknown) => {
      if (this.worker !== worker) return;
      const reply = UsageWorkerReply.safeParse(input);
      const pending = this.pending;
      if (
        !pending ||
        !reply.success ||
        reply.data.kind !== "transcripts" ||
        reply.data.bytes.length !== pending.count
      ) {
        this.retire("storage_usage_failed");
        return;
      }
      this.takePending();
      this.idle = setTimeout(() => this.retire("storage_usage_worker_idle"), 5000);
      this.idle.unref();
      pending.resolve(reply.data.bytes);
    });
    return worker;
  }
}

function start(entry: URL): ChildProcess {
  return fork(entry, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
}
