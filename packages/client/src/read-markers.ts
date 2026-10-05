import type { CommandResult } from "@ace/protocol";
import type { ThreadMarkReadInput } from "./long-thread.ts";
import { ClientError, type RequestOptions, type Scheduler } from "./types.ts";

interface Waiter {
  seq: number;
  resolve(result: CommandResult): void;
  reject(error: unknown): void;
  cleanup(): void;
}
interface Batch {
  waiters: Set<Waiter>;
  cancel(): void;
}

/** Coalesced ephemeral read cursors. Only the latest cursor is retried after reconnect. */
export class ReadMarkers {
  private pending = new Map<string, Batch>();
  private count = 0;
  private retry = new Map<string, number>();
  private closed = false;
  private scheduler: Scheduler;
  private limit: number;
  private timeout: number;
  private send: (input: ThreadMarkReadInput) => Promise<CommandResult>;
  constructor(
    scheduler: Scheduler,
    limit: number,
    timeout: number,
    send: (input: ThreadMarkReadInput) => Promise<CommandResult>,
  ) {
    this.scheduler = scheduler;
    this.limit = limit;
    this.timeout = timeout;
    this.send = send;
  }
  mark(input: ThreadMarkReadInput, options: RequestOptions): Promise<CommandResult> {
    if (this.closed) return Promise.reject(new ClientError("offline"));
    if (options.signal?.aborted) return Promise.reject(new ClientError("aborted"));
    if (this.count >= this.limit) return Promise.reject(new ClientError("limit"));
    const timeout = options.timeoutMs ?? this.timeout;
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      return Promise.reject(new ClientError("limit"));
    return new Promise((resolve, reject) => {
      let batch = this.pending.get(input.threadId);
      if (!batch) {
        batch = { waiters: new Set(), cancel: () => {} };
        this.pending.set(input.threadId, batch);
        batch.cancel = this.scheduler.set(100, () => this.flush(input.threadId));
      }
      const owned = batch;
      const fail = (error: ClientError) => {
        if (!owned.waiters.delete(waiter)) return;
        waiter.cleanup();
        reject(error);
        if (!owned.waiters.size && this.pending.get(input.threadId) === owned) {
          owned.cancel();
          this.pending.delete(input.threadId);
        }
      };
      const abort = () => fail(new ClientError("aborted"));
      const cancelTimeout = this.scheduler.set(timeout, () => fail(new ClientError("timeout")));
      const waiter: Waiter = {
        seq: input.lastSeenSeq,
        resolve,
        reject,
        cleanup: () => {
          this.count--;
          cancelTimeout();
          options.signal?.removeEventListener("abort", abort);
        },
      };
      this.count++;
      owned.waiters.add(waiter);
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private flush(threadId: string): void {
    const batch = this.pending.get(threadId);
    if (!batch) return;
    this.pending.delete(threadId);
    let lastSeenSeq = 0;
    for (const waiter of batch.waiters) lastSeenSeq = Math.max(lastSeenSeq, waiter.seq);
    void this.send({ threadId, lastSeenSeq }).then(
      (result) => this.settle(batch, (waiter) => waiter.resolve(result)),
      (error: unknown) => {
        if (error instanceof ClientError && error.code === "offline")
          this.remember(threadId, lastSeenSeq);
        this.settle(batch, (waiter) => waiter.reject(error));
      },
    );
  }
  private settle(batch: Batch, finish: (waiter: Waiter) => void): void {
    for (const waiter of batch.waiters) {
      waiter.cleanup();
      finish(waiter);
    }
    batch.waiters.clear();
  }
  private remember(threadId: string, seq: number): void {
    if (this.closed) return;
    if (!this.retry.has(threadId) && this.retry.size >= this.limit) return;
    this.retry.set(threadId, Math.max(seq, this.retry.get(threadId) ?? 0));
  }
  reconnect(): void {
    for (const [threadId, lastSeenSeq] of this.retry) {
      this.retry.delete(threadId);
      void this.send({ threadId, lastSeenSeq }).catch((error: unknown) => {
        if (error instanceof ClientError && error.code === "offline")
          this.remember(threadId, lastSeenSeq);
      });
    }
  }
  disconnect(): void {
    for (const [threadId, batch] of this.pending) {
      for (const waiter of batch.waiters) this.remember(threadId, waiter.seq);
      batch.cancel();
      this.settle(batch, (waiter) => waiter.reject(new ClientError("offline")));
    }
    this.pending.clear();
  }
  close(): void {
    this.closed = true;
    this.retry.clear();
    this.disconnect();
  }
}
