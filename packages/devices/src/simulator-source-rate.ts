/**
 * serve-sim's H.264 rate as it actually arrives. serve-sim picks its own rate from the screen's
 * size (6 to 30 Mbit/s by its documentation) and spends it only while the screen changes, so the
 * rate that matters for a viewer's link is the busiest recent second, not the average. Pure: the
 * clock is passed in.
 */
export class SimulatorSourceRate {
  /** Bytes per whole second, newest last, covering at most the window. */
  #seconds: { start: number; bytes: number }[] = [];
  readonly #windowMs: number;
  constructor(windowMs = 10_000) {
    this.#windowMs = windowMs;
  }
  /** One access unit arrived. True when it opened a new second: time to look at the rate again. */
  record(now: number, bytes: number): boolean {
    const start = Math.floor(now / 1000) * 1000;
    const current = this.#seconds.at(-1);
    if (current && current.start === start) {
      current.bytes += bytes;
      return false;
    }
    this.#seconds.push({ start, bytes });
    while ((this.#seconds[0]?.start ?? start) <= start - this.#windowMs) this.#seconds.shift();
    return current !== undefined;
  }
  /** The busiest second in the window, in bit/s; 0 before anything arrived. */
  peak(now: number): number {
    let peak = 0;
    for (const second of this.#seconds)
      if (second.start > now - this.#windowMs) peak = Math.max(peak, second.bytes * 8);
    return peak;
  }
}
