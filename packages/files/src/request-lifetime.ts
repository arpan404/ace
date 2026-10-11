import type { FilesOptions } from "./types.ts";

/** Read preparation has its own lifetime and never occupies the mutation queue. */
export class FileRequestLifetime {
  private readonly requests = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private readonly schedule: FilesOptions["scheduleTimeout"];
  constructor(schedule: FilesOptions["scheduleTimeout"]) {
    this.schedule = schedule;
  }
  get idle(): boolean {
    return this.requests.size === 0;
  }
  run<T>(read: () => Promise<T>): Promise<T> {
    const task = read().finally(() => this.requests.delete(task));
    this.requests.add(task);
    return task;
  }
  async walk<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.controller.signal]);
    const expire = () => controller.abort();
    const stop = this.schedule
      ? this.schedule(expire, 30_000)
      : (() => {
          const timer = setTimeout(expire, 30_000);
          timer.unref();
          return () => clearTimeout(timer);
        })();
    try {
      signal.throwIfAborted();
      return await read(signal);
    } finally {
      stop();
    }
  }
  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.requests);
  }
}
