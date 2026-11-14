import type { AccountQuota } from "@ace/protocol/accounts";

/**
 * When the daemon re-reads every account's limits. A reading launches each account's CLI, so it
 * runs on each tick only while limits matter now: a thread waits on an account's limit (a fresh
 * reading is what lets it carry on), an agent is working, or a client has read account data
 * since it connected. Otherwise a tick reads only once a stored window's reset has passed, so the
 * next reading shows the reset. A reader arriving to stale readings gets a fresh one at once.
 */
export class LimitsSchedule {
  private readonly options: LimitsScheduleOptions;
  private readonly readers = new Set<string>();
  private reading: Promise<void> | undefined;
  /** When the last reading started; undefined before the first. */
  private lastAt: number | undefined;
  private stopped = false;
  constructor(options: LimitsScheduleOptions) {
    this.options = options;
  }
  /** Read now, joining a reading already under way. */
  refresh(): Promise<void> {
    if (this.reading) return this.reading;
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
  /** No more readings start; resolves once the one under way, if any, ends. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.reading;
  }
  /** Session `id` read account data: limits stay fresh until it disconnects. */
  reader(id: string): void {
    if (this.stopped) return;
    const first = !this.readers.has(id);
    this.readers.add(id);
    if (first && this.stale()) void this.refresh();
  }
  readerGone(id: string): void {
    this.readers.delete(id);
  }
  /** The periodic check: reads when limits matter now or a known reset has passed. */
  tick(): void {
    if (this.stopped) return;
    if (this.readers.size || this.options.busy() || this.resetPassed()) void this.refresh();
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
