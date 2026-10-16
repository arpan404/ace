import { statSync } from "node:fs";
import type { BufferScheduler } from "./live-write-buffer.ts";

/** The connection owns checkpoints; no timer survives its Store. */
export class WalMaintenance {
  private cancel: (() => void) | undefined;
  constructor(privateOptions: {
    path: string;
    scheduler: BufferScheduler;
    busy(): boolean;
    exec(sql: string): void;
    report(error: unknown): void;
  }) {
    this.options = privateOptions;
  }
  private readonly options;
  bytes(): number {
    try {
      return statSync(`${this.options.path}-wal`).size;
    } catch {
      return 0;
    }
  }
  wake(): void {
    if (this.cancel) return;
    this.cancel = this.options.scheduler.delay(() => {
      this.cancel = undefined;
      if (this.options.busy()) {
        this.wake();
        return;
      }
      try {
        this.options.exec("PRAGMA busy_timeout=0; PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        this.options.report(error);
      } finally {
        this.options.exec("PRAGMA busy_timeout=5000");
      }
    }, 5000);
  }
  close(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}
