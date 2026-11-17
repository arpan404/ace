import type { ServiceStatus } from "./startup.ts";

/** Clocks and observers for service startup, passed in so tests substitute them. */
export interface StartupRuntime {
  timeoutMs: number;
  /**
   * The whole budget for service cleanup at shutdown, shared by every service: a service
   * waiting on slow dependents stops waiting once it is spent. Below the daemon's 7 s
   * shutdown deadline, so a stuck cleanup never turns a stop into an overrun.
   */
  cleanupTimeoutMs?: number;
  /** Waits before each retry of a service that degraded; one entry per retry. */
  retryDelaysMs?: readonly number[];
  onStatus?(status: ServiceStatus): void;
  /** A service's start began (`true`) or settled (`false`), stuck calls included. */
  onAttempt?(name: string, running: boolean): void;
  schedule(name: string, expire: () => void, milliseconds: number): () => void;
  /**
   * Runs a service's own call (its start, a listener) in that service's scope, so work it leaves
   * running is charged to it if it crashes the daemon.
   */
  inService?<T>(name: string, work: () => T): T;
}

/** 30 s, 1, 2, 5 and 10 minutes: a stuck folder or CLI usually answers again within that. */
export const defaultRetryDelaysMs: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000];

export const systemStartup: StartupRuntime = {
  timeoutMs: 15_000,
  cleanupTimeoutMs: 6_000,
  retryDelaysMs: defaultRetryDelaysMs,
  schedule(_name, expire, milliseconds) {
    const timer = setTimeout(expire, milliseconds);
    // A pending retry never keeps the process alive on its own.
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export function validateRuntime(runtime: StartupRuntime): void {
  if (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs < 1)
    throw new Error("Invalid service startup deadline");
  if (
    runtime.cleanupTimeoutMs !== undefined &&
    (!Number.isFinite(runtime.cleanupTimeoutMs) || runtime.cleanupTimeoutMs < 1)
  )
    throw new Error("Invalid service cleanup deadline");
  for (const delay of runtime.retryDelaysMs ?? [])
    if (!Number.isFinite(delay) || delay < 0) throw new Error("Invalid service retry delay");
}

/** A deadline is a backstop; services start finite initialization, never their lifetime loop. */
export async function bounded<T>(
  name: string,
  run: () => T | Promise<T>,
  runtime: Pick<StartupRuntime, "schedule" | "timeoutMs">,
  signal?: AbortSignal,
  operation = "startup",
): Promise<T> {
  signal?.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal?.reason ?? new Error("Daemon startup aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = runtime.schedule(
      name,
      () => reject(new Error(`Service ${name} ${operation} exceeded ${runtime.timeoutMs}ms`)),
      runtime.timeoutMs,
    );
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return run();
      }),
      deadline,
      aborted,
    ]);
  } finally {
    cancel?.();
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** Settles when `promise` does or once `budget` is spent, whichever is first. */
export function within(
  promise: Promise<unknown>,
  budget: Promise<void>,
): Promise<"done" | "spent"> {
  return Promise.race([
    promise.then(
      () => "done" as const,
      () => "done" as const,
    ),
    budget.then(() => "spent" as const),
  ]);
}
