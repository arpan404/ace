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
  private active: { cancel(): void; done: Promise<void> } | undefined;
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
    let cancelled = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (worker.connected) worker.send({ op: "cancel" }, () => {});
      // Give cooperative walks time to close. A stalled syscall or SQLite statement cannot
      // acknowledge cancellation; kill the process, which also closes its native descriptors.
      cancelTimer = setTimeout(() => result.reject(new Error("storage_usage_cancelled")), 1000);
    };
    const active = { cancel, done: released.promise };
    this.active = active;
    worker.on("error", () => result.reject(new Error("storage_usage_worker_failed")));
    worker.on("exit", () => {
      exited.resolve();
      result.reject(
        new Error(cancelled ? "storage_usage_cancelled" : "storage_usage_worker_failed"),
      );
    });
    worker.on("close", () => exited.resolve());
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
      // All paths, including malformed replies and crashes, reap the child before admission.
      try {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        await exited.promise;
      } finally {
        if (this.active === active) this.active = undefined;
        released.resolve();
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    active?.cancel();
    await active?.done;
  }
}
