import type { DaemonProcess } from "./child.ts";
import type { LocalDaemon } from "./probe.ts";

/** Everything the supervisor does to the world, passed in so tests substitute it. */
export interface SupervisorPorts {
  /**
   * Start the bundled daemon. Without it (development, attached to `bun run daemon`) the
   * supervisor only waits for a daemon.
   */
  spawn?: (() => DaemonProcess) | undefined;
  /** A healthy daemon already serving this ACE_HOME, if any. */
  find(): Promise<LocalDaemon | undefined>;
  /** Whether the daemon answers its status endpoint, giving up after `timeoutMs`. */
  healthy(daemon: LocalDaemon, timeoutMs: number): Promise<boolean>;
  /** The login service from `ace service install`, when one is installed. */
  service?: { active(): Promise<boolean>; start(): Promise<void> } | undefined;
  setMaintenance(daemon: LocalDaemon, on: boolean): Promise<number>;
  blockers(daemon: LocalDaemon): Promise<number>;
  maintenance(daemon: LocalDaemon): Promise<{ draining: boolean }>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  now(): number;
  /** Every supervisor decision is logged with the facts behind it, so restarts can be explained. */
  log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
}

export interface SupervisorOptions {
  /** Pause between one health check's outcome and the next. */
  healthIntervalMs?: number;
  /**
   * How long one health check waits before it counts as missed. The status endpoint runs on
   * the daemon's event loop, so a busy daemon (a long SQLite statement, a GC pause) answers
   * slowly without being hung.
   */
  healthTimeoutMs?: number;
  /** Consecutive missed health checks before the daemon is treated as gone. */
  healthFailures?: number;
  readyTimeoutMs?: number;
  /**
   * Between SIGTERM and SIGKILL, for any stop of the daemon this app started. Longer than the
   * daemon's own shutdown overrun (7.5 s), so a daemon that can still stop cleanly does.
   */
  stopGraceMs?: number;
  /**
   * Restarts in a row (without a stable run in between) before giving up and waiting for
   * the person to try again. With the default backoff, five give up after about 15 s.
   */
  maxRestarts?: number;
  /** Running this long resets the crash count. */
  stableMs?: number;
  /**
   * How long to wait out another daemon holding this home's lock (one still starting on a
   * large database, or still shutting down) before saying so as a failure.
   */
  lockWaitMs?: number;
  /** While waiting on that lock: how long to look for the other daemon before spawning again. */
  lockRetryMs?: number;
}

export function supervisorDefaults(options: SupervisorOptions): Required<SupervisorOptions> {
  return {
    healthIntervalMs: options.healthIntervalMs ?? 5_000,
    healthTimeoutMs: options.healthTimeoutMs ?? 10_000,
    healthFailures: options.healthFailures ?? 3,
    // First start can import provider history before the endpoint is published.
    readyTimeoutMs: options.readyTimeoutMs ?? 120_000,
    stopGraceMs: options.stopGraceMs ?? 10_000,
    maxRestarts: options.maxRestarts ?? 5,
    stableMs: options.stableMs ?? 60_000,
    lockWaitMs: options.lockWaitMs ?? 300_000,
    lockRetryMs: options.lockRetryMs ?? 5_000,
  };
}
