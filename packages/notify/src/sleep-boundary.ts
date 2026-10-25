import type { StatementSync } from "node:sqlite";
import { z } from "zod";

/** Additive and idempotent, like the inbox: an existing format-4 database gains it on open. */
export const sleepTables = `
  CREATE TABLE IF NOT EXISTS sleep_windows (id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER NOT NULL, at INTEGER NOT NULL, through INTEGER, before INTEGER);`;

const Row = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number().int(),
  through: z.number().int().nonnegative().nullable(),
  before: z.number().int().nullable(),
});
/**
 * One deliberate stop. Events after `seq` happened while no device could take an alert. A
 * worker that wakes closes the window at the cursor its replay reached (`through`) and the
 * time before which missed alerts are skipped (`before`). An open window ends at the log
 * head. A crash writes nothing, so whatever it interrupted is delivered normally.
 */
export type SleepWindow = z.infer<typeof Row>;
export interface Boundary {
  seq: number;
  at: number;
}
/** Agent notices queued inside a window: after its start and before its cutoff. */
export interface NoticeWindow {
  after: number;
  before: number;
}

/** Whether an alert raised by event `seq` at `at` falls in a sleep and is too old to send. */
export function slept(
  windows: readonly SleepWindow[],
  seq: number,
  at: number,
  alertsFrom: number,
): boolean {
  return windows.some((window) =>
    window.through === null
      ? seq > window.seq && at < alertsFrom
      : seq > window.seq && seq <= window.through && at < (window.before ?? alertsFrom),
  );
}

/** Sleep windows, kept until the agent notices they cover have been acknowledged. */
export class SleepWindows {
  private statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  /** Opens a window, or keeps the earlier start of the one already open: the sleep began there. */
  mark(boundary: Boundary): void {
    const open = this.statement("SELECT id FROM sleep_windows WHERE through IS NULL LIMIT 1").get();
    if (open)
      this.statement("UPDATE sleep_windows SET seq=min(seq,?),at=min(at,?) WHERE id=?").run(
        boundary.seq,
        boundary.at,
        Number(open.id),
      );
    else
      this.statement("INSERT INTO sleep_windows(seq,at) VALUES(?,?)").run(
        boundary.seq,
        boundary.at,
      );
  }
  list(): SleepWindow[] {
    return this.statement("SELECT seq,at,through,before FROM sleep_windows ORDER BY id")
      .all()
      .map((row) => Row.parse(row));
  }
  /**
   * The woken worker's replay reached `through`: later events are live. Returns every window's
   * notice span, still owed cleanup until `forget`.
   */
  close(through: number, before: number): NoticeWindow[] {
    this.statement("UPDATE sleep_windows SET through=?,before=? WHERE through IS NULL").run(
      through,
      before,
    );
    return this.list().map((window) => ({ after: window.at, before: window.before ?? before }));
  }
  /** The notices in the closed windows are acknowledged: nothing needs them any more. */
  forget(): void {
    this.statement("DELETE FROM sleep_windows WHERE through IS NOT NULL").run();
  }
}
