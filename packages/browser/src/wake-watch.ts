/** Wall and monotonic readings taken together. */
export interface ClockReading {
  wall: number;
  monotonic: number;
}

/**
 * Whether the computer slept between two readings. Pure. The monotonic clock stops while the
 * machine sleeps and the wall clock does not, so wall time running ahead of monotonic time by
 * more than `toleranceMs` means a sleep (or a large clock change, which warrants the same check).
 */
export function slept(before: ClockReading, after: ClockReading, toleranceMs: number): boolean {
  return after.wall - before.wall - (after.monotonic - before.monotonic) > toleranceMs;
}

export interface WakeWatch {
  /** How often to compare the clocks. */
  every: number;
  /** How far wall time may run ahead of monotonic time before it counts as a sleep. */
  toleranceMs: number;
  /** Runs `work` once after `delay`; returns a cancel. */
  set(delay: number, work: () => void): () => void;
}

/**
 * Calls `woke` after each sleep the clocks reveal (#947): the daemon notices a wake on its own,
 * even with no desktop to tell it. Returns a stop.
 */
export function watchWake(
  clocks: { wall(): number; monotonic(): number },
  watch: WakeWatch,
  woke: () => void,
): () => void {
  const read = (): ClockReading => ({ wall: clocks.wall(), monotonic: clocks.monotonic() });
  let last = read();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = read();
    const asleep = slept(last, now, watch.toleranceMs);
    last = now;
    cancel = watch.set(watch.every, tick);
    if (asleep) woke();
  };
  let cancel = watch.set(watch.every, tick);
  return () => {
    stopped = true;
    cancel();
  };
}
