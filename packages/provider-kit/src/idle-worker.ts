import { EventEmitter } from "node:events";
import { Worker, type WorkerOptions, type Transferable } from "node:worker_threads";

export interface IdleWorkerRuntime {
  spawn(entry: URL, options: WorkerOptions): WorkerPort;
  delay(callback: () => void, milliseconds: number): () => void;
}
export interface WorkerPort {
  on(event: "message", listener: (input: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  terminate(): Promise<number>;
}
const systemRuntime: IdleWorkerRuntime = {
  spawn: (entry, options) => new Worker(entry, options),
  delay(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Only the RPC owner can declare idle, after replies and all auxiliary work settle. */
export class IdleWorker extends EventEmitter {
  private worker: ReturnType<IdleWorkerRuntime["spawn"]> | undefined;
  private stopping: Promise<unknown> | undefined;
  private closing: Promise<number> | undefined;
  private cancelIdle: (() => void) | undefined;
  private deferred: { message: unknown; transfer: readonly Transferable[] | undefined }[] = [];
  private entry: URL;
  private options: WorkerOptions;
  private runtime: IdleWorkerRuntime;
  private idleMs: number;
  private failed = false;
  private retirementFailure: Error | undefined;
  constructor(entry: URL, options: WorkerOptions, runtime = systemRuntime, idleMs = 5000) {
    super();
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new Error("Invalid worker idle timeout");
    this.entry = entry;
    this.options = options;
    this.runtime = runtime;
    this.idleMs = idleMs;
  }
  get started(): boolean {
    // An empty retiring isolate has no work to close; terminate() still awaits its exit.
    return this.worker !== undefined || this.deferred.length > 0;
  }
  start(): void {
    if (this.closing || this.failed) throw new Error("Worker closed");
    if (this.worker || this.stopping) return;
    const worker = this.runtime.spawn(this.entry, this.options);
    this.worker = worker;
    worker.on("message", (input: unknown) => {
      if (this.worker === worker) this.emit("message", input);
    });
    worker.on("error", (error: Error) => {
      if (this.worker === worker) this.emit("error", error);
    });
    worker.on("exit", (code: number) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.failed = true;
      this.emit("exit", code);
    });
  }
  postMessage(message: unknown, transfer?: readonly Transferable[]): void {
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    this.start();
    if (this.stopping) {
      // Clients admit bounded RPCs before sending. Keep one extra slot for close.
      if (this.deferred.length >= 129) throw new Error("Worker restart queue full");
      this.deferred.push({ message, transfer });
    } else this.worker?.postMessage(message, transfer);
  }
  idle(): void {
    this.cancelIdle?.();
    if (!this.worker || this.closing) return;
    this.cancelIdle = this.runtime.delay(() => {
      this.cancelIdle = undefined;
      const worker = this.worker;
      if (!worker) return;
      this.worker = undefined;
      this.stopping = worker
        .terminate()
        .then(() => {
          this.stopping = undefined;
          if (this.closing) return;
          const deferred = this.deferred;
          this.deferred = [];
          if (!deferred.length) return;
          this.start();
          for (const call of deferred) this.worker?.postMessage(call.message, call.transfer);
        })
        .catch((error: unknown) => {
          this.failed = true;
          this.deferred = [];
          this.retirementFailure =
            error instanceof Error ? error : new Error("Worker retirement failed");
          this.emit("error", this.retirementFailure);
        });
    }, this.idleMs);
  }
  terminate(): Promise<number> {
    if (!this.closing) {
      this.cancelIdle?.();
      this.deferred = [];
      const worker = this.worker;
      this.worker = undefined;
      this.closing = (async () => {
        await this.stopping;
        if (this.retirementFailure) throw this.retirementFailure;
        const code = worker ? await worker.terminate() : 0;
        this.emit("exit", code);
        return code;
      })();
    }
    return this.closing;
  }
}
