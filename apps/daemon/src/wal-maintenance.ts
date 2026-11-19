import { statSync } from "node:fs";
import type { BufferScheduler } from "./live-write-buffer.ts";
import { CheckpointReply, type CheckpointMode } from "./wal-checkpoint-protocol.ts";
import type { CheckpointWorker, CheckpointWorkerFactory } from "./wal-worker-runtime.ts";

/** While commits keep coming, the WAL is copied back this often, so it stays small. */
const passiveMs = 1000;
/** Quiet ticks before the WAL file is truncated. */
const quietTicks = 5;

/**
 * The store's connection runs with `wal_autocheckpoint=0`: a checkpoint's copy and fsync would
 * otherwise run inside whichever COMMIT crosses the threshold, on the event loop. Instead a
 * worker connection checkpoints PASSIVE once a second while commits continue, then TRUNCATE
 * after five quiet seconds. Checkpoints never change what is committed: the WAL is as durable
 * as the database file, and a crash at any point recovers from it. If the worker fails, the
 * checkpoint runs on the store's connection as it did before, so the WAL stays bounded.
 */
export class WalMaintenance {
  private cancel: (() => void) | undefined;
  private dirty = false;
  private quiet = 0;
  private worker: CheckpointWorker | undefined;
  private inFlight: { id: number; mode: CheckpointMode } | undefined;
  private nextId = 0;
  private failing = false;
  private closed = false;
  constructor(privateOptions: {
    path: string;
    scheduler: BufferScheduler;
    /** A worker for the same file; undefined checkpoints on the store's connection. */
    worker: CheckpointWorkerFactory | undefined;
    busy(): boolean;
    /** Checkpoint on the store's connection without waiting for locks; false if blocked. */
    checkpoint(mode: CheckpointMode): boolean;
    report(error: unknown): void;
  }) {
    this.options = privateOptions;
  }
  private readonly options;
  bytes(): number {
    try {
      return statSync(`${this.options.path}-wal`).size;
    } catch {
      return 0;
    }
  }
  /** A transaction committed. */
  wake(): void {
    this.dirty = true;
    this.quiet = 0;
    this.arm();
  }
  private arm(): void {
    if (this.cancel || this.closed) return;
    this.cancel = this.options.scheduler.delay(() => {
      this.cancel = undefined;
      this.tick();
    }, passiveMs);
  }
  private tick(): void {
    if (this.dirty) {
      if (this.request("PASSIVE")) this.dirty = false;
      this.arm();
      return;
    }
    if (++this.quiet < quietTicks || this.options.busy() || !this.request("TRUNCATE")) {
      this.arm();
      return;
    }
    // Truncated: no timer until the next commit.
    this.quiet = 0;
  }
  /** Returns false when the request must be retried on a later tick. */
  private request(mode: CheckpointMode): boolean {
    if (this.inFlight) return false;
    const worker = this.connect();
    if (!worker) {
      this.checkpointHere(mode);
      return true;
    }
    const id = ++this.nextId;
    this.inFlight = { id, mode };
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker.
      worker.postMessage({ id, mode });
    } catch (error) {
      this.inFlight = undefined;
      this.fallBack(mode, error);
    }
    return true;
  }
  private connect(): CheckpointWorker | undefined {
    if (this.worker || !this.options.worker) return this.worker;
    let worker: CheckpointWorker;
    try {
      worker = this.options.worker(this.options.path);
    } catch (error) {
      this.options.report(error);
      return undefined;
    }
    worker.on("message", (input) => this.reply(input));
    worker.on("error", (error) => this.lost(error));
    worker.on("exit", () => this.lost(new Error("WAL checkpoint worker exited")));
    this.worker = worker;
    return worker;
  }
  private reply(input: unknown): void {
    const reply = CheckpointReply.safeParse(input);
    const pending = this.inFlight;
    if (!reply.success || !pending || reply.data.id !== pending.id) return;
    this.inFlight = undefined;
    this.worker?.idle?.();
    if (reply.data.ok) {
      this.failing = false;
      // A checkpoint blocked by a reader or writer copies the rest on a later tick.
      if (reply.data.busy) this.retry(pending.mode);
      return;
    }
    if (reply.data.busy) this.retry(pending.mode);
    else this.fallBack(pending.mode, new Error(reply.data.error));
  }
  /** The worker died or failed to start: run its checkpoint here. IdleWorker restarts it. */
  private lost(error: Error): void {
    const pending = this.inFlight;
    this.inFlight = undefined;
    if (pending && !this.closed) this.fallBack(pending.mode, error);
  }
  private retry(mode: CheckpointMode): void {
    if (mode === "PASSIVE") this.dirty = true;
    this.arm();
  }
  private fallBack(mode: CheckpointMode, error: unknown): void {
    // One report per outage, not one per second.
    if (!this.failing) this.options.report(error);
    this.failing = true;
    this.checkpointHere(mode);
  }
  private checkpointHere(mode: CheckpointMode): void {
    if (mode === "TRUNCATE" && this.options.busy()) {
      this.arm();
      return;
    }
    try {
      if (!this.options.checkpoint(mode)) this.retry(mode);
    } catch (error) {
      this.options.report(error);
    }
  }
  /** Stop scheduling. Synchronous, for shutdown's first pass. */
  stop(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
  }
  /** Join the worker. Its connection closes last and empties the WAL, as a lone one would. */
  async close(): Promise<void> {
    this.stop();
    const worker = this.worker;
    this.worker = undefined;
    this.inFlight = undefined;
    if (worker) await worker.terminate();
  }
}
