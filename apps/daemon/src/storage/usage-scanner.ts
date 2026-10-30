import { fork, type ChildProcess } from "node:child_process";
import type { StorageUsage } from "@ace/protocol";
import type { z } from "zod";
import { UsageLimits, UsageWorkerReply } from "./usage-worker-wire.ts";

export interface UsageScannerOptions {
  limits?: Partial<z.infer<typeof UsageLimits>>;
  /** Process boundary injection for crash, failed-start and stalled-worker tests. */
  spawn?(entry: URL): ChildProcess;
}

/** One read-only process per scan. Kernel-owned descriptors die with a crashed worker. */
export class UsageScanner {
  private root: string;
  private options: UsageScannerOptions;
  private active: { cancel(): void; done: Promise<void>; exited: Promise<void> } | undefined;
  private closed = false;
  constructor(root: string, options: UsageScannerOptions = {}) {
    this.root = root;
    this.options = options;
  }
  async scan(signal?: AbortSignal): Promise<StorageUsage> {
    if (this.closed) throw new Error("storage_closed");
    if (this.active) throw new Error("storage_busy");
    signal?.throwIfAborted();
    const limits = UsageLimits.parse(this.options.limits ?? {});
    const entry = new URL("./usage-worker.ts", import.meta.url);
    const worker =
      this.options.spawn?.(entry) ??
      fork(entry, [], {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    const result = Promise.withResolvers<StorageUsage>();
    const exited = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    // close() may never be called. Keep the rejection observed without changing what
    // a later close caller receives from the original promise.
    void released.promise.catch(() => {});
    let observedExit = false;
    let cleanupFinished = false;
    let cancelled = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      try {
        if (worker.connected) worker.send({ op: "cancel" }, () => {});
      } catch {
        // The IPC channel can close between the connected check and send. Cancellation
        // still owns its deadline and reaps the child below.
      }
      // Give cooperative walks time to close. A stalled syscall or SQLite statement cannot
      // acknowledge cancellation; kill the process, which also closes its native descriptors.
      cancelTimer = setTimeout(() => result.reject(new Error("storage_usage_cancelled")), 1000);
    };
    const active = { cancel, done: released.promise, exited: exited.promise };
    this.active = active;
    worker.on("error", () => result.reject(new Error("storage_usage_worker_failed")));
    const observeExit = () => {
      observedExit = true;
      exited.resolve();
      if (cleanupFinished) release();
    };
    const release = () => {
      if (this.active === active) this.active = undefined;
      released.resolve();
    };
    worker.on("exit", () => {
      observeExit();
      result.reject(
        new Error(cancelled ? "storage_usage_cancelled" : "storage_usage_worker_failed"),
      );
    });
    worker.on("close", () => {
      // Failed spawn has no exit event and no process to reap. A started child must
      // provide exit evidence; closing its IPC/stdio alone does not release its slot.
      if (worker.pid === undefined) observeExit();
    });
    worker.on("message", (input: unknown) => {
      const reply = UsageWorkerReply.safeParse(input);
      if (cancelled) result.reject(new Error("storage_usage_cancelled"));
      else if (!reply.success || reply.data.kind === "error")
        result.reject(new Error("storage_usage_failed"));
      else result.resolve(reply.data.usage);
    });
    const timer = setTimeout(
      () => result.reject(new Error("storage_usage_timeout")),
      limits.maxMs + 5000,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      try {
        worker.send({ op: "scan", root: this.root, limits }, (error) => {
          if (error) result.reject(new Error("storage_usage_worker_failed"));
        });
        if (signal?.aborted) cancel();
      } catch {
        result.reject(new Error("storage_usage_worker_failed"));
      }
      return await result.promise;
    } finally {
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      signal?.removeEventListener("abort", cancel);
      // Bound the caller's wait, but keep ownership until actual exit evidence arrives.
      // A timed-out cleanup cannot admit a replacement worker or make close() succeed.
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          reapTimer = setTimeout(() => reject(new Error("storage_usage_cleanup_timeout")), 2000);
          void exited.promise.then(resolve);
          try {
            if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
          } catch {
            // Kill failure is not proof of exit. The same cleanup deadline applies.
          }
        });
        cleanupFinished = true;
        release();
      } catch (error) {
        cleanupFinished = true;
        if (observedExit) release();
        else released.reject(error);
        // oxlint-disable-next-line eslint/no-unsafe-finally -- Cleanup failure must replace the scan result.
        throw error;
      } finally {
        clearTimeout(reapTimer);
      }
    }
  }
  /** Actual exit evidence for mutation admission, independent of scan/reap deadlines. */
  waitForIdle(): Promise<void> {
    return this.active?.exited ?? Promise.resolve();
  }
  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    active?.cancel();
    await active?.done;
  }
}
