import type { DatabaseSync } from "@ace/provider-kit/sqlite";

/** A source that crashed the reader this many times alone is no longer read. */
export const CRASH_LIMIT = 3;
const BASE_MS = 30_000;
const RETRYING =
  "This saved conversation stopped the history reader. It will be read again later; open it in its original app if this keeps happening.";
const FAILED =
  "This saved conversation stopped the history reader several times and is no longer read. Open it in its original app.";

export type LastExit = "crash" | "memory-limit";
export type CrashVerdict =
  | { kind: "read" }
  | { kind: "isolate" }
  | { kind: "blocked"; reason: string };
type Entry = { state: "suspect" | "struck"; strikes: number; retryAt: number };

/**
 * Durable record of the sources being read when the history isolate died.
 *
 * Each content read is marked before it starts and cleared when it ends, whatever the
 * outcome. Marks still present at the next start were in flight during a crash. One left
 * alone is the cause: it waits out a doubling delay and, after {@link CRASH_LIMIT} strikes,
 * is reported failed. Several together are only suspects; each is next read on its own, so
 * a single further crash identifies the cause instead of restarting over the same inventory.
 *
 * A reader the daemon stopped for going over its memory limit (`lastExit: "memory-limit"`) is
 * different: the limit is on the whole process, so the read marked when it was stopped may only
 * have run beside the cause, and the cause may already have finished. Its marks are suspects,
 * never struck. A suspect is then re-checked on its own after a full collection (marked
 * `verifying`); only a source being re-checked alone when the next reader is stopped is struck.
 */
export class CrashLedger {
  private db: DatabaseSync;
  private now: () => number;
  private entries = new Map<string, Entry>();
  constructor(db: DatabaseSync, now: () => number, lastExit?: LastExit) {
    this.db = db;
    this.now = now;
    db.exec(
      "CREATE TABLE IF NOT EXISTS scan_crashes(instance TEXT NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL,strikes INTEGER NOT NULL,retry_at REAL NOT NULL,PRIMARY KEY(instance,path))",
    );
    this.recover(lastExit);
  }
  private recover(lastExit: LastExit | undefined): void {
    const count = (state: string) =>
      Number(
        this.db.prepare("SELECT count(*) AS n FROM scan_crashes WHERE state=?").get(state)?.n ?? 0,
      );
    const reading = count("reading");
    const verifying = count("verifying");
    const strike = (states: string) =>
      this.db
        .prepare(
          `UPDATE scan_crashes SET state='struck',strikes=strikes+1,retry_at=? * (1 << strikes) + ? WHERE state IN (${states})`,
        )
        .run(BASE_MS, this.now());
    const suspect = () =>
      this.db.exec(
        "UPDATE scan_crashes SET state='suspect' WHERE state IN ('reading','verifying')",
      );
    if (lastExit === "memory-limit") {
      if (verifying === 1 && reading === 0) strike("'verifying'");
      else suspect();
    } else if (reading + verifying === 1) strike("'reading','verifying'");
    else if (reading + verifying > 1) suspect();
    for (const row of this.db
      .prepare("SELECT instance,path,state,strikes,retry_at FROM scan_crashes")
      .iterate())
      this.entries.set(key(String(row.instance), String(row.path)), {
        state: row.state === "struck" ? "struck" : "suspect",
        strikes: Number(row.strikes),
        retryAt: Number(row.retry_at),
      });
  }
  verdict(instance: string, path: string): CrashVerdict {
    const entry = this.entries.get(key(instance, path));
    if (!entry) return { kind: "read" };
    if (entry.state === "suspect") return { kind: "isolate" };
    if (entry.strikes >= CRASH_LIMIT) return { kind: "blocked", reason: FAILED };
    if (this.now() < entry.retryAt) return { kind: "blocked", reason: RETRYING };
    return { kind: "isolate" };
  }
  /** Mark before reading content; the mark must be durable before the read can crash. */
  reading(instance: string, path: string): void {
    this.db
      .prepare(
        "INSERT INTO scan_crashes VALUES(?,?,'reading',0,0) ON CONFLICT(instance,path) DO UPDATE SET state='reading'",
      )
      .run(instance, path);
  }
  /** Mark before re-checking a suspect on its own, the read that can strike it. */
  verifying(instance: string, path: string): void {
    this.db
      .prepare(
        "INSERT INTO scan_crashes VALUES(?,?,'verifying',0,0) ON CONFLICT(instance,path) DO UPDATE SET state='verifying'",
      )
      .run(instance, path);
  }
  /** The read ended without killing the isolate, so the source is not a crash cause. */
  finished(instance: string, path: string): void {
    this.db.prepare("DELETE FROM scan_crashes WHERE instance=? AND path=?").run(instance, path);
    this.entries.delete(key(instance, path));
  }
}
function key(instance: string, path: string): string {
  return `${instance}\0${path}`;
}
