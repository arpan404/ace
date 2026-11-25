import { fork, type ChildProcess } from "node:child_process";
import type { ThreadId } from "@ace/protocol";
import { UsageWorkerReply } from "./usage-worker-wire.ts";
import { storageUsageWorkerEntry } from "./usage-scanner.ts";

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
  private readonly spawn: (entry: URL) => ChildProcess;
  /** One slot: a read that arrives while another is in flight waits instead of failing. */
  private chain: Promise<unknown> = Promise.resolve();
  constructor(root: string, spawn = start) {
    this.root = root;
    this.spawn = spawn;
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
    const result = Promise.withResolvers<number[]>();
    this.pending = {
      ...result,
      count: threads.length,
      deadline: setTimeout(() => this.retire("storage_usage_timeout"), 15 * 60_000),
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
    const worker = this.worker;
    this.worker = undefined;
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      this.reaping = new Promise((resolve) => {
        worker.once("exit", () => resolve());
        worker.once("close", () => resolve());
      });
      // A SQLite syscall need not return to JavaScript before the kernel reaps the process.
      worker.kill("SIGKILL");
    }
    this.takePending()?.reject(new Error(code));
  }
  private open(): ChildProcess {
    const worker = this.spawn(storageUsageWorkerEntry());
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
