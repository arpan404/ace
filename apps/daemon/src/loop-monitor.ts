import { execFile } from "node:child_process";

/** One system sleep, placed on the loop clock's timeline. */
export interface LoopSleep {
  from: number;
  to: number;
}

/**
 * Monotonic time, a repeating timer and the system's sleep record, injected so tests drive drift
 * and suspension without sleeping.
 */
export interface LoopClock {
  now(): number;
  every(milliseconds: number, tick: () => void): () => void;
  /**
   * The system's most recent sleep, on `now()`'s timeline, or `undefined` when `now()` doesn't
   * count sleep or the platform can't say. Read only after a late tick, so it may be slow; the
   * signal aborts it when the monitor closes.
   */
  lastSleep(signal: AbortSignal): Promise<LoopSleep | undefined>;
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

/** A tick that ran late, waiting to learn whether the system slept between `from` and `to`. */
interface LateTick {
  tick: number;
  from: number;
  to: number;
  gapMs: number;
}

/** How much of `sleep` falls between two ticks. Ticks run while awake, so a sleep is inside or out. */
function sleptWithin(late: LateTick, sleep: LoopSleep | undefined): number {
  if (sleep === undefined) return 0;
  return Math.max(0, Math.min(late.to, sleep.to) - Math.max(late.from, sleep.from));
}

/**
 * Measures event-loop stalls by timer drift: a tick that runs late means the loop was busy, unless
 * the system was asleep for that time. A watchdog reading `status()` can tell a busy daemon (large
 * delays, still answering) from a hung one (no answer at all).
 *
 * A late tick is checked against the most recent sleep, and only the part of that sleep between
 * this tick and the one before is subtracted. Nothing carries from one tick to the next. When in
 * doubt (no sleep record, a failed read, or a later sleep hiding this one) the delay is reported in
 * full: a sleep logged as a stall is noise, a hidden stall is a bug.
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
  let previous = clock.now();
  let delayMs = 0;
  let maxDelayMs = 0;
  let stalls = 0;
  let ticks = 0;
  let latestRecorded = 0;
  let closed = false;
  let reading = false;
  let waiting: LateTick[] = [];
  const reads = new AbortController();
  const stall = rateLimited<{ delayMs: number }>(logWindowMs, onStall);
  const suspend = rateLimited<{ suspendedMs: number }>(suspendLogWindowMs, (record) =>
    onSuspend?.(record),
  );

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

  const classify = (late: LateTick, sleep: LoopSleep | undefined) => {
    const slept = Math.min(late.gapMs, sleptWithin(late, sleep));
    if (slept >= stallMs) suspend(late.to, { suspendedMs: Math.round(slept) });
    record(late.tick, Math.max(0, Math.round(late.gapMs - slept)), late.to);
  };

  // One read at a time. Ticks that turn late during a read share the next one, which starts after
  // them, so it can't miss a sleep that ended before them.
  const readSleep = async () => {
    if (reading || closed || waiting.length === 0) return;
    reading = true;
    const batch = waiting;
    waiting = [];
    let sleep: LoopSleep | undefined;
    try {
      sleep = await clock.lastSleep(reads.signal);
    } catch {
      sleep = undefined;
    }
    reading = false;
    if (closed) return;
    for (const late of batch) classify(late, sleep);
    void readSleep();
  };

  const stop = clock.every(intervalMs, () => {
    const now = clock.now();
    const from = previous;
    previous = now;
    const tick = ++ticks;
    const gapMs = Math.max(0, now - from - intervalMs);
    if (gapMs < stallMs) {
      record(tick, Math.round(gapMs), now);
      return;
    }
    waiting.push({ tick, from, to: now, gapMs });
    void readSleep();
  });
  return {
    status: (): LoopStatus => ({ delayMs, maxDelayMs, stalls }),
    close() {
      closed = true;
      waiting = [];
      reads.abort();
      stop();
    },
  };
}

/**
 * Parses `sysctl -n kern.sleeptime kern.waketime`: the wall-clock times the kernel last went to
 * sleep and last woke (DarkWake included), as `{ sec = …, usec = … }`. `wallMinusLoop` moves them
 * onto the loop clock; both clocks count sleep, so the offset holds across it.
 */
export function parseDarwinLastSleep(output: string, wallMinusLoop: number): LoopSleep | undefined {
  const times = [...output.matchAll(/sec = (\d+), usec = (\d+)/g)].map(
    ([, sec, usec]) => Number(sec) * 1000 + Number(usec) / 1000,
  );
  const [slept, woke] = times;
  if (times.length !== 2 || slept === undefined || woke === undefined) return undefined;
  if (slept <= 0 || woke <= slept) return undefined;
  return { from: slept - wallMinusLoop, to: woke - wallMinusLoop };
}

function darwinLastSleep(signal: AbortSignal): Promise<LoopSleep | undefined> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/sysctl",
      ["-n", "kern.sleeptime", "kern.waketime"],
      { timeout: 5_000, signal },
      (error, stdout) =>
        resolve(error ? undefined : parseDarwinLastSleep(stdout, Date.now() - performance.now())),
    );
  });
}

function every(milliseconds: number, tick: () => void): () => void {
  const timer = setInterval(tick, milliseconds);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The daemon's loop clock is `performance.now()`, libuv's `uv_hrtime`, and timers run on the same
 * clock:
 * - macOS reads `mach_continuous_time`, which counts sleep, so a tick due before sleep fires late
 *   at the next (Dark)Wake. The kernel's last sleep and wake times say how much of that was sleep.
 * - Linux reads `CLOCK_MONOTONIC`, which stops during suspend, so suspend never makes a tick late
 *   and there is nothing to subtract.
 * - Windows reads `QueryPerformanceCounter`, which counts standby and hibernation. Node has no
 *   sleep-excluding clock or sleep record there without native code, so a tick that is late
 *   because of sleep is still reported as a stall.
 */
export function systemLoopClock(platform: NodeJS.Platform): LoopClock {
  return {
    now: () => performance.now(),
    every,
    lastSleep: platform === "darwin" ? darwinLastSleep : async () => undefined,
  };
}
