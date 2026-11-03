import { execFile } from "node:child_process";
import { uptime } from "node:os";

/**
 * Monotonic time, a repeating timer and the system's sleep record, injected so tests drive drift
 * and suspension without sleeping.
 */
export interface LoopClock {
  /** Milliseconds on a monotonic clock that keeps counting while the system is suspended. */
  now(): number;
  every(milliseconds: number, tick: () => void): () => void;
  /**
   * Total milliseconds the system has spent suspended, from any fixed origin, or `undefined` when
   * the platform can't say. Read only after a late tick, so it may be slow.
   */
  suspendedMs(): Promise<number | undefined>;
}
export interface LoopStatus {
  /** How late the most recent tick ran while the system was awake, in milliseconds. */
  delayMs: number;
  /** The longest delay since the daemon started. */
  maxDelayMs: number;
  /** Ticks that ran at least `stallMs` late. */
  stalls: number;
}
export interface LoopStall {
  delayMs: number;
  /** Stalls since the previous stall record that were not logged on their own. */
  suppressed: number;
}
export interface LoopSuspension {
  /** How long the system was asleep before the late tick. */
  suspendedMs: number;
  /** Suspensions since the previous record that were not logged on their own. */
  suppressed: number;
}
export interface LoopMonitorOptions {
  clock: LoopClock;
  onStall(stall: LoopStall): void;
  /** The system slept (lid closed, idle sleep, DarkWake cycles); not a stall. */
  onSuspend?(suspension: LoopSuspension): void;
  intervalMs?: number;
  stallMs?: number;
  /** At most one stall record per window, so a busy loop cannot flood the log. */
  logWindowMs?: number;
  /** At most one suspension record per window; a sleeping Mac wakes briefly about once a minute. */
  suspendLogWindowMs?: number;
}

function rateLimited<T extends object>(
  windowMs: number,
  emit: (record: T & { suppressed: number }) => void,
) {
  let loggedAt: number | undefined;
  let suppressed = 0;
  return (now: number, record: T) => {
    if (loggedAt !== undefined && now - loggedAt < windowMs) {
      suppressed++;
      return;
    }
    loggedAt = now;
    const counted = { ...record, suppressed };
    suppressed = 0;
    emit(counted);
  };
}

/**
 * Measures event-loop stalls by timer drift: a tick that runs late means the loop was busy, unless
 * the system was asleep for that time. A watchdog reading `status()` can tell a busy daemon (large
 * delays, still answering) from a hung one (no answer at all).
 *
 * A late tick is checked against the system's sleep record before it counts. Only sleep not yet
 * attributed to an earlier gap is subtracted, never more than the gap itself; the rest is left for
 * the next gap. The record is read just after the tick, so a sleep that starts in those few
 * milliseconds is credited to the gap before it and can hide that one stall.
 */
export function createLoopMonitor({
  clock,
  onStall,
  onSuspend,
  intervalMs = 500,
  stallMs = 1000,
  logWindowMs = 60_000,
  suspendLogWindowMs = 600_000,
}: LoopMonitorOptions) {
  let expected = clock.now() + intervalMs;
  let delayMs = 0;
  let maxDelayMs = 0;
  let stalls = 0;
  let ticks = 0;
  let latestRecorded = 0;
  let closed = false;
  const stall = rateLimited<{ delayMs: number }>(logWindowMs, onStall);
  const suspend = rateLimited<{ suspendedMs: number }>(suspendLogWindowMs, (record) =>
    onSuspend?.(record),
  );
  /** Suspended time already subtracted from earlier gaps, on the clock's own origin. */
  let attributed: number | undefined;
  const readSuspended = () => clock.suspendedMs().catch(() => undefined);
  // Checks run in order, so each one sees the sleep the previous one attributed.
  let checks: Promise<void> = readSuspended().then((total) => {
    attributed = total;
  });

  const record = (tick: number, delay: number, now: number) => {
    // A late tick's check can finish after newer ticks; it must not hide their delay.
    if (tick >= latestRecorded) {
      latestRecorded = tick;
      delayMs = delay;
    }
    maxDelayMs = Math.max(maxDelayMs, delay);
    if (delay < stallMs) return;
    stalls++;
    stall(now, { delayMs: delay });
  };

  const classify = (tick: number, gapMs: number, now: number, total: number | undefined) => {
    if (closed) return;
    let suspendedMs = 0;
    if (total !== undefined && attributed !== undefined) {
      suspendedMs = Math.min(gapMs, Math.max(0, total - attributed));
      attributed += suspendedMs;
    } else if (total !== undefined) attributed = total;
    if (suspendedMs >= stallMs) suspend(now, { suspendedMs: Math.round(suspendedMs) });
    record(tick, Math.max(0, Math.round(gapMs - suspendedMs)), now);
  };

  const stop = clock.every(intervalMs, () => {
    const now = clock.now();
    const tick = ++ticks;
    const gapMs = Math.max(0, now - expected);
    expected = now + intervalMs;
    if (gapMs < stallMs) {
      record(tick, Math.round(gapMs), now);
      return;
    }
    checks = checks.then(readSuspended).then((total) => classify(tick, gapMs, now, total));
  });
  return {
    status: (): LoopStatus => ({ delayMs, maxDelayMs, stalls }),
    close() {
      closed = true;
      stop();
    },
  };
}

/**
 * Reads macOS's sleep total from `sysctl -n kern.monotonicclock_usecs hw.tbfrequency`. The first
 * line pairs a monotonic clock that runs through sleep (microseconds) with `mach_absolute_time`,
 * which stops during sleep; the second is the `mach_absolute_time` ticks per second. Their
 * difference only grows while the system sleeps; xnu measures sleep the same way.
 */
export function parseDarwinSuspendedMs(output: string): number | undefined {
  const [pair, frequency] = output.trim().split(/\r?\n/);
  const [monotonicUs, machTime] = (pair ?? "").trim().split(/\s+/).map(Number);
  const ticksPerSecond = Number(frequency);
  if (
    monotonicUs === undefined ||
    machTime === undefined ||
    !Number.isFinite(monotonicUs) ||
    !Number.isFinite(machTime) ||
    !Number.isFinite(ticksPerSecond) ||
    ticksPerSecond <= 0
  )
    return undefined;
  return monotonicUs / 1000 - (machTime / ticksPerSecond) * 1000;
}

function darwinSuspendedMs(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/sysctl",
      ["-n", "kern.monotonicclock_usecs", "hw.tbfrequency"],
      { timeout: 5_000 },
      (error, stdout) => resolve(error ? undefined : parseDarwinSuspendedMs(stdout)),
    );
  });
}

function every(milliseconds: number, tick: () => void): () => void {
  const timer = setInterval(tick, milliseconds);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The daemon's loop clock. `performance.now()` comes from libuv's `uv_hrtime`:
 * - macOS reads `mach_continuous_time`, which counts sleep. `mach_absolute_time` doesn't, and Node
 *   has no binding for it, so sleep is read from sysctl after a late tick.
 * - Linux reads `CLOCK_MONOTONIC` and Windows `QueryPerformanceCounter`, which don't promise to
 *   count sleep. `os.uptime()` does there (Linux `/proc/uptime`, i.e. `CLOCK_BOOTTIME`; Windows
 *   `GetTickCount64`), so it is the clock and the difference between the two is the sleep total.
 *   Both have 10–16 ms resolution, far below the one-second stall threshold.
 */
export function systemLoopClock(platform: NodeJS.Platform): LoopClock {
  if (platform === "darwin")
    return { now: () => performance.now(), every, suspendedMs: darwinSuspendedMs };
  return {
    now: () => uptime() * 1000,
    every,
    suspendedMs: async () => uptime() * 1000 - performance.now(),
  };
}
