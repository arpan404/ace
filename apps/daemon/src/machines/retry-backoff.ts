/**
 * Failure episodes for loops that retry: a key that failed waits longer after each failure (from
 * `baseMs`, doubling, up to `capMs`) and counts its attempts, so a caller can log once when an
 * episode starts and once when it ends. Pure: the caller passes the time in.
 */
export class RetryBackoff {
  private baseMs: number;
  private capMs: number;
  private episodes = new Map<string, { attempts: number; dueAt: number }>();
  constructor(baseMs: number, capMs: number) {
    this.baseMs = baseMs;
    this.capMs = capMs;
  }
  /** True when the key has no failure to wait out at `now`. */
  due(key: string, now: number): boolean {
    const episode = this.episodes.get(key);
    return !episode || episode.dueAt <= now;
  }
  /**
   * Records a failed attempt at `now`; returns the attempts so far in this episode (1 starts it).
   * Failures while the key is still waiting (calls that were already on their way) count once.
   */
  failed(key: string, now: number): number {
    const episode = this.episodes.get(key);
    if (episode && episode.dueAt > now) return episode.attempts;
    const attempts = (episode?.attempts ?? 0) + 1;
    const wait = Math.min(this.capMs, this.baseMs * 2 ** Math.min(attempts - 1, 30));
    this.episodes.set(key, { attempts, dueAt: now + wait });
    return attempts;
  }
  /** Ends the key's episode; returns the failed attempts it had (0 when there was none). */
  succeeded(key: string): number {
    const attempts = this.episodes.get(key)?.attempts ?? 0;
    this.episodes.delete(key);
    return attempts;
  }
  /** Something changed that could make the key succeed: it is due now, its count kept. */
  retryNow(key: string): void {
    const episode = this.episodes.get(key);
    if (episode) episode.dueAt = Number.NEGATIVE_INFINITY;
  }
  /** Whether the key is in a failure episode. */
  failing(key: string): boolean {
    return this.episodes.has(key);
  }
  /** The earliest time any episode is due again, or undefined with none open. */
  nextDue(): number | undefined {
    let next: number | undefined;
    for (const { dueAt } of this.episodes.values())
      if (next === undefined || dueAt < next) next = dueAt;
    return next;
  }
}
