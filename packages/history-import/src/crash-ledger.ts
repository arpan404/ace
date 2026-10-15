import type { DatabaseSync } from "@ace/provider-kit/sqlite";

/** A source that crashed the reader this many times alone is no longer read. */
export const CRASH_LIMIT = 3;
const BASE_MS = 30_000;
const RETRYING =
  "This saved conversation stopped the history reader. It will be read again later; open it in its original app if this keeps happening.";
const FAILED =
  "This saved conversation stopped the history reader several times and is no longer read. Open it in its original app.";

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
 */
export class CrashLedger {
  private db: DatabaseSync;
  private now: () => number;
  private entries = new Map<string, Entry>();
  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
    db.exec(
      "CREATE TABLE IF NOT EXISTS scan_crashes(instance TEXT NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL,strikes INTEGER NOT NULL,retry_at REAL NOT NULL,PRIMARY KEY(instance,path))",
    );
    this.recover();
  }
  private recover(): void {
    const reading = Number(
      this.db.prepare("SELECT count(*) AS n FROM scan_crashes WHERE state='reading'").get()?.n ?? 0,
    );
    if (reading === 1)
      this.db
        .prepare(
          "UPDATE scan_crashes SET state='struck',strikes=strikes+1,retry_at=? * (1 << strikes) + ? WHERE state='reading'",
        )
        .run(BASE_MS, this.now());
    else if (reading > 1)
      this.db.exec("UPDATE scan_crashes SET state='suspect' WHERE state='reading'");
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
  /** The read ended without killing the isolate, so the source is not a crash cause. */
  finished(instance: string, path: string): void {
    this.db.prepare("DELETE FROM scan_crashes WHERE instance=? AND path=?").run(instance, path);
    this.entries.delete(key(instance, path));
  }
}
function key(instance: string, path: string): string {
  return `${instance}\0${path}`;
}
