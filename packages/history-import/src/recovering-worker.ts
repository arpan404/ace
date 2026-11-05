import { EventEmitter } from "node:events";
import type { Transferable, WorkerOptions } from "node:worker_threads";
import { IdleWorker, type IdleWorkerRuntime } from "@ace/provider-kit/idle-worker";
import { incompatibleData, revivedIncompatibleData } from "@ace/provider-kit/incompatible-data";
import { Reply, Envelope, Refusal } from "./contracts.ts";
import { readerMemoryLimitCode } from "./reader-process.ts";

/** A crashed isolate releases its heap; retries keep the durable catalog and bounded RPC queue. */
export class RecoveringWorker extends EventEmitter {
  private worker: IdleWorker | undefined;
  private stopRetry: (() => void) | undefined;
  private closing = false;
  private attempt = 0;
  private scanId: number | undefined;
  private initialized = false;
  private available = false;
  private recovering = false;
  private queued: { message: unknown; transfer: readonly Transferable[] | undefined }[] = [];
  private entry: URL;
  private options: WorkerOptions;
  private runtime: IdleWorkerRuntime;
  /** How the previous reader ended, for the next one's crash ledger. */
  private lastExit: "crash" | "memory-limit" | undefined;
  constructor(entry: URL, options: WorkerOptions, runtime: IdleWorkerRuntime) {
    super();
    this.entry = entry;
    this.options = options;
    this.runtime = runtime;
  }
  get started() {
    return this.worker?.started ?? false;
  }
  start(): void {
    if (this.closing || this.worker) return;
    const worker = new IdleWorker(
      this.entry,
      { ...this.options, workerData: withLastExit(this.options.workerData, this.lastExit) },
      this.runtime,
    );
    this.worker = worker;
    worker.on("message", (input: unknown) => {
      if (this.worker !== worker) return;
      const refusal = Refusal.safeParse(input).data;
      if (refusal) {
        failed(revivedIncompatibleData(refusal.refused));
        return;
      }
      const reply = Reply.safeParse(input).data;
      if (reply?.id === 0) {
        this.available = true;
        if (!this.initialized) {
          this.initialized = true;
          this.emit("message", input);
        }
        const queued = this.queued;
        this.queued = [];
        for (const call of queued) worker.postMessage(call.message, call.transfer);
        if (this.recovering) {
          this.recovering = false;
          this.emit("recovery", false);
        }
        return;
      }
      if (reply?.id === this.scanId && !reply?.error) this.attempt = 0;
      this.emit("message", input);
    });
    const failed = (error: Error) => {
      if (this.worker !== worker || this.closing) return;
      if (incompatibleData(error)) {
        // Every restart would refuse the same index; report it once and stay stopped.
        this.worker = undefined;
        this.closing = true;
        this.queued = [];
        this.emit("fatal", error);
        void worker.terminate().catch(() => undefined);
        return;
      }
      this.worker = undefined;
      this.available = false;
      this.queued = [];
      this.recovering = true;
      // A watchdog kill strikes on process-wide memory, so the next reader can't tell from its
      // marks alone which source was the cause (crash-ledger.ts).
      this.lastExit = readerMemoryLimit(error) ? "memory-limit" : "crash";
      this.emit("recovery", true);
      this.emit("error", error);
      // The replacement starts only once this reader has gone (on Windows a stop is not
      // immediate), so two never run over the same index.
      const gone = worker.terminate().catch(() => undefined);
      const milliseconds = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
      this.stopRetry = this.runtime.delay(() => {
        this.stopRetry = undefined;
        void gone.then(() => this.start());
      }, milliseconds);
    };
    worker.on("error", failed);
    worker.on("exit", () => failed(new Error("Saved conversations are restarting")));
    try {
      worker.start();
    } catch (error) {
      failed(error instanceof Error ? error : new Error("Saved conversations could not start"));
    }
  }
  postMessage(message: unknown, transfer?: readonly Transferable[]): void {
    if (this.closing) throw new Error("History worker closed");
    const request = Envelope.safeParse(message).data;
    if (request?.request.op === "scan") this.scanId = request.id;
    if (this.available && this.worker) this.worker.postMessage(message, transfer);
    else {
      if (this.queued.length >= 129) throw new Error("Too many saved conversation requests");
      this.queued.push({ message, transfer });
    }
  }
  idle(): void {
    this.worker?.idle();
  }
  async terminate(): Promise<number> {
    this.closing = true;
    this.stopRetry?.();
    this.queued = [];
    const worker = this.worker;
    this.worker = undefined;
    return worker ? worker.terminate() : 0;
  }
}

function readerMemoryLimit(error: Error): boolean {
  return "code" in error && error.code === readerMemoryLimitCode;
}

/** The reader's options, telling it how the reader before it ended. */
function withLastExit(data: unknown, lastExit: "crash" | "memory-limit" | undefined): unknown {
  if (lastExit === undefined || typeof data !== "object" || data === null) return data;
  return { ...data, lastExit };
}
