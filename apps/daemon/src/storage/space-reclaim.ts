import type { StorageService } from "./service.ts";
import type { StorageSchedule } from "./schedule.ts";
import type { StorageOwner } from "./types.ts";
import {
  firstReclaimDue,
  nextReclaimDue,
  spaceReclaimTiming,
  writesBusy,
  type SpaceReclaimOutcome,
  type SpaceReclaimTiming,
} from "./space-reclaim-policy.ts";

/**
 * Always-on space reclaim: returns SQLite free pages to the OS in bounded compaction runs.
 * It never deletes rows, so it needs no setting. The due time is durable; each run is
 * preceded by a short probe that skips it while the daemon is writing heavily.
 */
export class SpaceReclaim {
  private owner: StorageOwner;
  private service: StorageService;
  private schedule: StorageSchedule;
  private timing: SpaceReclaimTiming;
  private failed: (error: unknown) => void;
  private due = 0;
  private cancel: (() => void) | undefined;
  private flight: Promise<void> | undefined;
  private closed = false;
  constructor(
    owner: StorageOwner,
    service: StorageService,
    schedule: StorageSchedule,
    timing: SpaceReclaimTiming = spaceReclaimTiming,
    failed: (error: unknown) => void = () => {},
  ) {
    this.owner = owner;
    this.service = service;
    this.schedule = schedule;
    this.timing = timing;
    this.failed = failed;
  }
  async start(): Promise<void> {
    const store = this.owner.store;
    const stored = await store.write((db) => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS storage_reclaim_schedule(id INTEGER PRIMARY KEY CHECK(id=1),due INTEGER NOT NULL)",
      );
      const row = db.prepare("SELECT due FROM storage_reclaim_schedule WHERE id=1").get();
      return row ? Number(row.due) : undefined;
    });
    const unfinished = this.service.compactionUnfinished();
    await this.save(firstReclaimDue(stored, this.owner.now(), unfinished, this.timing));
    this.arm();
  }
  private async save(due: number): Promise<void> {
    this.due = due;
    await this.owner.store.write((db) =>
      db.prepare("INSERT OR REPLACE INTO storage_reclaim_schedule VALUES (1,?)").run(due),
    );
  }
  private arm(): void {
    if (this.closed) return;
    const delay = Math.max(1, Math.min(this.timing.recheckMs, this.due - this.owner.now()));
    this.cancel = this.schedule(delay, () => {
      this.cancel = undefined;
      if (this.due > this.owner.now()) this.arm();
      else this.probe();
    });
  }
  private commits(): number {
    return this.owner.store.streamingMetrics().transactions;
  }
  /** Count commits over the probe window, then run unless they show heavy write load. */
  private probe(): void {
    if (this.closed) return;
    const before = this.commits();
    this.cancel = this.schedule(this.timing.probeMs, () => {
      this.cancel = undefined;
      this.flight = this.pass(this.commits() - before).finally(() => {
        this.flight = undefined;
      });
    });
  }
  private async pass(transactions: number): Promise<void> {
    if (this.closed) return;
    let outcome: SpaceReclaimOutcome;
    try {
      outcome =
        writesBusy(transactions, this.timing) || this.owner.store.isHistoryWriting()
          ? "busy"
          : await this.service.reclaimSpace(this.timing.chunksPerRun, () => !this.closed);
    } catch (error) {
      // Other maintenance holding the fence, or a full storage queue, is a busy moment.
      const message = error instanceof Error ? error.message : "";
      if (message === "Store is busy" || message === "storage_busy") outcome = "busy";
      else {
        this.failed(error);
        outcome = "failed";
      }
    }
    // A run cut short by shutdown leaves its journal running; the next start resumes it.
    if (this.closed) return;
    try {
      await this.save(nextReclaimDue(outcome, this.owner.now(), this.timing));
    } catch (error) {
      this.failed(error);
    }
    this.arm();
  }
  /** Stops after the current chunk at most; compaction checks `closed` between chunks. */
  async close(): Promise<void> {
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
    await this.flight;
  }
}
