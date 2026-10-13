import type { StorageService } from "./service.ts";
import type { StorageSchedule } from "./schedule.ts";
import type { StorageOwner } from "./types.ts";
import {
  RETENTION_REVIEWER,
  delayAfterChange,
  delayAfterPass,
  retentionTiming,
  type RetentionTiming,
} from "./data-retention-policy.ts";

/**
 * Runs automatic data retention at startup, periodically, and soon after the window shrinks.
 * Each pass is one bounded plan; leftover work reschedules a short retry instead of
 * looping, so retention never holds the storage serializer for long.
 */
export class DataRetention {
  private owner: StorageOwner;
  private service: StorageService;
  private schedule: StorageSchedule;
  private timing: RetentionTiming;
  private days: number | undefined;
  private cancel: (() => void) | undefined;
  private release: (() => void) | undefined;
  private flight: Promise<void> | undefined;
  private rerun = false;
  private closed = false;
  constructor(
    owner: StorageOwner,
    service: StorageService,
    schedule: StorageSchedule,
    timing: RetentionTiming = retentionTiming,
  ) {
    this.owner = owner;
    this.service = service;
    this.schedule = schedule;
    this.timing = timing;
  }
  async start(): Promise<void> {
    const settings = this.owner.services.settings;
    if (!settings) return;
    this.release = await settings.subscribe(
      { keys: ["storage.retentionDays"], scope: {} },
      (event) => {
        if (event.type !== "changed") return;
        const entry = event.entries.find((candidate) => candidate.key === "storage.retentionDays");
        if (typeof entry?.value === "number") this.set(entry.value);
      },
    );
    if (this.days === undefined) this.set((await settings.get("storage.retentionDays")).value);
  }
  /** The window currently enforced, after environment overrides. */
  window(): number | undefined {
    return this.days;
  }
  private set(days: number): void {
    const delay = delayAfterChange(this.days, days, this.timing);
    this.days = days;
    if (delay !== undefined) this.arm(delay);
  }
  private arm(delay: number): void {
    if (this.closed) return;
    if (this.flight) {
      // A pass is running with the previous window; run again with the new one afterwards.
      this.rerun = true;
      return;
    }
    this.cancel?.();
    this.cancel = this.schedule(delay, () => {
      this.cancel = undefined;
      this.flight = this.pass().finally(() => {
        this.flight = undefined;
      });
    });
  }
  private async pass(): Promise<void> {
    const days = this.days;
    if (days === undefined || this.closed) return;
    const allowed = () => !this.closed;
    let next: number;
    try {
      const result = await this.service.retain(days, allowed);
      if (result.removed > 0 && allowed()) await this.service.compact(RETENTION_REVIEWER, allowed);
      next = delayAfterPass(result, this.timing);
    } catch {
      next = delayAfterPass("failed", this.timing);
    }
    if (this.closed) return;
    if (this.rerun || this.days !== days) next = Math.min(next, this.timing.changeMs);
    this.rerun = false;
    this.cancel = this.schedule(next, () => {
      this.cancel = undefined;
      this.flight = this.pass().finally(() => {
        this.flight = undefined;
      });
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancel?.();
    this.release?.();
    await this.flight;
  }
}
