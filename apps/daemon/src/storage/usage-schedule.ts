import { StorageUsage } from "@ace/protocol";
import { UsageCache, USAGE_INTERVAL } from "./usage-cache.ts";
import type { StorageSchedule } from "./schedule.ts";

export interface UsageScannerPort {
  scan(signal?: AbortSignal): Promise<StorageUsage>;
  close(): Promise<void>;
}
export type Activity = { cpu: number | null; disk: number | null };
export type UsageRuntime = {
  now(): number;
  schedule: StorageSchedule;
  activity(signal: AbortSignal): Promise<Activity>;
  failed(error: unknown): void;
};
/** Unknown activity is not idle. Disk is aggregate bytes/sec, CPU is a busy fraction. */
export function usageIdle(activity: Activity): boolean {
  return (
    activity.cpu !== null &&
    Number.isFinite(activity.cpu) &&
    activity.cpu >= 0 &&
    activity.cpu <= 0.2 &&
    activity.disk !== null &&
    Number.isFinite(activity.disk) &&
    activity.disk >= 0 &&
    activity.disk <= 1024 * 1024
  );
}

export class UsageCoordinator {
  private cache: UsageCache;
  private scanner: UsageScannerPort;
  private runtime: UsageRuntime;
  private snapshot: StorageUsage | undefined;
  private due: number;
  private generation = 0;
  private mutations = 0;
  private releaseMutation: (() => void) | undefined;
  private mutationDone: Promise<void> = Promise.resolve();
  private flight: Promise<StorageUsage> | undefined;
  private controller: AbortController | undefined;
  private probe: AbortController | undefined;
  private cancel: (() => void) | undefined;
  private closed = false;
  private started = false;
  private closing: Promise<void> | undefined;
  constructor(cache: UsageCache, scanner: UsageScannerPort, runtime: UsageRuntime) {
    this.cache = cache;
    this.scanner = scanner;
    this.runtime = runtime;
    const loaded = cache.load(runtime.now());
    this.snapshot = loaded.usage;
    this.due = loaded.due;
  }
  start(): void {
    this.started = true;
    this.next();
  }
  read(force = false): Promise<StorageUsage> {
    if (this.closed) return Promise.reject(new Error("storage_closed"));
    if (!force && this.snapshot) return Promise.resolve(this.snapshot);
    return this.refresh();
  }
  /** Invalidate before asynchronous effects, even if an effect later fails part way through. */
  async mutation<T>(run: () => Promise<T>): Promise<T> {
    if (this.mutations++ === 0)
      this.mutationDone = new Promise((resolve) => {
        this.releaseMutation = resolve;
      });
    this.generation++;
    this.controller?.abort();
    this.due = this.runtime.now();
    try {
      this.cache.save(this.snapshot, this.due);
      return await run();
    } finally {
      if (--this.mutations === 0) {
        this.releaseMutation?.();
        this.releaseMutation = undefined;
      }
      this.next();
    }
  }
  private refresh(): Promise<StorageUsage> {
    if (this.flight) return this.flight;
    this.cancel?.();
    this.probe?.abort();
    let failed = false;
    const task = this.scanCurrent()
      .catch((error: unknown) => {
        failed = true;
        throw error;
      })
      .finally(() => {
        this.flight = undefined;
        this.controller = undefined;
        this.next(failed ? 5 * 60000 : undefined);
      });
    this.flight = task;
    return task;
  }
  private async scanCurrent(): Promise<StorageUsage> {
    while (!this.closed) {
      await this.mutationDone;
      if (this.closed) break;
      if (this.mutations) continue;
      const generation = this.generation;
      const controller = new AbortController();
      this.controller = controller;
      const cancelTimeout = this.runtime.schedule(10 * 60 * 1000, () => controller.abort());
      try {
        const usage = StorageUsage.parse(await this.scanner.scan(controller.signal));
        if (this.closed) break;
        if (generation !== this.generation) continue;
        if (controller.signal.aborted) throw new Error("storage_scan_cancelled");
        const due = this.runtime.now() + USAGE_INTERVAL;
        this.cache.save(usage, due);
        this.snapshot = usage;
        this.due = due;
        return usage;
      } catch (error) {
        if (!this.closed && generation !== this.generation) continue;
        // Keep the last valid snapshot and retry later, without moving the durable due date.
        throw error;
      } finally {
        cancelTimeout();
      }
    }
    throw new Error("storage_closed");
  }
  private next(delay?: number): void {
    this.cancel?.();
    if (!this.started || this.closed || this.flight || this.mutations) return;
    this.cancel = this.runtime.schedule(delay ?? Math.max(1, this.due - this.runtime.now()), () => {
      this.cancel = undefined;
      void this.automatic();
    });
  }
  private async automatic(): Promise<void> {
    if (this.closed || this.flight || this.mutations) return;
    const controller = new AbortController();
    this.probe = controller;
    let retry = 60000;
    try {
      const activity = await this.runtime.activity(controller.signal);
      if (this.closed || controller.signal.aborted || this.flight || this.mutations) return;
      if (usageIdle(activity)) {
        if (this.probe === controller) this.probe = undefined;
        await this.refresh();
      } else retry = activity.disk === null || activity.cpu === null ? 15 * 60000 : 60000;
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) this.runtime.failed(error);
      retry = 5 * 60000;
    } finally {
      if (this.probe === controller) this.probe = undefined;
      if (!this.closed && !this.flight)
        this.next(this.due > this.runtime.now() ? undefined : retry);
    }
  }
  stop(): void {
    this.closed = true;
    this.generation++;
    this.cancel?.();
    this.probe?.abort();
    this.controller?.abort();
  }
  close(): Promise<void> {
    this.stop();
    return (this.closing ??= new Promise<void>((resolve, reject) => {
      const cancel = this.runtime.schedule(5000, () =>
        reject(new Error("storage_usage_shutdown_timeout")),
      );
      Promise.all([this.scanner.close(), this.flight?.catch(() => {})]).then(
        () => {
          cancel();
          resolve();
        },
        (error: unknown) => {
          cancel();
          reject(error);
        },
      );
    }));
  }
}
