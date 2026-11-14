import type { AccountQuota } from "@ace/protocol/accounts";

/**
 * When the daemon re-reads every account's limits. A reading launches each account's CLI, so it
 * runs on each tick only while limits matter now: a thread waits on an account's limit (a fresh
 * reading is what lets it carry on), an agent is working, or a client has read account data
 * since it connected. Otherwise a tick reads only once a stored window's reset has passed, so the
 * next reading shows the reset. Whoever is about to act on readings (a client's first account
 * read, a turn choosing its account) asks for `fresh` ones and waits a few seconds at most.
 */
export class LimitsSchedule {
  private readonly options: LimitsScheduleOptions;
  private readonly readers = new Set<string>();
  private reading: Promise<void> | undefined;
  private queued: Promise<void> | undefined;
  /** When the last reading started; undefined before the first. */
  private lastAt: number | undefined;
  private stopped = false;
  constructor(options: LimitsScheduleOptions) {
    this.options = options;
  }
  /** Read now, joining a reading already under way. */
  refresh(): Promise<void> {
    if (this.reading) return this.reading;
    if (this.stopped) return Promise.resolve();
    this.lastAt = this.options.now();
    const reading = this.options
      .read()
      .catch(() => {})
      .finally(() => {
        if (this.reading === reading) this.reading = undefined;
      });
    this.reading = reading;
    return reading;
  }
  /**
   * A reading of facts from after this call: the one under way may have started before what the
   * asker wants seen (a sign-in, a credential written), so it is followed by one more. Calls made
   * meanwhile share that one.
   */
  refreshAfter(): Promise<void> {
    if (!this.reading) return this.refresh();
    this.queued ??= this.reading.then(() => {
      this.queued = undefined;
      return this.refresh();
    });
    return this.queued;
  }
  /** No more readings start; resolves once the one under way, if any, ends. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.queued;
    await this.reading;
  }
  /**
   * Readings no older than the interval: one is started when they are older, or the one under way
   * is joined. Resolves when it ends, after `waitMs` on the injected timer, or when `signal`
   * aborts, whichever is first; a slow CLI goes on reading in the background.
   */
  fresh(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const reading = this.reading ?? (this.stale() ? this.refresh() : undefined);
    if (!reading) return Promise.resolve();
    return new Promise((resolve) => {
      let cancel: (() => void) | undefined;
      const done = () => {
        cancel?.();
        signal?.removeEventListener("abort", done);
        resolve();
      };
      cancel = this.options.after(waitMs, done);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
      void reading.then(done);
    });
  }
  /**
   * Session `id` read account data: limits stay fresh until it disconnects. Its first read gets
   * `fresh` readings, waiting at most `waitMs`.
   */
  reader(id: string, waitMs: number): Promise<void> {
    if (this.stopped || this.readers.has(id)) return Promise.resolve();
    this.readers.add(id);
    return this.fresh(waitMs);
  }
  readerGone(id: string): void {
    this.readers.delete(id);
  }
  /**
   * The periodic check: reads when limits matter now or a known reset has passed. Resolves when
   * the reading it started (or joined) ends, at once when it reads nothing.
   */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.readers.size || this.options.busy() || this.resetPassed()) return this.refresh();
    return Promise.resolve();
  }
  private stale(): boolean {
    return this.lastAt === undefined || this.options.now() - this.lastAt >= this.options.intervalMs;
  }
  private resetPassed(): boolean {
    const since = this.lastAt;
    if (since === undefined) return true;
    return resetBetween(this.options.quotas(), since, this.options.now());
  }
}

export interface LimitsScheduleOptions {
  /** How often a tick runs; a reading older than this is stale. */
  intervalMs: number;
  now(): number;
  /** Reads every account's limits. */
  read(): Promise<void>;
  /** Whether a thread waits on a limit or an agent works now. */
  busy(): boolean;
  /** Every account's stored quota. */
  quotas(): Iterable<AccountQuota>;
  /** Runs `run` after `ms`; returns a cancel. */
  after(ms: number, run: () => void): () => void;
}

/** Whether any stored window or limit error reset after `since`, up to `now`. */
export function resetBetween(quotas: Iterable<AccountQuota>, since: number, now: number): boolean {
  for (const quota of quotas) {
    const windows = Object.values(quota.windows);
    if (quota.blockers.limitError) windows.push(quota.blockers.limitError);
    for (const { resetsAt } of windows)
      if (resetsAt !== null && resetsAt > since && resetsAt <= now) return true;
  }
  return false;
}
