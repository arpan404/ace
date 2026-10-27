const hourMs = 60 * 60_000;

/**
 * Token buckets per key: `perHour` requests, refilled continuously. Bounded: past `maxEntries`
 * the least recently used key is evicted (it starts full again, which only loosens a limit).
 * Pure; the caller passes the time.
 */
export class HourlyLimit {
  #entries = new Map<string, { tokens: number; at: number }>();
  #perHour: number;
  #maxEntries: number;
  constructor(perHour: number, maxEntries: number) {
    this.#perHour = perHour;
    this.#maxEntries = maxEntries;
  }
  /** 0 when admitted (and counted); otherwise milliseconds until one more is allowed. */
  take(key: string, now: number): number {
    const entry = this.#entries.get(key);
    let tokens = this.#perHour;
    if (entry) {
      const elapsed = Math.max(0, now - entry.at);
      tokens = Math.min(this.#perHour, entry.tokens + (elapsed * this.#perHour) / hourMs);
      this.#entries.delete(key);
    } else if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    if (tokens < 1) {
      this.#entries.set(key, { tokens, at: now });
      return Math.ceil(((1 - tokens) * hourMs) / this.#perHour);
    }
    this.#entries.set(key, { tokens: tokens - 1, at: now });
    return 0;
  }
}

/** Tokens APNs said are invalid, as hashes, kept 30 days so further pushes skip APNs. */
export class GoneTokens {
  #entries = new Map<string, number>();
  #maxEntries: number;
  #ttlMs: number;
  constructor(maxEntries: number, ttlMs = 30 * 24 * hourMs) {
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
  }
  add(hash: string, now: number): void {
    this.#entries.delete(hash);
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(hash, now);
  }
  has(hash: string, now: number): boolean {
    const at = this.#entries.get(hash);
    if (at === undefined) return false;
    if (now - at > this.#ttlMs) {
      this.#entries.delete(hash);
      return false;
    }
    return true;
  }
}
