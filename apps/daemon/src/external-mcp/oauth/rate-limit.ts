/*
 * A fixed-window limit per key, for endpoints anyone can call (ADR 0117): /authorize and
 * /register, keyed by caller address where the daemon sees one, else by base URL. Bounded:
 * at most `keys` keys are tracked, the oldest dropped first.
 */
export class RateLimit {
  private windows = new Map<string, { start: number; count: number }>();
  private options: { limit: number; windowMs: number; now: () => number; keys?: number };
  constructor(options: RateLimit["options"]) {
    this.options = options;
  }
  /** Counts one call; false when `key` is over its limit for this window. */
  allow(key: string): boolean {
    const now = this.options.now();
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.options.windowMs) {
      this.windows.delete(key);
      if (this.windows.size >= (this.options.keys ?? 1024)) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count++;
    return current.count <= this.options.limit;
  }
}
