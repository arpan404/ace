import { EventEmitter } from "node:events";
import type { Transferable, WorkerOptions } from "node:worker_threads";
import { IdleWorker, type IdleWorkerRuntime } from "@ace/provider-kit/idle-worker";
import { Reply, Envelope } from "./contracts.ts";

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
    const worker = new IdleWorker(this.entry, this.options, this.runtime);
    this.worker = worker;
    worker.on("message", (input: unknown) => {
      if (this.worker !== worker) return;
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
      this.worker = undefined;
      this.available = false;
      this.queued = [];
      this.recovering = true;
      this.emit("recovery", true);
      this.emit("error", error);
      void worker.terminate().catch(() => undefined);
      const milliseconds = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
      this.stopRetry = this.runtime.delay(() => {
        this.stopRetry = undefined;
        this.start();
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
