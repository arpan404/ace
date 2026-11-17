import { logError, logFields } from "@ace/diagnostics";
import type { MaintenanceHold } from "@ace/protocol";
import { freeBytesOf, isDiskFull, type DiskSpace } from "./sqlite-failure.ts";
import {
  nextStorageState,
  roomyStorage,
  storageLevels,
  type StorageFact,
  type StorageLevels,
  type StorageState,
} from "./storage-levels.ts";

/** The admission gate, as far as the watch needs it: only its own `storage` hold. */
export interface StorageHold {
  enter(hold: MaintenanceHold): unknown;
  leave(hold: MaintenanceHold): unknown;
}

/** Runs `run` once after `ms`; returns the cancel. Tests drive it by hand. */
export type StorageDelay = (run: () => void, ms: number) => () => void;

interface WatchLog {
  log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
}

export interface StorageWatchOptions {
  /** ACE_HOME: the volume whose free space decides. */
  home: string;
  diskSpace: DiskSpace;
  delay: StorageDelay;
  log: WatchLog;
  levels?: StorageLevels;
  /** Between reads while space is fine, and while new work is held (shorter, to heal soon). */
  intervals?: { roomyMs: number; fullMs: number };
}

export const storageIntervals = { roomyMs: 60_000, fullMs: 5_000 } as const;

/** Unref'd: the watch never keeps the process alive on its own. */
export const systemStorageDelay: StorageDelay = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * The daemon's "storage full" condition (ADR 0174). The first write that fails for want of
 * space, or free space under `pauseBelow`, holds admission with `storage`: new threads, turns
 * and messages wait, and every client says why. Running turns keep going; their live output
 * waits in memory and is retried, never dropped (`store-stream.ts`). Free space is read on a
 * timer, and once it is back above `resumeAt` the hold is released and every `onRoom` listener
 * retries what it had to put off. Nothing here needs the person to press anything.
 */
export class StorageWatch {
  private state: StorageState = roomyStorage;
  private readonly options: StorageWatchOptions;
  private readonly levels: StorageLevels;
  private readonly intervals: { roomyMs: number; fullMs: number };
  private readonly holds = new Set<StorageHold>();
  private readonly room = new Set<() => void>();
  private cancel: (() => void) | undefined;
  private closed = false;
  constructor(options: StorageWatchOptions) {
    this.options = options;
    this.levels = options.levels ?? storageLevels;
    this.intervals = options.intervals ?? storageIntervals;
  }
  /** Read free space now and keep reading it on the timer. */
  start(): void {
    this.check();
  }
  /** The gate to hold while storage is full; held at once if it already is. */
  attach(hold: StorageHold): () => void {
    this.holds.add(hold);
    if (this.state.full) hold.enter("storage");
    return () => this.holds.delete(hold);
  }
  /** Called each time space comes back, after the hold is released. */
  onRoom(listener: () => void): () => void {
    this.room.add(listener);
    return () => this.room.delete(listener);
  }
  isFull(): boolean {
    return this.state.full;
  }
  /**
   * Hear a failure from anywhere in the daemon. True when it was the disk being full: the
   * condition is entered (once) and the caller may treat the failure as one that heals.
   */
  observe(error: unknown): boolean {
    if (!isDiskFull(error)) return false;
    if (!this.state.full)
      this.options.log.log(
        "error",
        "Disk is full; new work waits until space is freed",
        logFields([
          ["error", logError(error)],
          ["freeBytes", freeBytesOf(this.options.home, this.options.diskSpace)],
          ["dataDir", this.options.home],
        ]),
      );
    this.apply({ kind: "write-failed" });
    return true;
  }
  /** Read free space once and act on it; schedules the next read. */
  check(): void {
    if (this.closed) return;
    this.cancel?.();
    const bytes = freeBytesOf(this.options.home, this.options.diskSpace);
    const before = this.state;
    this.apply({ kind: "free", bytes });
    if (this.state.full && !before.full)
      this.options.log.log(
        "error",
        "Disk is nearly full; new work waits until space is freed",
        logFields([["freeBytes", bytes]]),
      );
    else if (this.state.low && !before.low && !this.state.full)
      this.options.log.log("warn", "Disk space is low", logFields([["freeBytes", bytes]]));
    this.schedule();
  }
  close(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
  }
  private schedule(): void {
    if (this.closed) return;
    const ms = this.state.full ? this.intervals.fullMs : this.intervals.roomyMs;
    this.cancel = this.options.delay(() => this.check(), ms);
  }
  private apply(fact: StorageFact): void {
    const before = this.state;
    this.state = nextStorageState(before, fact, this.levels);
    if (this.state.full === before.full) return;
    if (this.state.full) {
      for (const hold of this.holds) hold.enter("storage");
      // Read again soon rather than on the roomy interval.
      this.cancel?.();
      this.schedule();
      return;
    }
    this.options.log.log(
      "info",
      "Disk space is back; new work resumes",
      logFields([["freeBytes", fact.kind === "free" ? fact.bytes : null]]),
    );
    for (const hold of this.holds) hold.leave("storage");
    for (const listener of this.room) {
      try {
        listener();
      } catch (error) {
        this.options.log.log("warn", "Retry after disk space came back failed", logError(error));
      }
    }
  }
}
